import type { HueResource } from './hue-v2-client';
import type { HueResourceReference, ResourceManager } from './resource-manager';

interface StateDefinition { name: string; type: ioBroker.CommonType; role: string; value?: ioBroker.StateValue; resource: HueResource; unit?: string; min?: number; max?: number; write?: boolean; }
interface ColorTemperatureRange { min?: number; max?: number; }
interface GroupOnState { anyOn: boolean; allOn: boolean; }

/** Creates rooms and zones with their Hue API v2 scenes nested below the owning group. */
export class GroupObjectManager {
    public constructor(private readonly adapter: ioBroker.Adapter) {}

    public async sync(resources: ResourceManager): Promise<void> {
        await this.adapter.delObjectAsync('scenes', { recursive: true });
        await this.syncGroupedContainerType('room', 'rooms', 'Hue rooms', resources);
        await this.syncGroupedContainerType('zone', 'zones', 'Hue zones', resources);
    }

    public async updateResource(resources: ResourceManager, resource: HueResource): Promise<void> {
        if (resource.type === 'scene') { await this.updateSceneStatus(resource); await this.updateActiveScene(resources, resource); return; }
        if (resource.type === 'entertainment_configuration') { await this.updateAllGroupEntertainmentStates(resources); return; }
        if (resource.type === 'light') { await this.updateAllGroupOnStates(resources); return; }
        if (resource.type !== 'grouped_light') return;
        for (const [type, root] of [['room', 'rooms'], ['zone', 'zones']] as const) for (const container of resources.getByType(type)) if (this.getServiceReferences(container).some(reference => reference.rid === resource.id)) await this.updateGroupedLightValues(`${root}.${container.id}`, resource);
    }

    private async syncGroupedContainerType(type: 'room' | 'zone', root: 'rooms' | 'zones', rootName: string, resources: ResourceManager): Promise<void> {
        await this.adapter.delObjectAsync(root, { recursive: true });
        await this.adapter.extendObjectAsync(root, { type: 'folder', common: { name: rootName }, native: {} });
        for (const container of resources.getByType(type)) {
            const metadata = this.asRecord(container.metadata); const name = this.asString(metadata?.name) ?? container.id;
            const groupedLight = this.getServiceReferences(container).filter(reference => reference.rtype === 'grouped_light').map(reference => resources.getById(reference.rid)).find((candidate): candidate is HueResource => candidate !== undefined);
            const baseId = `${root}.${container.id}`;
            await this.adapter.extendObjectAsync(baseId, { type: 'channel', common: { name }, native: { hueResourceId: container.id, hueResourceType: container.type, groupedLightResourceId: groupedLight?.id } });
            await this.createInfoState(`${baseId}.name`, 'Name', name);
            await this.createSimpleStringState(`${baseId}.active_scene`, 'Active scene', this.getActiveSceneName(resources, container.id, container.type));
            const onState = this.getGroupOnState(container, resources);
            if (onState) { await this.createDerivedBooleanState(`${baseId}.any_on`, 'Any on', onState.anyOn, 'member_lights'); await this.createDerivedBooleanState(`${baseId}.all_on`, 'All on', onState.allOn, 'member_lights'); }
            if (this.groupHasEntertainmentCapability(container, resources)) await this.createDerivedBooleanState(`${baseId}.entertainment_active`, 'Entertainment active', this.isGroupEntertainmentActive(container, resources), 'entertainment_configuration');
            if (groupedLight) { await this.createState(`${baseId}.command`, { name: 'Command', type: 'string', role: 'json', value: '', resource: groupedLight, write: true }); await this.syncGroupedLightStates(baseId, groupedLight, this.getGroupColorTemperatureRange(container, resources)); }
            await this.syncScenesForGroup(baseId, container.id, container.type, resources);
        }
    }

