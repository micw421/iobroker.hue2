import type { HueResource } from './hue-v2-client';
import type { HueDeviceResource, ResourceManager } from './resource-manager';

interface DeviceMetadata { name: string; model_id?: string; manufacturer_name?: string; product_name?: string; archetype?: string; }
interface StateDefinition { name: string; type: ioBroker.CommonType; role: string; value?: ioBroker.StateValue; resource: HueResource; write?: boolean; unit?: string; min?: number; max?: number; }

/** Creates and updates the flat ioBroker device model for Hue v2 resources. */
export class ObjectManager {
    public constructor(private readonly adapter: ioBroker.Adapter) {}

    public async syncDevices(resources: ResourceManager): Promise<void> {
        await this.adapter.delObjectAsync('devices', { recursive: true });
        await this.adapter.extendObjectAsync('devices', { type: 'folder', common: { name: 'Hue devices' }, native: {} });
        for (const device of resources.getDevices()) await this.syncDevice(device, resources.getDeviceServices(device));
        await this.updateAllEntertainmentStates(resources, true);
    }

    public async updateResource(resources: ResourceManager, resource: HueResource): Promise<void> {
        if (resource.type === 'entertainment_configuration') { await this.updateAllEntertainmentStates(resources, false); return; }
        if (resource.type === 'device') {
            const device = resources.getDevice(resource.id);
            if (device) { await this.syncDevice(device, resources.getDeviceServices(device)); await this.updateEntertainmentStateForDevice(resources, device, true); }
            return;
        }
        const deviceId = resources.getDeviceIdForService(resource.id);
        if (!deviceId) return;
        const baseId = `devices.${deviceId}`;
        await this.updateServiceStateValues(baseId, resource);
        if (typeof resource.enabled === 'boolean') await this.updateEnabledState(baseId, resources.getDeviceServices(deviceId));
    }

    private async syncDevice(device: HueDeviceResource, services: HueResource[]): Promise<void> {
        const baseId = `devices.${device.id}`;
        const metadata = this.getDeviceMetadata(device);
        await this.adapter.extendObjectAsync(baseId, { type: 'device', common: { name: metadata.name }, native: { hueResourceId: device.id, hueResourceType: device.type } });
        await this.adapter.extendObjectAsync(`${baseId}.info`, { type: 'channel', common: { name: 'Information' }, native: {} });
        await this.createInfoState(`${baseId}.info.name`, 'Name', metadata.name);
        await this.createOptionalInfoState(`${baseId}.info.model_id`, 'Model ID', metadata.model_id);
        await this.createOptionalInfoState(`${baseId}.info.manufacturer_name`, 'Manufacturer', metadata.manufacturer_name);
        await this.createOptionalInfoState(`${baseId}.info.product_name`, 'Product name', metadata.product_name);
        await this.createOptionalInfoState(`${baseId}.info.archetype`, 'Archetype', metadata.archetype);
        const enabledServices = services.filter(service => typeof service.enabled === 'boolean');
        if (enabledServices.length > 0) await this.createState(`${baseId}.enabled`, { name: 'Enabled', type: 'boolean', role: 'switch.enable', value: enabledServices.every(service => service.enabled === true), resource: enabledServices[0], write: true }, { hueResourceIds: enabledServices.map(service => service.id), hueResourceTypes: enabledServices.map(service => service.type) });
        const light = services.find(service => service.type === 'light');
        if (light) {
            await this.createState(`${baseId}.command`, { name: 'Command', type: 'string', role: 'json', value: '', resource: light, write: true });
            await this.createState(`${baseId}.transition_active`, { name: 'Transition active', type: 'boolean', role: 'indicator', value: false, resource: light });
        }
        for (const service of services) await this.syncServiceStates(baseId, service);
    }

    private async syncServiceStates(baseId: string, resource: HueResource): Promise<void> {
        switch (resource.type) {
            case 'light': await this.syncLightStates(baseId, resource); break;
            case 'motion': await this.syncMotionStates(baseId, resource); break;
            case 'temperature': await this.syncTemperatureStates(baseId, resource); break;
            case 'light_level': await this.syncLightLevelStates(baseId, resource); break;
            case 'device_power': await this.syncDevicePowerStates(baseId, resource); break;
            case 'zigbee_connectivity': await this.syncZigbeeConnectivityStates(baseId, resource); break;
        }
    }

