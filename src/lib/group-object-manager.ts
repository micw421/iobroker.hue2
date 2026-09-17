import type { HueResource } from './hue-v2-client';
import type { HueResourceReference, ResourceManager } from './resource-manager';

interface StateDefinition {
    name: string;
    type: ioBroker.CommonType;
    role: string;
    value: ioBroker.StateValue;
    resource: HueResource;
    unit?: string;
    min?: number;
    max?: number;
    write?: boolean;
}

/** Creates rooms and zones with their Hue API v2 scenes nested below the owning group. */
export class GroupObjectManager {
    public constructor(private readonly adapter: ioBroker.Adapter) {}

    public async sync(resources: ResourceManager): Promise<void> {
        await this.adapter.delObjectAsync('scenes', { recursive: true });
        await this.syncGroupedContainerType('room', 'rooms', 'Hue rooms', resources);
        await this.syncGroupedContainerType('zone', 'zones', 'Hue zones', resources);
    }

    public async updateResource(resources: ResourceManager, resource: HueResource): Promise<void> {
        if (resource.type !== 'grouped_light') return;
        for (const [resourceType, root] of [['room', 'rooms'], ['zone', 'zones']] as const) {
            for (const container of resources.getByType(resourceType)) {
                if (this.getServiceReferences(container).some(reference => reference.rid === resource.id)) {
                    await this.updateGroupedLightValues(`${root}.${container.id}`, resource);
                }
            }
        }
    }

    private async syncGroupedContainerType(resourceType: 'room' | 'zone', root: 'rooms' | 'zones', rootName: string, resources: ResourceManager): Promise<void> {
        await this.adapter.delObjectAsync(root, { recursive: true });
        await this.adapter.extendObjectAsync(root, { type: 'folder', common: { name: rootName }, native: {} });

        for (const container of resources.getByType(resourceType)) {
            const metadata = this.asRecord(container.metadata);
            const name = this.asString(metadata?.name) ?? container.id;
            const groupedLight = this.getServiceReferences(container)
                .filter(reference => reference.rtype === 'grouped_light')
                .map(reference => resources.getById(reference.rid))
                .find((resource): resource is HueResource => resource !== undefined);

            const baseId = `${root}.${container.id}`;
            await this.adapter.extendObjectAsync(baseId, {
                type: 'channel', common: { name },
                native: { hueResourceId: container.id, hueResourceType: container.type, groupedLightResourceId: groupedLight?.id },
            });
            await this.createInfoState(`${baseId}.name`, 'Name', name);
            if (groupedLight) {
                await this.createState(`${baseId}.command`, {
                    name: 'Command', type: 'string', role: 'json', value: '', resource: groupedLight, write: true,
                });
                await this.syncGroupedLightStates(baseId, groupedLight);
            }
            await this.syncScenesForGroup(baseId, container.id, container.type, resources);
        }
    }

    private async syncScenesForGroup(baseId: string, groupId: string, groupType: string, resources: ResourceManager): Promise<void> {
        const scenes = resources.getByType('scene').filter(scene => {
            const group = this.asRecord(scene.group);
            return this.asString(group?.rid) === groupId && this.asString(group?.rtype) === groupType;
        });
        if (scenes.length === 0) return;

        await this.adapter.extendObjectAsync(`${baseId}.scenes`, { type: 'channel', common: { name: 'Scenes' }, native: {} });
        for (const scene of scenes) {
            const metadata = this.asRecord(scene.metadata);
            const name = this.asString(metadata?.name) ?? scene.id;
            const sceneBaseId = `${baseId}.scenes.${scene.id}`;
            await this.adapter.extendObjectAsync(sceneBaseId, {
                type: 'channel', common: { name },
                native: { hueResourceId: scene.id, hueResourceType: scene.type, groupResourceId: groupId, groupResourceType: groupType },
            });
            await this.createInfoState(`${sceneBaseId}.name`, 'Name', name);
            await this.createState(`${sceneBaseId}.recall`, { name: 'Recall', type: 'boolean', role: 'button', value: false, resource: scene, write: true });
        }
    }

