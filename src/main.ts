import * as utils from '@iobroker/adapter-core';
import { HueV2Client } from './lib/hue-v2-client';

interface Hue2Config extends ioBroker.AdapterConfig {
    bridge: string;
    applicationKey: string;
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

            for (const resource of resources) {
                this.log.debug(`Hue resource ${resource.type}: ${resource.id}`);
            }
        } catch (error) {
            await this.setState('info.connection', false, true);
            const message = error instanceof Error ? error.message : String(error);
            this.log.error(`Could not connect to Hue Bridge: ${message}`);
        }
    }

    private onUnload(callback: () => void): void {
        try {
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Hue2(options);
} else {
    new Hue2();
}
