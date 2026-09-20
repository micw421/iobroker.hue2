import type { HueResource } from './hue-v2-client';
import type { ResourceManager } from './resource-manager';

/** Creates and updates Hue Entertainment configurations. */
export class EntertainmentObjectManager {
    public constructor(private readonly adapter: ioBroker.Adapter) {}

    public async sync(resources: ResourceManager): Promise<void> {
        await this.adapter.delObjectAsync('entertainment', { recursive: true });
        const configurations = resources.getByType('entertainment_configuration');
        if (configurations.length === 0) return;

        await this.adapter.extendObjectAsync('entertainment', {
            type: 'folder',
            common: { name: 'Hue Entertainment' },
            native: {},
        });

        for (const configuration of configurations) {
            await this.syncConfiguration(configuration);
        }
    }

    public async updateResource(resource: HueResource): Promise<void> {
        if (resource.type !== 'entertainment_configuration') return;
        const baseId = `entertainment.${resource.id}`;
        const active = resource.status === 'active';
        const object = await this.adapter.getObjectAsync(baseId);
        if (!object) {
            await this.syncConfiguration(resource);
            return;
        }
        await this.adapter.setStateAsync(`${baseId}.active`, active, true);
    }

    private async syncConfiguration(configuration: HueResource): Promise<void> {
        const metadata = this.asRecord(configuration.metadata);
        const name = typeof metadata?.name === 'string' ? metadata.name : configuration.id;
        const baseId = `entertainment.${configuration.id}`;
        const native = {
            hueResourceId: configuration.id,
            hueResourceType: configuration.type,
            idV1: configuration.id_v1,
        };

        await this.adapter.extendObjectAsync(baseId, {
            type: 'channel',
            common: { name },
            native,
        });

        await this.adapter.extendObjectAsync(`${baseId}.name`, {
            type: 'state',
            common: { name: 'Name', type: 'string', role: 'text', read: true, write: false },
            native,
        });
        await this.adapter.setStateAsync(`${baseId}.name`, name, true);

        await this.adapter.extendObjectAsync(`${baseId}.active`, {
            type: 'state',
            common: { name: 'Active', type: 'boolean', role: 'indicator', read: true, write: false },
            native,
        });
        await this.adapter.setStateAsync(`${baseId}.active`, configuration.status === 'active', true);

        for (const action of ['start', 'stop'] as const) {
            await this.adapter.extendObjectAsync(`${baseId}.${action}`, {
                type: 'state',
                common: { name: action === 'start' ? 'Start' : 'Stop', type: 'boolean', role: 'button', read: true, write: true, def: false },
                native,
            });
            await this.adapter.setStateAsync(`${baseId}.${action}`, false, true);
        }
    }

    private asRecord(value: unknown): Record<string, unknown> | undefined {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
            ? value as Record<string, unknown>
            : undefined;
    }
}
