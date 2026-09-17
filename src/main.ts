import * as utils from '@iobroker/adapter-core';
import { GroupObjectManager } from './lib/group-object-manager';
import { HueEventStream } from './lib/hue-event-stream';
import { HueV2Client, type HueResource } from './lib/hue-v2-client';
import { ObjectManager } from './lib/object-manager';
import { ResourceManager } from './lib/resource-manager';

interface Hue2Config extends ioBroker.AdapterConfig { bridge: string; applicationKey: string; }

class Hue2 extends utils.Adapter {
    private client?: HueV2Client;
    private eventStream?: HueEventStream;
    private resources?: ResourceManager;
    private readonly objectManager: ObjectManager;
    private readonly groupObjectManager: GroupObjectManager;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'hue2' });
        this.objectManager = new ObjectManager(this);
        this.groupObjectManager = new GroupObjectManager(this);
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.ensureInfoObjects();
        const config = this.config as Hue2Config;
        if (!config.bridge || !config.applicationKey) {
            this.log.warn('Hue Bridge address or application key is missing');
            await this.setState('info.connection', false, true);
            return;
        }
        this.client = new HueV2Client({ address: config.bridge, applicationKey: config.applicationKey });
        try {
            const resources = await this.client.getResources();
            this.resources = new ResourceManager(resources);
            await this.objectManager.syncDevices(this.resources);
            await this.groupObjectManager.sync(this.resources);
            this.subscribeStates('devices.*');
            this.subscribeStates('rooms.*');
            this.subscribeStates('zones.*');
            await this.setState('info.connection', true, true);
            this.log.info(`Connected to Hue Bridge. Indexed ${this.resources.size} API v2 resources.`);
            this.logResourceSummary();
            this.startEventStream(config);
        } catch (error) {
            await this.setState('info.connection', false, true);
            const message = error instanceof Error ? error.message : String(error);
            this.log.error(`Could not connect to Hue Bridge: ${message}`);
        }
    }

    private async ensureInfoObjects(): Promise<void> {
        await this.extendObjectAsync('info', {
            type: 'channel',
            common: { name: 'Information' },
            native: {},
        });
        await this.extendObjectAsync('info.connection', {
            type: 'state',
            common: {
                name: 'Connected to Hue Bridge',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
    }

    private startEventStream(config: Hue2Config): void {
        this.eventStream?.stop();
        this.eventStream = new HueEventStream({ address: config.bridge, applicationKey: config.applicationKey });
        this.eventStream.start({
            onConnected: () => this.log.info('Hue API v2 event stream connected'),
            onDisconnected: () => this.log.debug('Hue API v2 event stream disconnected; reconnect scheduled'),
            onError: error => this.log.warn(`Hue event stream: ${error.message}`),
            onUpdate: update => this.handleResourceUpdate(update),
        });
    }

    private async handleResourceUpdate(update: HueResource): Promise<void> {
        if (!this.resources) return;
        const merged = this.resources.patch(update);
        await this.objectManager.updateResource(this.resources, merged);
        await this.groupObjectManager.updateResource(this.resources, merged);
        this.log.debug(`Hue event update ${merged.type}: ${merged.id}`);
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack || !this.client) return;
        const instancePrefix = `${this.namespace}.`;
        if (!id.startsWith(instancePrefix)) return;
        const relativeId = id.slice(instancePrefix.length);
        if (!['devices.', 'rooms.', 'zones.'].some(prefix => relativeId.startsWith(prefix))) return;
        const property = id.slice(id.lastIndexOf('.') + 1);
        const object = await this.getObjectAsync(relativeId);
        if (!object || object.type !== 'state') return;
        const native = object.native as Record<string, unknown>;
        try {
            switch (property) {
                case 'enabled': await this.writeEnabled(native, state.val); break;
                case 'on': await this.writeSingleResource(native, { on: { on: this.requireBoolean(state.val, 'on') } }); break;
                case 'dimming': {
                    const brightness = this.requireNumber(state.val, 'dimming');
                    if (brightness < 0 || brightness > 100) throw new Error('dimming must be between 0 and 100');
                    await this.writeSingleResource(native, { dimming: { brightness } }); break;
                }
                case 'color_temperature': await this.writeSingleResource(native, { color_temperature: { mirek: this.requireNumber(state.val, 'color_temperature') } }); break;
                case 'color': await this.writeColor(native, state.val); break;
                case 'command': await this.writeCommand(native, state.val); break;
                case 'recall':
                    await this.recallScene(native, state.val);
                    await this.setStateAsync(relativeId, false, true);
                    this.log.debug(`Recalled Hue scene ${relativeId}`);
                    return;
                default: this.log.warn(`Ignoring write to unsupported Hue state ${id}`); return;
            }
            await this.setStateAsync(relativeId, state.val, true);
            this.log.debug(`Wrote ${relativeId}=${String(state.val)} to Hue Bridge`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log.warn(`Could not write ${relativeId} to Hue Bridge: ${message}`);
        }
    }

    private async writeCommand(native: Record<string, unknown>, value: ioBroker.StateValue): Promise<void> {
        if (typeof value !== 'string') throw new Error('command must be a JSON string');
        let parsed: unknown;
        try { parsed = JSON.parse(value); } catch { throw new Error('command must be valid JSON'); }
        const payload = this.asRecord(parsed);
        if (!payload) throw new Error('command must contain a JSON object');
        await this.writeSingleResource(native, payload);
    }

    private async recallScene(native: Record<string, unknown>, value: ioBroker.StateValue): Promise<void> {
        const recall = this.requireBoolean(value, 'recall');
        if (!recall) return;
        await this.writeSingleResource(native, { recall: { action: 'active' } });
    }

    private async writeEnabled(native: Record<string, unknown>, value: ioBroker.StateValue): Promise<void> {
        const enabled = this.requireBoolean(value, 'enabled');
        const ids = this.asStringArray(native.hueResourceIds);
        const types = this.asStringArray(native.hueResourceTypes);
        if (ids.length === 0 || ids.length !== types.length) throw new Error('enabled state has no valid Hue resource mapping');
        for (let i = 0; i < ids.length; i++) await this.client!.updateResource(types[i], ids[i], { enabled });
    }

    private async writeSingleResource(native: Record<string, unknown>, payload: Record<string, unknown>): Promise<void> {
        const id = typeof native.hueResourceId === 'string' ? native.hueResourceId : undefined;
        const type = typeof native.hueResourceType === 'string' ? native.hueResourceType : undefined;
        if (!id || !type) throw new Error('state has no Hue resource mapping');
        await this.client!.updateResource(type, id, payload);
    }

    private async writeColor(native: Record<string, unknown>, value: ioBroker.StateValue): Promise<void> {
        if (typeof value !== 'string') throw new Error('color must be a JSON string with x and y');
        let parsed: unknown;
        try { parsed = JSON.parse(value); } catch { throw new Error('color must be valid JSON'); }
        const xy = this.asRecord(parsed);
        if (typeof xy?.x !== 'number' || typeof xy?.y !== 'number') throw new Error('color must contain numeric x and y values');
        if (xy.x < 0 || xy.x > 1 || xy.y < 0 || xy.y > 1) throw new Error('color x and y must be between 0 and 1');
        await this.writeSingleResource(native, { color: { xy: { x: xy.x, y: xy.y } } });
    }

    private requireBoolean(value: ioBroker.StateValue, property: string): boolean { if (typeof value !== 'boolean') throw new Error(`${property} must be boolean`); return value; }
    private requireNumber(value: ioBroker.StateValue, property: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${property} must be a finite number`); return value; }
    private asStringArray(value: unknown): string[] { return Array.isArray(value) && value.every(entry => typeof entry === 'string') ? value : []; }

    private logResourceSummary(): void {
        if (!this.resources) return;
        const counts = this.resources.getTypeCounts();
        const importantTypes = ['device', 'light', 'grouped_light', 'motion', 'light_level', 'temperature', 'device_power', 'room', 'zone', 'scene', 'entertainment', 'entertainment_configuration'];
        const summary = importantTypes.filter(type => counts.has(type)).map(type => `${type}=${counts.get(type)}`).join(', ');
        this.log.info(`Hue resource summary: ${summary}`);
    }

    private asRecord(value: unknown): Record<string, unknown> | undefined { if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined; return value as Record<string, unknown>; }
    private onUnload(callback: () => void): void { this.eventStream?.stop(); callback(); }
}

if (require.main !== module) module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Hue2(options);
else new Hue2();
