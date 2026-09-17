import type { HueResource } from './hue-v2-client';
import type { HueDeviceResource, ResourceManager } from './resource-manager';

interface DeviceMetadata {
    name: string;
    model_id?: string;
    manufacturer_name?: string;
    product_name?: string;
    archetype?: string;
}

interface StateDefinition {
    name: string;
    type: ioBroker.CommonType;
    role: string;
    value: ioBroker.StateValue;
    resource: HueResource;
    write?: boolean;
    unit?: string;
    min?: number;
    max?: number;
}

/** Creates and updates the flat ioBroker device model for Hue v2 resources. */
export class ObjectManager {
    public constructor(private readonly adapter: ioBroker.Adapter) {}

    public async syncDevices(resources: ResourceManager): Promise<void> {
        await this.adapter.delObjectAsync('devices', { recursive: true });
        await this.adapter.extendObjectAsync('devices', { type: 'folder', common: { name: 'Hue devices' }, native: {} });
        for (const device of resources.getDevices()) {
            await this.syncDevice(device, resources.getDeviceServices(device));
        }
    }

    public async updateResource(resources: ResourceManager, resource: HueResource): Promise<void> {
        if (resource.type === 'device') {
            const device = resources.getDevice(resource.id);
            if (device) await this.syncDevice(device, resources.getDeviceServices(device));
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
        if (enabledServices.length > 0) {
            const enabled = enabledServices.every(service => service.enabled === true);
            await this.createState(`${baseId}.enabled`, { name: 'Enabled', type: 'boolean', role: 'switch.enable', value: enabled, resource: enabledServices[0], write: true }, {
                hueResourceIds: enabledServices.map(service => service.id),
                hueResourceTypes: enabledServices.map(service => service.type),
            });
        }

        const light = services.find(service => service.type === 'light');
        if (light) {
            await this.createState(`${baseId}.command`, {
                name: 'Command', type: 'string', role: 'json', value: '', resource: light, write: true,
            });
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
                const on = this.asRecord(resource.on);
                if (typeof on?.on === 'boolean') await this.adapter.setStateAsync(`${baseId}.on`, on.on, true);
                const dimming = this.asRecord(resource.dimming);
                if (typeof dimming?.brightness === 'number') await this.adapter.setStateAsync(`${baseId}.dimming`, dimming.brightness, true);
                const colorTemperature = this.asRecord(resource.color_temperature);
                if (typeof colorTemperature?.mirek === 'number') await this.adapter.setStateAsync(`${baseId}.color_temperature`, colorTemperature.mirek, true);
                const color = this.asRecord(resource.color);
                const xy = this.asRecord(color?.xy);
                if (typeof xy?.x === 'number' && typeof xy?.y === 'number') await this.adapter.setStateAsync(`${baseId}.color`, JSON.stringify({ x: xy.x, y: xy.y }), true);
                break;
            }
            case 'motion': {
                const motion = this.asRecord(resource.motion);
                if (typeof motion?.motion === 'boolean') await this.adapter.setStateAsync(`${baseId}.motion`, motion.motion, true);
                break;
            }
            case 'temperature': {
                const temperature = this.asRecord(resource.temperature);
                if (typeof temperature?.temperature === 'number') await this.adapter.setStateAsync(`${baseId}.temperature`, temperature.temperature, true);
                break;
            }
            case 'light_level': {
                const light = this.asRecord(resource.light);
                if (typeof light?.light_level === 'number') await this.adapter.setStateAsync(`${baseId}.light_level`, light.light_level, true);
                break;
            }
            case 'device_power': {
                const powerState = this.asRecord(resource.power_state);
                if (typeof powerState?.battery_level === 'number') await this.adapter.setStateAsync(`${baseId}.battery_level`, powerState.battery_level, true);
                if (typeof powerState?.battery_state === 'string') await this.adapter.setStateAsync(`${baseId}.battery_state`, powerState.battery_state, true);
                break;
            }
            case 'zigbee_connectivity': if (typeof resource.status === 'string') await this.adapter.setStateAsync(`${baseId}.status`, resource.status, true); break;
        }
    }

