import * as utils from '@iobroker/adapter-core';
import { EntertainmentObjectManager } from './lib/entertainment-object-manager';
import { GroupObjectManager } from './lib/group-object-manager';
import { HueEventStream } from './lib/hue-event-stream';
import { HueV2Client, type HueResource } from './lib/hue-v2-client';
import { ObjectManager } from './lib/object-manager';
import { ResourceManager } from './lib/resource-manager';
import { TransitionTracker } from './lib/transition-tracker';

interface Hue2Config extends ioBroker.AdapterConfig { bridge: string; applicationKey: string; dimmingControlsPower?: boolean; }

class Hue2 extends utils.Adapter {
    private client?: HueV2Client;
    private eventStream?: HueEventStream;
    private resources?: ResourceManager;
    private readonly objectManager: ObjectManager;
    private readonly groupObjectManager: GroupObjectManager;
    private readonly entertainmentObjectManager: EntertainmentObjectManager;
    private readonly transitionTracker: TransitionTracker;
    private eventStreamHasConnected = false;
    private reconnectSync?: Promise<void>;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'hue2' });
        this.objectManager = new ObjectManager(this);
        this.groupObjectManager = new GroupObjectManager(this);
        this.entertainmentObjectManager = new EntertainmentObjectManager(this);
        this.transitionTracker = new TransitionTracker((stateId, value) => this.setStateAsync(stateId, value, true));
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
            await this.entertainmentObjectManager.sync(this.resources);
            this.subscribeStates('devices.*');
            this.subscribeStates('rooms.*');
            this.subscribeStates('zones.*');
            this.subscribeStates('entertainment.*');
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
            onConnected: () => {
                const wasConnectedBefore = this.eventStreamHasConnected;
                this.eventStreamHasConnected = true;
                this.reconnectSync = this.handleEventStreamConnected(wasConnectedBefore)
                    .finally(() => { this.reconnectSync = undefined; });
            },
            onDisconnected: () => {
                void this.setStateAsync('info.connection', false, true);
                this.log.debug('Hue API v2 event stream disconnected; reconnect scheduled');
            },
            onError: error => this.log.warn(`Hue event stream: ${error.message}`),
            onUpdate: update => this.handleResourceUpdate(update),
        });
    }

    private async handleEventStreamConnected(reconnected: boolean): Promise<void> {
        if (!reconnected) {
            await this.setStateAsync('info.connection', true, true);
            this.log.info('Hue API v2 event stream connected');
            return;
        }

        this.log.info('Hue API v2 event stream reconnected; resynchronizing resources');
        try {
            if (!this.client || !this.resources) return;
            const resources = await this.client.getResources();
            this.resources.replaceAll(resources);
            await this.objectManager.syncDevices(this.resources);
            await this.groupObjectManager.sync(this.resources);
            await this.entertainmentObjectManager.sync(this.resources);
            await this.setStateAsync('info.connection', true, true);
            this.log.info(`Hue resync after reconnect completed. Indexed ${this.resources.size} API v2 resources.`);
        } catch (error) {
            await this.setStateAsync('info.connection', false, true);
            const message = error instanceof Error ? error.message : String(error);
            this.log.warn(`Hue resync after reconnect failed: ${message}`);
        }
    }

    private async handleResourceUpdate(update: HueResource): Promise<void> {
        if (this.reconnectSync) await this.reconnectSync;
        if (!this.resources) return;
        const merged = this.resources.patch(update);
        await this.objectManager.updateResource(this.resources, merged);
        await this.groupObjectManager.updateResource(this.resources, merged);
        await this.entertainmentObjectManager.updateResource(this.resources, merged);
        this.log.debug(`Hue event update ${merged.type}: ${merged.id}`);
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack || !this.client) return;
        const instancePrefix = `${this.namespace}.`;
        if (!id.startsWith(instancePrefix)) return;
        const relativeId = id.slice(instancePrefix.length);
        if (!['devices.', 'rooms.', 'zones.', 'entertainment.'].some(prefix => relativeId.startsWith(prefix))) return;
        const property = id.slice(id.lastIndexOf('.') + 1);
        const object = await this.getObjectAsync(relativeId);
        if (!object || object.type !== 'state') return;
        const native = object.native as Record<string, unknown>;
        try {
            switch (property) {
                case 'enabled': await this.writeEnabled(native, state.val); break;
                case 'on':
                    await this.writeSingleResource(native, { on: { on: this.requireBoolean(state.val, 'on') } });
                    await this.cancelTransitionForWrite(relativeId);
                    break;
                case 'dimming': {
                    const brightness = this.requireNumber(state.val, 'dimming');
                    if (brightness < 0 || brightness > 100) throw new Error('dimming must be between 0 and 100');
                    const config = this.config as Hue2Config;
                    const payload = config.dimmingControlsPower
                        ? brightness === 0
                            ? { on: { on: false } }
                            : { on: { on: true }, dimming: { brightness } }
                        : { dimming: { brightness } };
                    await this.writeSingleResource(native, payload);
                    await this.cancelTransitionForWrite(relativeId);
                    break;
                }
                case 'color_temperature':
                    await this.writeSingleResource(native, { color_temperature: { mirek: this.requireNumber(state.val, 'color_temperature') } });
                    await this.cancelTransitionForWrite(relativeId);
                    break;
                case 'color':
                    await this.writeColor(native, state.val);
                    await this.cancelTransitionForWrite(relativeId);
                    break;
                case 'command': await this.writeCommand(relativeId, native, state.val); break;
                case 'start':
                case 'stop':
                    await this.writeEntertainmentAction(relativeId, native, property, state.val);
                    return;
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

    private async writeEntertainmentAction(relativeId: string, native: Record<string, unknown>, action: 'start' | 'stop', value: ioBroker.StateValue): Promise<void> {
        const pressed = this.requireBoolean(value, action);
        if (!pressed) {
            await this.setStateAsync(relativeId, false, true);
            return;
        }
        await this.writeSingleResource(native, { action });
        await this.setStateAsync(relativeId, false, true);
        this.log.debug(`Sent Hue Entertainment action ${action} for ${relativeId}`);
    }

    private async writeCommand(relativeId: string, native: Record<string, unknown>, value: ioBroker.StateValue): Promise<void> {
        if (typeof value !== 'string') throw new Error('command must be a JSON string');
        let parsed: unknown;
        try { parsed = JSON.parse(value); } catch { throw new Error('command must be valid JSON'); }
        const payload = this.asRecord(parsed);
        if (!payload) throw new Error('command must contain a JSON object');
        await this.writeSingleResource(native, payload);
        const dynamics = this.asRecord(payload.dynamics);
        if (dynamics?.duration === undefined) await this.cancelTransitionForWrite(relativeId);
        else await this.updateTransitionState(relativeId, payload);
    }

    private async cancelTransitionForWrite(relativeId: string): Promise<void> {
        const baseId = relativeId.slice(0, relativeId.lastIndexOf('.'));
        const stateIds = [`${baseId}.transition_active`, ...this.getGroupTransitionDeviceStateIds(baseId)];
        const uniqueStateIds = [...new Set(stateIds)];

        await this.transitionTracker.cancel(uniqueStateIds);
    }

    private async updateTransitionState(commandId: string, payload: Record<string, unknown>): Promise<void> {
        const dynamics = this.asRecord(payload.dynamics);
        if (!dynamics || dynamics.duration === undefined) return;
        const duration = this.requireNumber(dynamics.duration as ioBroker.StateValue, 'dynamics.duration');
        if (duration < 0) throw new Error('dynamics.duration must not be negative');

        const baseId = commandId.slice(0, -'.command'.length);
        const stateIds = [`${baseId}.transition_active`, ...this.getGroupTransitionDeviceStateIds(baseId)];

        await this.setTransitionOperation(stateIds, duration);
    }

    private getGroupTransitionDeviceStateIds(baseId: string): string[] {
        if (!this.resources) return [];
        const parts = baseId.split('.');
        if (parts.length !== 2 || (parts[0] !== 'rooms' && parts[0] !== 'zones')) return [];
        const type = parts[0] === 'rooms' ? 'room' : 'zone';
        const container = this.resources.getById(parts[1]);
        if (!container || container.type !== type || !Array.isArray(container.children)) return [];

        const deviceIds = new Set<string>();
        for (const child of container.children) {
            const reference = this.asRecord(child);
            const rid = typeof reference?.rid === 'string' ? reference.rid : undefined;
            const rtype = typeof reference?.rtype === 'string' ? reference.rtype : undefined;
            if (!rid || !rtype) continue;
            const deviceId = rtype === 'device' ? rid : this.resources.getDeviceIdForService(rid);
            if (deviceId && this.resources.getDeviceServices(deviceId).some(service => service.type === 'light')) deviceIds.add(deviceId);
        }
        return [...deviceIds].map(deviceId => `devices.${deviceId}.transition_active`);
    }

    private async setTransitionOperation(stateIds: string[], duration: number): Promise<void> {
        await this.transitionTracker.start(stateIds, duration);
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
    private onUnload(callback: () => void): void {
        this.eventStream?.stop();
        this.reconnectSync = undefined;
        this.transitionTracker.stop();
        callback();
    }
}

if (require.main !== module) module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Hue2(options);
else new Hue2();