    private async updateServiceStateValues(baseId: string, resource: HueResource): Promise<void> {
        switch (resource.type) {
            case 'light': {
                const on = this.asRecord(resource.on); if (typeof on?.on === 'boolean') await this.adapter.setStateAsync(`${baseId}.on`, on.on, true);
                const dimming = this.asRecord(resource.dimming); if (typeof dimming?.brightness === 'number') await this.adapter.setStateAsync(`${baseId}.dimming`, dimming.brightness, true);
                const ct = this.asRecord(resource.color_temperature); if (typeof ct?.mirek === 'number') await this.adapter.setStateAsync(`${baseId}.color_temperature`, ct.mirek, true);
                const color = this.asRecord(resource.color); const xy = this.asRecord(color?.xy); if (typeof xy?.x === 'number' && typeof xy?.y === 'number') await this.adapter.setStateAsync(`${baseId}.color`, JSON.stringify({ x: xy.x, y: xy.y }), true); break;
            }
            case 'motion': { const v = this.asRecord(resource.motion); if (typeof v?.motion === 'boolean') await this.adapter.setStateAsync(`${baseId}.motion`, v.motion, true); break; }
            case 'temperature': { const v = this.asRecord(resource.temperature); if (typeof v?.temperature === 'number') await this.adapter.setStateAsync(`${baseId}.temperature`, v.temperature, true); break; }
            case 'light_level': { const v = this.asRecord(resource.light); if (typeof v?.light_level === 'number') await this.adapter.setStateAsync(`${baseId}.light_level`, v.light_level, true); break; }
            case 'device_power': { const v = this.asRecord(resource.power_state); if (typeof v?.battery_level === 'number') await this.adapter.setStateAsync(`${baseId}.battery_level`, v.battery_level, true); if (typeof v?.battery_state === 'string') await this.adapter.setStateAsync(`${baseId}.battery_state`, v.battery_state, true); break; }
            case 'zigbee_connectivity': if (typeof resource.status === 'string') await this.adapter.setStateAsync(`${baseId}.connected`, resource.status === 'connected', true); break;
        }
    }

    private async updateEnabledState(baseId: string, services: HueResource[]): Promise<void> { const enabled = services.filter(s => typeof s.enabled === 'boolean'); if (enabled.length) await this.adapter.setStateAsync(`${baseId}.enabled`, enabled.every(s => s.enabled === true), true); }

    private async syncLightStates(baseId: string, resource: HueResource): Promise<void> {
        const on = this.asRecord(resource.on); if (typeof on?.on === 'boolean') await this.createState(`${baseId}.on`, { name: 'On', type: 'boolean', role: 'switch', value: on.on, resource, write: true });
        const dimming = this.asRecord(resource.dimming); if (typeof dimming?.brightness === 'number') await this.createState(`${baseId}.dimming`, { name: 'Dimming', type: 'number', role: 'level.dimmer', value: dimming.brightness, unit: '%', min: 0, max: 100, resource, write: true });
        if (Object.prototype.hasOwnProperty.call(resource, 'color_temperature')) {
            const ct = this.asRecord(resource.color_temperature); const schema = this.asRecord(ct?.mirek_schema);
            await this.createState(`${baseId}.color_temperature`, { name: 'Color temperature', type: 'number', role: 'level.color.temperature', value: typeof ct?.mirek === 'number' ? ct.mirek : undefined, unit: 'mired', min: this.asNumber(schema?.mirek_minimum), max: this.asNumber(schema?.mirek_maximum), resource, write: true });
        }
        if (Object.prototype.hasOwnProperty.call(resource, 'color')) { const color = this.asRecord(resource.color); const xy = this.asRecord(color?.xy); await this.createState(`${baseId}.color`, { name: 'Color', type: 'string', role: 'text', value: typeof xy?.x === 'number' && typeof xy?.y === 'number' ? JSON.stringify({ x: xy.x, y: xy.y }) : '', resource, write: true }); }
    }

    private async updateAllEntertainmentStates(resources: ResourceManager, createObjects: boolean): Promise<void> { for (const device of resources.getDevices()) await this.updateEntertainmentStateForDevice(resources, device, createObjects); }
    private async updateEntertainmentStateForDevice(resources: ResourceManager, device: HueDeviceResource, createObject: boolean): Promise<void> {
        const services = resources.getDeviceServices(device); const light = services.find(s => s.type === 'light'); if (!light) return;
        const entertainmentServices = services.filter(s => s.type === 'entertainment');
        const referenced = this.isLightReferencedByEntertainmentConfiguration(resources, light.id, entertainmentServices);
        if (entertainmentServices.length === 0 && !referenced) return;
        const id = `devices.${device.id}.entertainment_active`; const active = this.isLightInActiveEntertainmentConfiguration(resources, light.id, entertainmentServices);
        if (createObject) await this.adapter.extendObjectAsync(id, { type: 'state', common: { name: 'Entertainment active', type: 'boolean', role: 'indicator', read: true, write: false }, native: { hueDerivedFrom: 'entertainment_configuration', hueLightResourceId: light.id } });
        await this.adapter.setStateAsync(id, active, true);
    }
    private isLightReferencedByEntertainmentConfiguration(resources: ResourceManager, lightId: string, entertainmentServices: HueResource[]): boolean { const ids = new Set(entertainmentServices.map(s => s.id)); return resources.getByType('entertainment_configuration').some(c => this.hasReference(c.light_services, lightId, 'light') || this.containsEntertainmentServiceReference(c.channels, ids)); }
    private isLightInActiveEntertainmentConfiguration(resources: ResourceManager, lightId: string, entertainmentServices: HueResource[]): boolean { const ids = new Set(entertainmentServices.map(s => s.id)); return resources.getByType('entertainment_configuration').some(c => c.status === 'active' && (this.hasReference(c.light_services, lightId, 'light') || this.containsEntertainmentServiceReference(c.channels, ids))); }
    private hasReference(value: unknown, rid: string, rtype: string): boolean { return Array.isArray(value) && value.some(e => { const r = this.asRecord(e); return r?.rid === rid && r?.rtype === rtype; }); }
    private containsEntertainmentServiceReference(value: unknown, ids: Set<string>): boolean { if (!ids.size) return false; if (Array.isArray(value)) return value.some(e => this.containsEntertainmentServiceReference(e, ids)); const r = this.asRecord(value); if (!r) return false; const s = this.asRecord(r.service); if (s?.rtype === 'entertainment' && typeof s.rid === 'string' && ids.has(s.rid)) return true; return Object.values(r).some(e => this.containsEntertainmentServiceReference(e, ids)); }