    private async syncGroupedLightStates(baseId: string, resource: HueResource): Promise<void> {
        const on = this.asRecord(resource.on);
        if (typeof on?.on === 'boolean') await this.createState(`${baseId}.on`, { name: 'On', type: 'boolean', role: 'switch', value: on.on, resource, write: true });
        const dimming = this.asRecord(resource.dimming);
        if (typeof dimming?.brightness === 'number') await this.createState(`${baseId}.dimming`, { name: 'Dimming', type: 'number', role: 'level.dimmer', value: dimming.brightness, unit: '%', min: 0, max: 100, resource, write: true });
        const colorTemperature = this.asRecord(resource.color_temperature);
        if (typeof colorTemperature?.mirek === 'number') {
            const schema = this.asRecord(colorTemperature.mirek_schema);
            await this.createState(`${baseId}.color_temperature`, { name: 'Color temperature', type: 'number', role: 'level.color.temperature', value: colorTemperature.mirek, unit: 'mired', min: this.asNumber(schema?.mirek_minimum), max: this.asNumber(schema?.mirek_maximum), resource, write: true });
        }
        const color = this.asRecord(resource.color);
        const xy = this.asRecord(color?.xy);
        if (typeof xy?.x === 'number' && typeof xy?.y === 'number') await this.createState(`${baseId}.color`, { name: 'Color', type: 'string', role: 'text', value: JSON.stringify({ x: xy.x, y: xy.y }), resource, write: true });
    }

    private async updateGroupedLightValues(baseId: string, resource: HueResource): Promise<void> {
        const on = this.asRecord(resource.on);
        if (typeof on?.on === 'boolean') await this.adapter.setStateAsync(`${baseId}.on`, on.on, true);
        const dimming = this.asRecord(resource.dimming);
        if (typeof dimming?.brightness === 'number') await this.adapter.setStateAsync(`${baseId}.dimming`, dimming.brightness, true);
        const colorTemperature = this.asRecord(resource.color_temperature);
        if (typeof colorTemperature?.mirek === 'number') await this.adapter.setStateAsync(`${baseId}.color_temperature`, colorTemperature.mirek, true);
        const color = this.asRecord(resource.color);
        const xy = this.asRecord(color?.xy);
        if (typeof xy?.x === 'number' && typeof xy?.y === 'number') await this.adapter.setStateAsync(`${baseId}.color`, JSON.stringify({ x: xy.x, y: xy.y }), true);
    }

    private async createState(id: string, definition: StateDefinition): Promise<void> {
        const common: ioBroker.StateCommon = { name: definition.name, type: definition.type, role: definition.role, read: true, write: definition.write ?? false };
        if (definition.unit !== undefined) common.unit = definition.unit;
        if (definition.min !== undefined) common.min = definition.min;
        if (definition.max !== undefined) common.max = definition.max;
        await this.adapter.extendObjectAsync(id, { type: 'state', common, native: { hueResourceId: definition.resource.id, hueResourceType: definition.resource.type, idV1: definition.resource.id_v1 } });
        await this.adapter.setStateAsync(id, definition.value, true);
    }

    private async createInfoState(id: string, name: string, value: string): Promise<void> {
        await this.adapter.extendObjectAsync(id, { type: 'state', common: { name, type: 'string', role: 'text', read: true, write: false }, native: {} });
        await this.adapter.setStateAsync(id, value, true);
    }

    private getServiceReferences(resource: HueResource): HueResourceReference[] {
        if (!Array.isArray(resource.services)) return [];
        return resource.services.filter((entry): entry is HueResourceReference => {
            if (typeof entry !== 'object' || entry === null) return false;
            const reference = entry as Record<string, unknown>;
            return typeof reference.rid === 'string' && typeof reference.rtype === 'string';
        });
    }

    private asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
    private asString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
    private asNumber(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }
}
