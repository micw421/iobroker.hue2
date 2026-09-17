import type { HueResource } from './hue-v2-client';
import type { HueDeviceResource, ResourceManager } from './resource-manager';

interface DeviceMetadata {
    name: string;
    modelId?: string;
    manufacturerName?: string;
    productName?: string;
    archetype?: string;
}

interface StateDefinition {
    name: string;
    type: ioBroker.CommonType;
    role: string;
    value: ioBroker.StateValue;
    unit?: string;
    min?: number;
    max?: number;
}

/**
 * Creates the ioBroker object model for Hue v2 resources.
 *
 * Object IDs deliberately use Hue UUIDs only. User-visible Hue names are kept
 * in common.name and can therefore change without changing ioBroker IDs.
 */
export class ObjectManager {
    public constructor(private readonly adapter: ioBroker.Adapter) {}

    public async syncDevices(resources: ResourceManager): Promise<void> {
        await this.adapter.extendObjectAsync('devices', {
            type: 'folder',
            common: {
                name: 'Hue devices',
            },
            native: {},
        });

        for (const device of resources.getDevices()) {
            await this.syncDevice(device, resources.getDeviceServices(device));
        }
    }

    private async syncDevice(device: HueDeviceResource, services: HueResource[]): Promise<void> {
        const baseId = `devices.${device.id}`;
        const metadata = this.getDeviceMetadata(device);

        await this.adapter.extendObjectAsync(baseId, {
            type: 'device',
            common: {
                name: metadata.name,
            },
            native: {
                hueResourceId: device.id,
                hueResourceType: device.type,
            },
        });

        await this.adapter.extendObjectAsync(`${baseId}.info`, {
            type: 'channel',
            common: {
                name: 'Information',
            },
            native: {},
        });

        await this.createInfoState(`${baseId}.info.name`, 'Name', metadata.name);
        await this.createOptionalInfoState(`${baseId}.info.modelId`, 'Model ID', metadata.modelId);
        await this.createOptionalInfoState(
            `${baseId}.info.manufacturerName`,
            'Manufacturer',
            metadata.manufacturerName,
        );
        await this.createOptionalInfoState(`${baseId}.info.productName`, 'Product name', metadata.productName);
        await this.createOptionalInfoState(`${baseId}.info.archetype`, 'Archetype', metadata.archetype);

        for (const service of services) {
            const serviceId = `${baseId}.${service.id}`;
            await this.adapter.extendObjectAsync(serviceId, {
                type: 'channel',
                common: {
                    name: service.type,
                },
                native: {
                    hueResourceId: service.id,
                    hueResourceType: service.type,
                    idV1: service.id_v1,
                },
            });

            await this.syncServiceStates(serviceId, service);
        }
    }

    private async syncServiceStates(baseId: string, resource: HueResource): Promise<void> {
        switch (resource.type) {
            case 'light':
                await this.syncLightStates(baseId, resource);
                break;
            case 'motion':
                await this.syncMotionStates(baseId, resource);
                break;
            case 'temperature':
                await this.syncTemperatureStates(baseId, resource);
                break;
            case 'light_level':
                await this.syncLightLevelStates(baseId, resource);
                break;
            case 'device_power':
                await this.syncDevicePowerStates(baseId, resource);
                break;
            case 'zigbee_connectivity':
                await this.syncZigbeeConnectivityStates(baseId, resource);
                break;
        }
    }

    private async syncLightStates(baseId: string, resource: HueResource): Promise<void> {
        const on = this.asRecord(resource.on);
        if (typeof on?.on === 'boolean') {
            await this.createState(`${baseId}.on`, {
                name: 'On',
                type: 'boolean',
                role: 'switch',
                value: on.on,
            });
        }

        const dimming = this.asRecord(resource.dimming);
        if (typeof dimming?.brightness === 'number') {
            await this.createState(`${baseId}.brightness`, {
                name: 'Brightness',
                type: 'number',
                role: 'level.dimmer',
                value: dimming.brightness,
                unit: '%',
                min: 0,
                max: 100,
            });
        }

        const colorTemperature = this.asRecord(resource.color_temperature);
        if (typeof colorTemperature?.mirek === 'number') {
            const schema = this.asRecord(colorTemperature.mirek_schema);
            await this.createState(`${baseId}.colorTemperature`, {
                name: 'Color temperature',
                type: 'number',
                role: 'level.color.temperature',
                value: colorTemperature.mirek,
                unit: 'mired',
                min: this.asNumber(schema?.mirek_minimum),
                max: this.asNumber(schema?.mirek_maximum),
            });
        }

        const color = this.asRecord(resource.color);
        const xy = this.asRecord(color?.xy);
        if (typeof xy?.x === 'number') {
            await this.createState(`${baseId}.colorX`, {
                name: 'Color X',
                type: 'number',
                role: 'value',
                value: xy.x,
                min: 0,
                max: 1,
            });
        }
        if (typeof xy?.y === 'number') {
            await this.createState(`${baseId}.colorY`, {
                name: 'Color Y',
                type: 'number',
                role: 'value',
                value: xy.y,
                min: 0,
                max: 1,
            });
        }
    }