    private async syncMotionStates(baseId: string, r: HueResource): Promise<void> { const v = this.asRecord(r.motion); if (typeof v?.motion === 'boolean') await this.createState(`${baseId}.motion`, { name: 'Motion', type: 'boolean', role: 'sensor.motion', value: v.motion, resource: r }); }
    private async syncTemperatureStates(baseId: string, r: HueResource): Promise<void> { const v = this.asRecord(r.temperature); if (typeof v?.temperature === 'number') await this.createState(`${baseId}.temperature`, { name: 'Temperature', type: 'number', role: 'value.temperature', value: v.temperature, unit: '°C', resource: r }); }
    private async syncLightLevelStates(baseId: string, r: HueResource): Promise<void> { const v = this.asRecord(r.light); if (typeof v?.light_level === 'number') await this.createState(`${baseId}.light_level`, { name: 'Light level', type: 'number', role: 'value', value: v.light_level, resource: r }); }
    private async syncDevicePowerStates(baseId: string, r: HueResource): Promise<void> { const v = this.asRecord(r.power_state); if (typeof v?.battery_level === 'number') await this.createState(`${baseId}.battery_level`, { name: 'Battery level', type: 'number', role: 'value.battery', value: v.battery_level, unit: '%', min: 0, max: 100, resource: r }); if (typeof v?.battery_state === 'string') await this.createState(`${baseId}.battery_state`, { name: 'Battery state', type: 'string', role: 'text', value: v.battery_state, resource: r }); }
    private async syncZigbeeConnectivityStates(baseId: string, r: HueResource): Promise<void> { if (typeof r.status === 'string') await this.createState(`${baseId}.connected`, { name: 'Connected', type: 'boolean', role: 'indicator.connected', value: r.status === 'connected', resource: r }); }

    private async createState(id: string, d: StateDefinition, nativeExtra: Record<string, unknown> = {}): Promise<void> { const common: ioBroker.StateCommon = { name: d.name, type: d.type, role: d.role, read: true, write: d.write ?? false }; if (d.unit !== undefined) common.unit = d.unit; if (d.min !== undefined) common.min = d.min; if (d.max !== undefined) common.max = d.max; await this.adapter.extendObjectAsync(id, { type: 'state', common, native: { hueResourceId: d.resource.id, hueResourceType: d.resource.type, idV1: d.resource.id_v1, ...nativeExtra } }); if (d.value !== undefined) await this.adapter.setStateAsync(id, d.value, true); }
    private async createOptionalInfoState(id: string, name: string, value: string | undefined): Promise<void> { if (value !== undefined) await this.createInfoState(id, name, value); }
    private async createInfoState(id: string, name: string, value: string): Promise<void> { await this.adapter.extendObjectAsync(id, { type: 'state', common: { name, type: 'string', role: 'text', read: true, write: false }, native: {} }); await this.adapter.setStateAsync(id, value, true); }
    private getDeviceMetadata(d: HueDeviceResource): DeviceMetadata { const m = this.asRecord(d.metadata); const p = this.asRecord(d.product_data); return { name: this.asString(m?.name) ?? d.id, model_id: this.asString(p?.model_id), manufacturer_name: this.asString(p?.manufacturer_name), product_name: this.asString(p?.product_name), archetype: this.asString(m?.archetype) }; }
    private asRecord(v: unknown): Record<string, unknown> | undefined { return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined; }
    private asString(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined; }
    private asNumber(v: unknown): number | undefined { return typeof v === 'number' ? v : undefined; }
}
