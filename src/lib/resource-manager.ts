import type { HueResource } from './hue-v2-client';

export interface HueResourceReference {
    rid: string;
    rtype: string;
}

export interface HueDeviceResource extends HueResource {
    type: 'device';
    services?: HueResourceReference[];
}

/** In-memory index and relationship map for Hue API v2 resources. */
export class ResourceManager {
    private readonly resourcesById = new Map<string, HueResource>();
    private readonly resourcesByType = new Map<string, Map<string, HueResource>>();
    private readonly deviceIdByServiceId = new Map<string, string>();

    public constructor(resources: HueResource[] = []) {
        this.replaceAll(resources);
    }

    public replaceAll(resources: HueResource[]): void {
        this.resourcesById.clear();
        this.resourcesByType.clear();
        this.deviceIdByServiceId.clear();

        for (const resource of resources) {
            this.set(resource, false);
        }
        this.rebuildDeviceServiceIndex();
    }

    /** Insert or replace one complete resource. */
    public set(resource: HueResource, rebuildRelations = true): void {
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

        if (rebuildRelations && (resource.type === 'device' || previous?.type === 'device')) {
            this.rebuildDeviceServiceIndex();
        }
    }

    /** Merge a partial Hue event-stream update into the current full resource. */
    public patch(update: HueResource): HueResource {
        const current = this.resourcesById.get(update.id);
        if (!current) {
            this.set(update);
            return update;
        }

        const merged = this.deepMerge(current, update) as HueResource;
        this.set(merged);
        return merged;
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

    public getDevice(id: string): HueDeviceResource | undefined {
        const resource = this.resourcesById.get(id);
        return resource?.type === 'device' ? (resource as HueDeviceResource) : undefined;
    }

    public getDeviceIdForService(serviceId: string): string | undefined {
        return this.deviceIdByServiceId.get(serviceId);
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

    private rebuildDeviceServiceIndex(): void {
        this.deviceIdByServiceId.clear();
        for (const device of this.getDevices()) {
            if (!Array.isArray(device.services)) {
                continue;
            }
            for (const reference of device.services) {
                if (this.isResourceReference(reference)) {
                    this.deviceIdByServiceId.set(reference.rid, device.id);
                }
            }
        }
    }

    private deepMerge(target: unknown, source: unknown): unknown {
        if (!this.isPlainObject(target) || !this.isPlainObject(source)) {
            return source;
        }

        const result: Record<string, unknown> = { ...target };
        for (const [key, sourceValue] of Object.entries(source)) {
            const targetValue = result[key];
            result[key] = this.isPlainObject(targetValue) && this.isPlainObject(sourceValue)
                ? this.deepMerge(targetValue, sourceValue)
                : sourceValue;
        }
        return result;
    }

    private isPlainObject(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private isResourceReference(value: unknown): value is HueResourceReference {
        if (typeof value !== 'object' || value === null) {
            return false;
        }
        const reference = value as Record<string, unknown>;
        return typeof reference.rid === 'string' && typeof reference.rtype === 'string';
    }
}