    private async syncMotionStates(baseId: string, resource: HueResource): Promise<void> {
        if (typeof resource.enabled === 'boolean') {
            await this.createState(`${baseId}.enabled`, {
                name: 'Enabled',
                type: 'boolean',
                role: 'switch.enable',
                value: resource.enabled,
            });
        }

        const motion = this.asRecord(resource.motion);
        if (typeof motion?.motion === 'boolean') {
            await this.createState(`${baseId}.motion`, {
                name: 'Motion',
                type: 'boolean',
                role: 'sensor.motion',
                value: motion.motion,
            });
        }
    }

    private async syncTemperatureStates(baseId: string, resource: HueResource): Promise<void> {
        if (typeof resource.enabled === 'boolean') {
            await this.createState(`${baseId}.enabled`, {
                name: 'Enabled',
                type: 'boolean',
                role: 'switch.enable',
                value: resource.enabled,
            });
        }

        const temperature = this.asRecord(resource.temperature);
        if (typeof temperature?.temperature === 'number') {
            await this.createState(`${baseId}.temperature`, {
                name: 'Temperature',
                type: 'number',
                role: 'value.temperature',
                value: temperature.temperature,
                unit: '°C',
            });
        }
    }

    private async syncLightLevelStates(baseId: string, resource: HueResource): Promise<void> {
        if (typeof resource.enabled === 'boolean') {
            await this.createState(`${baseId}.enabled`, {
                name: 'Enabled',
                type: 'boolean',
                role: 'switch.enable',
                value: resource.enabled,
            });
        }

        const light = this.asRecord(resource.light);
        if (typeof light?.light_level === 'number') {
            await this.createState(`${baseId}.lightLevel`, {
                name: 'Light level',
                type: 'number',
                role: 'value',
                value: light.light_level,
            });
        }
    }

    private async syncDevicePowerStates(baseId: string, resource: HueResource): Promise<void> {
        const powerState = this.asRecord(resource.power_state);
        if (typeof powerState?.battery_level === 'number') {
            await this.createState(`${baseId}.battery`, {
                name: 'Battery',
                type: 'number',
                role: 'value.battery',
                value: powerState.battery_level,
                unit: '%',
                min: 0,
                max: 100,
            });
        }

        if (typeof powerState?.battery_state === 'string') {
            await this.createState(`${baseId}.batteryState`, {
                name: 'Battery state',
                type: 'string',
                role: 'text',
                value: powerState.battery_state,
            });
        }
    }

    private async syncZigbeeConnectivityStates(baseId: string, resource: HueResource): Promise<void> {
        if (typeof resource.status === 'string') {
            await this.createState(`${baseId}.status`, {
                name: 'Connectivity status',
                type: 'string',
                role: 'text',
                value: resource.status,
            });
        }
    }

    private async createState(id: string, definition: StateDefinition): Promise<void> {
        const common: ioBroker.StateCommon = {
            name: definition.name,
            type: definition.type,
            role: definition.role,
            read: true,
            write: false,
        };

        if (definition.unit !== undefined) {
            common.unit = definition.unit;
        }
        if (definition.min !== undefined) {
            common.min = definition.min;
        }
        if (definition.max !== undefined) {
            common.max = definition.max;
        }

        await this.adapter.extendObjectAsync(id, {
            type: 'state',
            common,
            native: {},
        });
        await this.adapter.setStateAsync(id, definition.value, true);
    }

    private async createOptionalInfoState(id: string, name: string, value: string | undefined): Promise<void> {
        if (value === undefined) {
            return;
        }
        await this.createInfoState(id, name, value);
    }

    private async createInfoState(id: string, name: string, value: string): Promise<void> {
        await this.adapter.extendObjectAsync(id, {
            type: 'state',
            common: {
                name,
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.adapter.setStateAsync(id, value, true);
    }

    private getDeviceMetadata(device: HueDeviceResource): DeviceMetadata {
        const metadata = this.asRecord(device.metadata);
        const productData = this.asRecord(device.product_data);

        return {
            name: this.asString(metadata?.name) ?? device.id,
            modelId: this.asString(productData?.model_id),
            manufacturerName: this.asString(productData?.manufacturer_name),
            productName: this.asString(productData?.product_name),
            archetype: this.asString(metadata?.archetype),
        };
    }

    private asRecord(value: unknown): Record<string, unknown> | undefined {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return undefined;
        }
        return value as Record<string, unknown>;
    }

    private asString(value: unknown): string | undefined {
        return typeof value === 'string' ? value : undefined;
    }

    private asNumber(value: unknown): number | undefined {
        return typeof value === 'number' ? value : undefined;
    }
}