    private async syncScenesForGroup(baseId: string, groupId: string, groupType: string, resources: ResourceManager): Promise<void> {
        const scenes = resources.getByType('scene').filter(scene => { const group = this.asRecord(scene.group); return this.asString(group?.rid) === groupId && this.asString(group?.rtype) === groupType; });
        if (scenes.length === 0) return;
        await this.adapter.extendObjectAsync(`${baseId}.scenes`, { type: 'channel', common: { name: 'Scenes' }, native: {} });
        for (const scene of scenes) {
            const metadata = this.asRecord(scene.metadata); const name = this.asString(metadata?.name) ?? scene.id; const sceneBaseId = `${baseId}.scenes.${scene.id}`;
            await this.adapter.extendObjectAsync(sceneBaseId, { type: 'channel', common: { name }, native: { hueResourceId: scene.id, hueResourceType: scene.type, groupResourceId: groupId, groupResourceType: groupType } });
            await this.createInfoState(`${sceneBaseId}.name`, 'Name', name);
            await this.createState(`${sceneBaseId}.recall`, { name: 'Recall', type: 'boolean', role: 'button', value: false, resource: scene, write: true });
            const status = this.getSceneStatus(scene); if (status !== undefined) await this.createState(`${sceneBaseId}.status`, { name: 'Status', type: 'string', role: 'text', value: status, resource: scene });
        }
    }

    private async updateSceneStatus(scene: HueResource): Promise<void> {
        const status = this.getSceneStatus(scene); if (status === undefined) return;
        const group = this.asRecord(scene.group); const groupId = this.asString(group?.rid); const groupType = this.asString(group?.rtype); if (!groupId) return;
        const root = groupType === 'room' ? 'rooms' : groupType === 'zone' ? 'zones' : undefined; if (!root) return;
        await this.adapter.setStateAsync(`${root}.${groupId}.scenes.${scene.id}.status`, status, true);
    }

    private async updateActiveScene(resources: ResourceManager, scene: HueResource): Promise<void> {
        const group = this.asRecord(scene.group); const groupId = this.asString(group?.rid); const groupType = this.asString(group?.rtype);
        if (!groupId || (groupType !== 'room' && groupType !== 'zone')) return;
        await this.adapter.setStateAsync(`${groupType === 'room' ? 'rooms' : 'zones'}.${groupId}.active_scene`, this.getActiveSceneName(resources, groupId, groupType), true);
    }

    private getActiveSceneName(resources: ResourceManager, groupId: string, groupType: string): string {
        for (const scene of resources.getByType('scene')) { const group = this.asRecord(scene.group); if (this.asString(group?.rid) !== groupId || this.asString(group?.rtype) !== groupType) continue; const status = this.getSceneStatus(scene); if (status === undefined || status === 'inactive') continue; const metadata = this.asRecord(scene.metadata); return this.asString(metadata?.name) ?? scene.id; }
        return '';
    }

    private getSceneStatus(scene: HueResource): string | undefined { const status = this.asRecord(scene.status); return this.asString(status?.active); }

    private getGroupDeviceIds(container: HueResource, resources: ResourceManager): string[] {
        if (!Array.isArray(container.children)) return [];
        const ids = new Set<string>();
        for (const child of container.children) {
            const ref = this.asRecord(child); const rid = this.asString(ref?.rid); const rtype = this.asString(ref?.rtype); if (!rid || !rtype) continue;
            if (rtype === 'device') ids.add(rid);
            else { const deviceId = resources.getDeviceIdForService(rid); if (deviceId) ids.add(deviceId); }
        }
        return [...ids];
    }

    private getGroupLights(container: HueResource, resources: ResourceManager): HueResource[] {
        const lights: HueResource[] = [];
        for (const deviceId of this.getGroupDeviceIds(container, resources)) for (const service of resources.getDeviceServices(deviceId)) if (service.type === 'light') lights.push(service);
        return lights;
    }

    private getGroupOnState(container: HueResource, resources: ResourceManager): GroupOnState | undefined {
        const values = this.getGroupLights(container, resources).map(light => this.asRecord(light.on)?.on).filter((value): value is boolean => typeof value === 'boolean');
        if (values.length === 0) return undefined;
        return { anyOn: values.some(Boolean), allOn: values.every(Boolean) };
    }

    private async updateAllGroupOnStates(resources: ResourceManager): Promise<void> {
        for (const [type, root] of [['room', 'rooms'], ['zone', 'zones']] as const) for (const container of resources.getByType(type)) { const state = this.getGroupOnState(container, resources); if (!state) continue; await this.adapter.setStateAsync(`${root}.${container.id}.any_on`, state.anyOn, true); await this.adapter.setStateAsync(`${root}.${container.id}.all_on`, state.allOn, true); }
    }

