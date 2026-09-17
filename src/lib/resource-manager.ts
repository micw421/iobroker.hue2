import type { HueResource } from './hue-v2-client';

export interface HueResourceReference {
    rid: string;
    rtype: string;
}

export interface HueDeviceResource extends HueResource {
    type: 'device';
    services?: HueResourceReference[];
}

/**
 * In-memory index of all Hue API v2 resources.
 *
 * Hue v2 resources are identified by stable UUIDs. The manager keeps the raw
 * resources intact and adds indexes/navigation helpers for the adapter layer.
 */
export class ResourceManager {
    private readonly resourcesById = new Map<string, HueResource>();
    private readonly resourcesByType = new Map<string, Map<string, HueResource>>();

    public constructor(resources: HueResource[] = []) {
        this.replaceAll(resources);
    }

    /** Replace the complete resource snapshot, e.g. after initial bridge sync. */
    public replaceAll(resources: HueResource[]): void {
        this.resourcesById.clear();
        this.resourcesByType.clear();

        for (const resource of resources) {
            this.set(resource);
        }
    }

    /** Insert or replace one resource. This will later also be used for event-stream updates. */
    public set(resource: HueResource): void {
        const previous = this.resourcesById.get(resource.id);

        if (previous && previous.type !== resource.type) {
            this.resourcesByType.get(previous.type)?.delete(previous.id);
        }

        this.resourcesById.set(resource.id, resource);

        let typeIndex = this.resourcesByType.get(resource.type);
        if (!typeIndex) {
            typeIndex = new Map<string, HueResource>();
            this.resourcesByType.set(resource.type, typeIndex);
        }
        typeIndex.set(resource.id, resource);
    }

    public getById(id: string): HueResource | undefined {
        return this.resourcesById.get(id);
    }

    public getByType(type: string): HueResource[] {
        return [...(this.resourcesByType.get(type)?.values() ?? [])];
    }

    public getDevices(): HueDeviceResource[] {
        return this.getByType('device').filter((resource): resource is HueDeviceResource => resource.type === 'device');
    }

    /** Resolve all services listed by a physical Hue device to their full resources. */
    public getDeviceServices(deviceOrId: HueDeviceResource | string): HueResource[] {
        const device = typeof deviceOrId === 'string' ? this.getDevice(deviceOrId) : deviceOrId;
        if (!device || !Array.isArray(device.services)) {
            return [];
        }

        const services: HueResource[] = [];
        for (const reference of device.services) {
            if (!this.isResourceReference(reference)) {
                continue;
            }
            const resource = this.resourcesById.get(reference.rid);
            if (resource) {
                services.push(resource);
            }
        }
        return services;
    }

    public getDevice(id: string): HueDeviceResource | undefined {
        const resource = this.resourcesById.get(id);
        return resource?.type === 'device' ? (resource as HueDeviceResource) : undefined;
    }

    public getTypeCounts(): Map<string, number> {
        return new Map(
            [...this.resourcesByType.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([type, resources]) => [type, resources.size]),
        );
    }

    public get size(): number {
        return this.resourcesById.size;
    }

    private isResourceReference(value: unknown): value is HueResourceReference {
        if (typeof value !== 'object' || value === null) {
            return false;
        }
        const reference = value as Record<string, unknown>;
        return typeof reference.rid === 'string' && typeof reference.rtype === 'string';
    }
}
