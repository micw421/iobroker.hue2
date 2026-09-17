import * as utils from '@iobroker/adapter-core';
import { HueV2Client, type HueResource } from './lib/hue-v2-client';

interface Hue2Config extends ioBroker.AdapterConfig {
    bridge: string;
    applicationKey: string;
}

interface HueResourceReference {
    rid: string;
    rtype: string;
}

class Hue2 extends utils.Adapter {
    private client?: HueV2Client;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'hue2',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        const config = this.config as Hue2Config;

        if (!config.bridge || !config.applicationKey) {
            this.log.warn('Hue Bridge address or application key is missing');
            await this.setState('info.connection', false, true);
            return;
        }

        this.client = new HueV2Client({
            address: config.bridge,
            applicationKey: config.applicationKey,
        });

        try {
            const resources = await this.client.getResources();

            await this.setState('info.connection', true, true);
            this.log.info(`Connected to Hue Bridge. Discovered ${resources.length} API v2 resources.`);
            this.logResourceDiagnostics(resources);
        } catch (error) {
            await this.setState('info.connection', false, true);
            const message = error instanceof Error ? error.message : String(error);
            this.log.error(`Could not connect to Hue Bridge: ${message}`);
        }
    }

    private logResourceDiagnostics(resources: HueResource[]): void {
        const counts = new Map<string, number>();
        const resourcesById = new Map(resources.map(resource => [resource.id, resource]));

        for (const resource of resources) {
            counts.set(resource.type, (counts.get(resource.type) ?? 0) + 1);
        }

        this.log.info('Hue API v2 resource summary:');
        for (const [type, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            this.log.info(`  ${type}: ${count}`);
        }

        const devices = resources.filter(resource => resource.type === 'device');
        this.log.info(`Hue API v2 device/service summary (${devices.length} devices):`);

        for (const device of devices) {
            const metadata = this.asRecord(device.metadata);
            const productData = this.asRecord(device.product_data);
            const name = typeof metadata?.name === 'string' ? metadata.name : '<unnamed>';
            const model = typeof productData?.model_id === 'string' ? productData.model_id : 'unknown model';
            const services = this.asResourceReferences(device.services);

            this.log.info(`  Device ${device.id}: ${name} (${model})`);

            for (const service of services) {
                const resource = resourcesById.get(service.rid);
                const v1 = resource?.id_v1 ? `, v1=${resource.id_v1}` : '';
                this.log.info(`    ${service.rtype}: ${service.rid}${v1}`);
            }
        }
    }

    private asRecord(value: unknown): Record<string, unknown> | undefined {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return undefined;
        }
        return value as Record<string, unknown>;
    }

    private asResourceReferences(value: unknown): HueResourceReference[] {
        if (!Array.isArray(value)) {
            return [];
        }

        return value.filter((entry): entry is HueResourceReference => {
            if (typeof entry !== 'object' || entry === null) {
                return false;
            }
            const reference = entry as Record<string, unknown>;
            return typeof reference.rid === 'string' && typeof reference.rtype === 'string';
        });
    }

    private onUnload(callback: () => void): void {
        callback();
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Hue2(options);
} else {
    new Hue2();
}