    private async updateEnabledState(baseId: string, services: HueResource[]): Promise<void> {
        const enabledServices = services.filter(service => typeof service.enabled === 'boolean');
        if (enabledServices.length === 0) return;
        await this.adapter.setStateAsync(`${baseId}.enabled`, enabledServices.every(service => service.enabled === true), true);
    }

    private async syncLightStates(baseId: string, resource: HueResource): Promise<void> {
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

    private async syncMotionStates(baseId: string, resource: HueResource): Promise<void> { const motion = this.asRecord(resource.motion); if (typeof motion?.motion === 'boolean') await this.createState(`${baseId}.motion`, { name: 'Motion', type: 'boolean', role: 'sensor.motion', value: motion.motion, resource }); }
    private async syncTemperatureStates(baseId: string, resource: HueResource): Promise<void> { const temperature = this.asRecord(resource.temperature); if (typeof temperature?.temperature === 'number') await this.createState(`${baseId}.temperature`, { name: 'Temperature', type: 'number', role: 'value.temperature', value: temperature.temperature, unit: '°C', resource }); }
    private async syncLightLevelStates(baseId: string, resource: HueResource): Promise<void> { const light = this.asRecord(resource.light); if (typeof light?.light_level === 'number') await this.createState(`${baseId}.light_level`, { name: 'Light level', type: 'number', role: 'value', value: light.light_level, resource }); }
    private async syncDevicePowerStates(baseId: string, resource: HueResource): Promise<void> { const powerState = this.asRecord(resource.power_state); if (typeof powerState?.battery_level === 'number') await this.createState(`${baseId}.battery_level`, { name: 'Battery level', type: 'number', role: 'value.battery', value: powerState.battery_level, unit: '%', min: 0, max: 100, resource }); if (typeof powerState?.battery_state === 'string') await this.createState(`${baseId}.battery_state`, { name: 'Battery state', type: 'string', role: 'text', value: powerState.battery_state, resource }); }
    private async syncZigbeeConnectivityStates(baseId: string, resource: HueResource): Promise<void> { if (typeof resource.status === 'string') await this.createState(`${baseId}.status`, { name: 'Status', type: 'string', role: 'text', value: resource.status, resource }); }

    private async createState(id: string, definition: StateDefinition, nativeExtra: Record<string, unknown> = {}): Promise<void> {
        const common: ioBroker.StateCommon = { name: definition.name, type: definition.type, role: definition.role, read: true, write: definition.write ?? false };
        if (definition.unit !== undefined) common.unit = definition.unit;
        if (definition.min !== undefined) common.min = definition.min;
        if (definition.max !== undefined) common.max = definition.max;
        await this.adapter.extendObjectAsync(id, { type: 'state', common, native: { hueResourceId: definition.resource.id, hueResourceType: definition.resource.type, idV1: definition.resource.id_v1, ...nativeExtra } });
        await this.adapter.setStateAsync(id, definition.value, true);
    }

    private async createOptionalInfoState(id: string, name: string, value: string | undefined): Promise<void> { if (value !== undefined) await this.createInfoState(id, name, value); }
    private async createInfoState(id: string, name: string, value: string): Promise<void> { await this.adapter.extendObjectAsync(id, { type: 'state', common: { name, type: 'string', role: 'text', read: true, write: false }, native: {} }); await this.adapter.setStateAsync(id, value, true); }
    private getDeviceMetadata(device: HueDeviceResource): DeviceMetadata { const metadata = this.asRecord(device.metadata); const productData = this.asRecord(device.product_data); return { name: this.asString(metadata?.name) ?? device.id, model_id: this.asString(productData?.model_id), manufacturer_name: this.asString(productData?.manufacturer_name), product_name: this.asString(productData?.product_name), archetype: this.asString(metadata?.archetype) }; }
    private asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
    private asString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
    private asNumber(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }
}