    private getGroupEntertainmentTargets(container: HueResource, resources: ResourceManager): { lightIds: Set<string>; entertainmentIds: Set<string> } {
        const lightIds = new Set<string>(); const entertainmentIds = new Set<string>();
        for (const deviceId of this.getGroupDeviceIds(container, resources)) for (const service of resources.getDeviceServices(deviceId)) { if (service.type === 'light') lightIds.add(service.id); if (service.type === 'entertainment') entertainmentIds.add(service.id); }
        return { lightIds, entertainmentIds };
    }

    private groupHasEntertainmentCapability(container: HueResource, resources: ResourceManager): boolean { const targets = this.getGroupEntertainmentTargets(container, resources); if (targets.entertainmentIds.size > 0) return true; return resources.getByType('entertainment_configuration').some(config => this.configurationReferencesTargets(config, targets)); }
    private isGroupEntertainmentActive(container: HueResource, resources: ResourceManager): boolean { const targets = this.getGroupEntertainmentTargets(container, resources); return resources.getByType('entertainment_configuration').some(config => config.status === 'active' && this.configurationReferencesTargets(config, targets)); }
    private configurationReferencesTargets(config: HueResource, targets: { lightIds: Set<string>; entertainmentIds: Set<string> }): boolean { const lightServices = Array.isArray(config.light_services) ? config.light_services : []; if (lightServices.some(entry => { const ref = this.asRecord(entry); return ref?.rtype === 'light' && typeof ref.rid === 'string' && targets.lightIds.has(ref.rid); })) return true; return this.containsEntertainmentServiceReference(config.channels, targets.entertainmentIds); }
    private containsEntertainmentServiceReference(value: unknown, ids: Set<string>): boolean { if (ids.size === 0) return false; if (Array.isArray(value)) return value.some(entry => this.containsEntertainmentServiceReference(entry, ids)); const record = this.asRecord(value); if (!record) return false; const service = this.asRecord(record.service); if (service?.rtype === 'entertainment' && typeof service.rid === 'string' && ids.has(service.rid)) return true; return Object.values(record).some(entry => this.containsEntertainmentServiceReference(entry, ids)); }

    private async updateAllGroupEntertainmentStates(resources: ResourceManager): Promise<void> {
        for (const [type, root] of [['room', 'rooms'], ['zone', 'zones']] as const) for (const container of resources.getByType(type)) { if (!this.groupHasEntertainmentCapability(container, resources)) continue; const id = `${root}.${container.id}.entertainment_active`; const object = await this.adapter.getObjectAsync(id); if (!object) await this.createDerivedBooleanState(id, 'Entertainment active', this.isGroupEntertainmentActive(container, resources), 'entertainment_configuration'); else await this.adapter.setStateAsync(id, this.isGroupEntertainmentActive(container, resources), true); }
    }

    private getGroupColorTemperatureRange(container: HueResource, resources: ResourceManager): ColorTemperatureRange {
        const ranges: Array<{ min: number; max: number }> = [];
        for (const deviceId of this.getGroupDeviceIds(container, resources)) for (const service of resources.getDeviceServices(deviceId)) { if (service.type !== 'light') continue; const colorTemperature = this.asRecord(service.color_temperature); const schema = this.asRecord(colorTemperature?.mirek_schema); const min = this.asNumber(schema?.mirek_minimum); const max = this.asNumber(schema?.mirek_maximum); if (min !== undefined && max !== undefined) ranges.push({ min, max }); }
        if (ranges.length === 0) return {};
        const min = Math.max(...ranges.map(range => range.min)); const max = Math.min(...ranges.map(range => range.max)); return min <= max ? { min, max } : {};
    }

