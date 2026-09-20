import type { HueResource } from './hue-v2-client';
import type { ResourceManager } from './resource-manager';

/** Creates and updates Hue Entertainment configurations. */
export class EntertainmentObjectManager {
    public constructor(private readonly adapter: ioBroker.Adapter) {}

    public async sync(resources: ResourceManager): Promise<void> {
        const configurations = resources.getByType('entertainment_configuration');
        if (configurations.length === 0) {
            const root = await this.adapter.getObjectAsync('entertainment');
            if (root) await this.adapter.delObjectAsync('entertainment', { recursive: true });
            return;
        }

        await this.adapter.extendObjectAsync('entertainment', {
            type: 'folder',
            common: { name: 'Hue Entertainment' },
            native: {},
        });

        for (const configuration of configurations) {
            await this.syncConfiguration(configuration, resources);
        }
        await this.removeObsoleteConfigurations(new Set(configurations.map(configuration => configuration.id)));
    }

    public async updateResource(resources: ResourceManager, resource: HueResource): Promise<void> {
        if (resource.type !== 'entertainment_configuration') return;
        const baseId = `entertainment.${resource.id}`;
        const active = resource.status === 'active';
        const object = await this.adapter.getObjectAsync(baseId);
        if (!object) {
            await this.syncConfiguration(resource, resources);
            return;
        }
        await this.adapter.setStateAsync(`${baseId}.active`, active, true);
        await this.syncLights(baseId, resource, resources);
    }

    private async syncConfiguration(configuration: HueResource, resources: ResourceManager): Promise<void> {
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

        await this.syncLights(baseId, configuration, resources);
    }

    private async syncLights(baseId: string, configuration: HueResource, resources: ResourceManager): Promise<void> {
        const lightsBaseId = `${baseId}.lights`;
        const deviceIds = this.getEntertainmentDeviceIds(configuration, resources);
        if (deviceIds.length === 0) {
            const lightsObject = await this.adapter.getObjectAsync(lightsBaseId);
            if (lightsObject) await this.adapter.delObjectAsync(lightsBaseId, { recursive: true });
            return;
        }

        await this.adapter.extendObjectAsync(lightsBaseId, {
            type: 'channel',
            common: { name: 'Lights' },
            native: {},
        });

        for (const deviceId of deviceIds) {
            const device = resources.getDevice(deviceId);
            const metadata = this.asRecord(device?.metadata);
            const name = typeof metadata?.name === 'string' ? metadata.name : deviceId;
            await this.adapter.extendObjectAsync(`${lightsBaseId}.${deviceId}`, {
                type: 'state',
                common: { name, type: 'string', role: 'text', read: true, write: false },
                native: { hueDeviceResourceId: deviceId },
            });
            await this.adapter.setStateAsync(`${lightsBaseId}.${deviceId}`, name, true);
        }
        await this.removeObsoleteLightObjects(baseId, new Set(deviceIds));
    }

    private async removeObsoleteConfigurations(currentIds: Set<string>): Promise<void> {
        const prefix = `${this.adapter.namespace}.entertainment.`;
        const objects = await this.adapter.getForeignObjectsAsync(`${prefix}*`);
        const obsolete = new Set<string>();
        for (const [id, object] of Object.entries(objects)) {
            if (!id.startsWith(prefix) || object.type !== 'channel') continue;
            const relative = id.slice(prefix.length);
            if (relative.includes('.')) continue;
            const native = object.native as Record<string, unknown>;
            if (native.hueResourceType === 'entertainment_configuration' && !currentIds.has(relative)) obsolete.add(relative);
        }
        for (const id of obsolete) await this.adapter.delObjectAsync(`entertainment.${id}`, { recursive: true });
    }

    private async removeObsoleteLightObjects(baseId: string, currentDeviceIds: Set<string>): Promise<void> {
        const prefix = `${this.adapter.namespace}.${baseId}.lights.`;
        const objects = await this.adapter.getForeignObjectsAsync(`${prefix}*`);
        for (const [id, object] of Object.entries(objects)) {
            if (!id.startsWith(prefix) || object.type !== 'state') continue;
            const deviceId = id.slice(prefix.length);
            const native = object.native as Record<string, unknown>;
            if (native.hueDeviceResourceId === deviceId && !currentDeviceIds.has(deviceId)) {
                await this.adapter.delObjectAsync(`${baseId}.lights.${deviceId}`);
            }
        }
    }

    private getEntertainmentDeviceIds(configuration: HueResource, resources: ResourceManager): string[] {
        const deviceIds = new Set<string>();

        if (Array.isArray(configuration.light_services)) {
            for (const entry of configuration.light_services) {
                const reference = this.asRecord(entry);
                const rid = typeof reference?.rid === 'string' ? reference.rid : undefined;
                if (!rid) continue;
                const deviceId = resources.getDeviceIdForService(rid);
                if (deviceId) deviceIds.add(deviceId);
            }
        }

        this.collectReferencedDeviceIds(configuration.channels, resources, deviceIds);
        return [...deviceIds];
    }

    private collectReferencedDeviceIds(value: unknown, resources: ResourceManager, deviceIds: Set<string>): void {
        if (Array.isArray(value)) {
            for (const entry of value) this.collectReferencedDeviceIds(entry, resources, deviceIds);
            return;
        }

        const record = this.asRecord(value);
        if (!record) return;

        const service = this.asRecord(record.service);
        const rid = typeof service?.rid === 'string' ? service.rid : undefined;
        if (rid) {
            const deviceId = resources.getDeviceIdForService(rid);
            if (deviceId) deviceIds.add(deviceId);
        }

        for (const entry of Object.values(record)) {
            this.collectReferencedDeviceIds(entry, resources, deviceIds);
        }
    }

    private asRecord(value: unknown): Record<string, unknown> | undefined {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
            ? value as Record<string, unknown>
            : undefined;
    }
}
