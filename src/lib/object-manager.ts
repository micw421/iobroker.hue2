import type * as utils from '@iobroker/adapter-core';
import type { HueResource } from './hue-v2-client';
import type { HueDeviceResource, ResourceManager } from './resource-manager';

interface DeviceMetadata {
    name: string;
    modelId?: string;
    manufacturerName?: string;
    productName?: string;
    archetype?: string;
}

/**
 * Creates the ioBroker object model for Hue v2 resources.
 *
 * Object IDs deliberately use Hue UUIDs only. User-visible Hue names are kept
 * in common.name and can therefore change without changing ioBroker IDs.
 */
export class ObjectManager {
    public constructor(private readonly adapter: utils.Adapter) {}

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
            await this.adapter.extendObjectAsync(`${baseId}.${service.id}`, {
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
        }
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
}
