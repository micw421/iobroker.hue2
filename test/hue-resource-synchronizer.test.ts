import { describe, expect, it, vi } from 'vitest';
import type { HueResource } from '../src/lib/hue-v2-client';
import { HueResourceSynchronizer } from '../src/lib/hue-resource-synchronizer';
import { ResourceManager } from '../src/lib/resource-manager';

function resource(value: HueResource): HueResource {
    return value;
}

describe('HueResourceSynchronizer', () => {
    it('replaces the in-memory resources and runs all sync targets', async () => {
        const resources = new ResourceManager([
            resource({ id: 'old-device', type: 'device' }),
        ]);

        const source = {
            getResources: vi.fn().mockResolvedValue([
                resource({
                    id: 'device-1',
                    type: 'device',
                    services: [{ rid: 'light-1', rtype: 'light' }],
                }),
                resource({ id: 'light-1', type: 'light', on: { on: true } }),
            ]),
        };

        const calls: string[] = [];
        const firstTarget = {
            async sync(manager: ResourceManager) {
                calls.push(`first:${manager.size}`);
                expect(manager.getById('device-1')).toBeDefined();
                expect(manager.getById('old-device')).toBeUndefined();
            },
        };
        const secondTarget = {
            async sync(manager: ResourceManager) {
                calls.push(`second:${manager.size}`);
                expect(manager.getDeviceIdForService('light-1')).toBe('device-1');
            },
        };

        const synchronizer = new HueResourceSynchronizer(
            source,
            resources,
            [firstTarget, secondTarget],
        );

        const count = await synchronizer.resync();

        expect(count).toBe(2);
        expect(source.getResources).toHaveBeenCalledTimes(1);
        expect(calls).toEqual(['first:2', 'second:2']);
    });

    it('does not run sync targets when fetching fresh resources fails', async () => {
        const resources = new ResourceManager([
            resource({ id: 'device-1', type: 'device' }),
        ]);

        const source = {
            getResources: vi.fn().mockRejectedValue(new Error('Bridge unavailable')),
        };
        const target = {
            sync: vi.fn(),
        };

        const synchronizer = new HueResourceSynchronizer(source, resources, [target]);

        await expect(synchronizer.resync()).rejects.toThrow('Bridge unavailable');
        expect(target.sync).not.toHaveBeenCalled();
        expect(resources.getById('device-1')).toBeDefined();
    });

    it('keeps the same ResourceManager instance during resync', async () => {
        const resources = new ResourceManager();
        const seenManagers: ResourceManager[] = [];

        const synchronizer = new HueResourceSynchronizer(
            {
                async getResources() {
                    return [resource({ id: 'light-1', type: 'light' })];
                },
            },
            resources,
            [{
                async sync(manager) {
                    seenManagers.push(manager);
                },
            }],
        );

        await synchronizer.resync();

        expect(seenManagers).toEqual([resources]);
        expect(resources.getById('light-1')).toBeDefined();
    });

    it('runs sync targets sequentially', async () => {
        const resources = new ResourceManager();
        const order: string[] = [];

        const synchronizer = new HueResourceSynchronizer(
            {
                async getResources() {
                    return [];
                },
            },
            resources,
            [
                {
                    async sync() {
                        order.push('first-start');
                        await Promise.resolve();
                        order.push('first-end');
                    },
                },
                {
                    async sync() {
                        order.push('second');
                    },
                },
            ],
        );

        await synchronizer.resync();

        expect(order).toEqual(['first-start', 'first-end', 'second']);
    });
});