    private async syncGroupedLightStates(baseId: string, resource: HueResource, derivedRange: ColorTemperatureRange): Promise<void> {
        const on = this.asRecord(resource.on); if (typeof on?.on === 'boolean') await this.createState(`${baseId}.on`, { name: 'On', type: 'boolean', role: 'switch', value: on.on, resource, write: true });
        const dimming = this.asRecord(resource.dimming); if (typeof dimming?.brightness === 'number') await this.createState(`${baseId}.dimming`, { name: 'Dimming', type: 'number', role: 'level.dimmer', value: dimming.brightness, unit: '%', min: 0, max: 100, resource, write: true });
        if (Object.prototype.hasOwnProperty.call(resource, 'color_temperature')) { const colorTemperature = this.asRecord(resource.color_temperature); const schema = this.asRecord(colorTemperature?.mirek_schema); await this.createState(`${baseId}.color_temperature`, { name: 'Color temperature', type: 'number', role: 'level.color.temperature', value: typeof colorTemperature?.mirek === 'number' ? colorTemperature.mirek : undefined, unit: 'mired', min: this.asNumber(schema?.mirek_minimum) ?? derivedRange.min, max: this.asNumber(schema?.mirek_maximum) ?? derivedRange.max, resource, write: true }); }
        if (Object.prototype.hasOwnProperty.call(resource, 'color')) { const color = this.asRecord(resource.color); const xy = this.asRecord(color?.xy); await this.createState(`${baseId}.color`, { name: 'Color', type: 'string', role: 'text', value: typeof xy?.x === 'number' && typeof xy?.y === 'number' ? JSON.stringify({ x: xy.x, y: xy.y }) : '', resource, write: true }); }
    }

    private async updateGroupedLightValues(baseId: string, resource: HueResource): Promise<void> {
        const on = this.asRecord(resource.on); if (typeof on?.on === 'boolean') await this.adapter.setStateAsync(`${baseId}.on`, on.on, true);
        const dimming = this.asRecord(resource.dimming); if (typeof dimming?.brightness === 'number') await this.adapter.setStateAsync(`${baseId}.dimming`, dimming.brightness, true);
        const colorTemperature = this.asRecord(resource.color_temperature); if (typeof colorTemperature?.mirek === 'number') await this.adapter.setStateAsync(`${baseId}.color_temperature`, colorTemperature.mirek, true);
        const color = this.asRecord(resource.color); const xy = this.asRecord(color?.xy); if (typeof xy?.x === 'number' && typeof xy?.y === 'number') await this.adapter.setStateAsync(`${baseId}.color`, JSON.stringify({ x: xy.x, y: xy.y }), true);
    }

    private async createState(id: string, definition: StateDefinition): Promise<void> { const common: ioBroker.StateCommon = { name: definition.name, type: definition.type, role: definition.role, read: true, write: definition.write ?? false }; if (definition.unit !== undefined) common.unit = definition.unit; if (definition.min !== undefined) common.min = definition.min; if (definition.max !== undefined) common.max = definition.max; await this.adapter.extendObjectAsync(id, { type: 'state', common, native: { hueResourceId: definition.resource.id, hueResourceType: definition.resource.type, idV1: definition.resource.id_v1 } }); if (definition.value !== undefined) await this.adapter.setStateAsync(id, definition.value, true); }
    private async createDerivedBooleanState(id: string, name: string, value: boolean, derivedFrom: string): Promise<void> { await this.adapter.extendObjectAsync(id, { type: 'state', common: { name, type: 'boolean', role: 'indicator', read: true, write: false }, native: { hueDerivedFrom: derivedFrom } }); await this.adapter.setStateAsync(id, value, true); }
    private async createSimpleStringState(id: string, name: string, value: string): Promise<void> { await this.adapter.extendObjectAsync(id, { type: 'state', common: { name, type: 'string', role: 'text', read: true, write: false }, native: {} }); await this.adapter.setStateAsync(id, value, true); }
    private async createInfoState(id: string, name: string, value: string): Promise<void> { await this.createSimpleStringState(id, name, value); }
    private getServiceReferences(resource: HueResource): HueResourceReference[] { if (!Array.isArray(resource.services)) return []; return resource.services.filter((entry): entry is HueResourceReference => { if (typeof entry !== 'object' || entry === null) return false; const reference = entry as Record<string, unknown>; return typeof reference.rid === 'string' && typeof reference.rtype === 'string'; }); }
    private asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
    private asString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
    private asNumber(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }
}
