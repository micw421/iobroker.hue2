import type { HueResource } from './hue-v2-client';
import type { ResourceManager } from './resource-manager';

export interface HueResourceSource {
    getResources(): Promise<HueResource[]>;
}

export interface HueResourceSyncTarget {
    sync(resources: ResourceManager): Promise<void>;
}

/**
 * Performs a full Hue resource refresh after reconnect without replacing
 * the ResourceManager instance. Object managers can therefore update
 * existing ioBroker objects incrementally.
 */
export class HueResourceSynchronizer {
    public constructor(
        private readonly source: HueResourceSource,
        private readonly resources: ResourceManager,
        private readonly targets: HueResourceSyncTarget[],
    ) {}

    public async resync(): Promise<number> {
        const freshResources = await this.source.getResources();
        this.resources.replaceAll(freshResources);

        for (const target of this.targets) {
            await target.sync(this.resources);
        }

        return this.resources.size;
    }
}
