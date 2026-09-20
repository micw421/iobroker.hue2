import { describe, expect, it } from 'vitest';
import type { HueResource } from '../src/lib/hue-v2-client';
import { EntertainmentObjectManager } from '../src/lib/entertainment-object-manager';
import { ResourceManager } from '../src/lib/resource-manager';

function resource(value: HueResource): HueResource {
    return value;
}

function createAdapterMock() {
    const objects = new Map<string, any>();
    const states = new Map<string, unknown>();
    const deleted: string[] = [];

    const adapter = {
        namespace: 'hue2.0',
        async extendObjectAsync(id: string, object: any) {
            objects.set(id, {
                ...(objects.get(id) ?? {}),
                ...object,
                common: {
                    ...(objects.get(id)?.common ?? {}),
                    ...(object.common ?? {}),
                },
                native: {
                    ...(objects.get(id)?.native ?? {}),
                    ...(object.native ?? {}),
                },
            });
        },
        async setStateAsync(id: string, value: unknown) {
            states.set(id, value);
        },
        async getObjectAsync(id: string) {
            return objects.get(id) ?? null;
        },
        async getForeignObjectsAsync(pattern: string) {
            const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
            const result: Record<string, any> = {};
            for (const [id, object] of objects) {
                const fullId = id.startsWith('hue2.0.') ? id : `hue2.0.${id}`;
                if (fullId.startsWith(prefix)) result[fullId] = object;
            }
            return result;
        },
        async delObjectAsync(id: string, options?: { recursive?: boolean }) {
            deleted.push(id);
            if (options?.recursive) {
                for (const key of [...objects.keys()]) {
                    if (key === id || key.startsWith(`${id}.`)) objects.delete(key);
                }
                for (const key of [...states.keys()]) {
                    if (key === id || key.startsWith(`${id}.`)) states.delete(key);
                }
            } else {
                objects.delete(id);
                states.delete(id);
            }
        },
    };

    return { adapter: adapter as any, objects, states, deleted };
}

function createResources(): ResourceManager {
    return new ResourceManager([
        resource({
            id: 'device-1',
            type: 'device',
            metadata: { name: 'TV left' },
            services: [
                { rid: 'light-1', rtype: 'light' },
                { rid: 'entertainment-1', rtype: 'entertainment' },
            ],
        }),
        resource({
            id: 'device-2',
            type: 'device',
            metadata: { name: 'TV right' },
            services: [
                { rid: 'light-2', rtype: 'light' },
                { rid: 'entertainment-2', rtype: 'entertainment' },
            ],
        }),
        resource({ id: 'light-1', type: 'light' }),
        resource({ id: 'light-2', type: 'light' }),
        resource({ id: 'entertainment-1', type: 'entertainment' }),
        resource({ id: 'entertainment-2', type: 'entertainment' }),
        resource({
            id: 'config-1',
            type: 'entertainment_configuration',
            metadata: { name: 'TV area' },
            status: 'inactive',
            light_services: [
                { rid: 'light-1', rtype: 'light' },
            ],
            channels: [
                {
                    channel_id: 0,
                    members: [
                        {
                            service: { rid: 'entertainment-2', rtype: 'entertainment' },
                            index: 0,
                        },
                    ],
                },
            ],
        }),
    ]);
}

describe('EntertainmentObjectManager', () => {
    it('creates name, active and start/stop states', async () => {
        const { adapter, objects, states } = createAdapterMock();
        const manager = new EntertainmentObjectManager(adapter);

        await manager.sync(createResources());

        expect(states.get('entertainment.config-1.name')).toBe('TV area');
        expect(states.get('entertainment.config-1.active')).toBe(false);

        expect(objects.get('entertainment.config-1.start')?.common.role).toBe('button');
        expect(objects.get('entertainment.config-1.stop')?.common.role).toBe('button');
        expect(objects.get('entertainment.config-1.start')?.common.write).toBe(true);
        expect(objects.get('entertainment.config-1.stop')?.common.write).toBe(true);
        expect(states.get('entertainment.config-1.start')).toBe(false);
        expect(states.get('entertainment.config-1.stop')).toBe(false);
    });

    it('lists lights referenced through light_services and channels', async () => {
        const { adapter, states } = createAdapterMock();

        await new EntertainmentObjectManager(adapter).sync(createResources());

        expect(states.get('entertainment.config-1.lights.device-1')).toBe('TV left');
        expect(states.get('entertainment.config-1.lights.device-2')).toBe('TV right');
    });

    it('updates active when the entertainment configuration status changes', async () => {
        const { adapter, states } = createAdapterMock();
        const resources = createResources();
        const manager = new EntertainmentObjectManager(adapter);

        await manager.sync(resources);

        const update = resources.patch(resource({
            id: 'config-1',
            type: 'entertainment_configuration',
            status: 'active',
        }));
        await manager.updateResource(resources, update);

        expect(states.get('entertainment.config-1.active')).toBe(true);
    });

    it('removes obsolete light membership without recreating the configuration', async () => {
        const { adapter, objects, states, deleted } = createAdapterMock();
        const resources = createResources();
        const manager = new EntertainmentObjectManager(adapter);

        await manager.sync(resources);
        expect(states.get('entertainment.config-1.lights.device-2')).toBe('TV right');

        resources.replaceAll([
            resource({
                id: 'device-1',
                type: 'device',
                metadata: { name: 'TV left' },
                services: [
                    { rid: 'light-1', rtype: 'light' },
                    { rid: 'entertainment-1', rtype: 'entertainment' },
                ],
            }),
            resource({ id: 'light-1', type: 'light' }),
            resource({ id: 'entertainment-1', type: 'entertainment' }),
            resource({
                id: 'config-1',
                type: 'entertainment_configuration',
                metadata: { name: 'TV area' },
                status: 'inactive',
                light_services: [{ rid: 'light-1', rtype: 'light' }],
                channels: [],
            }),
        ]);

        await manager.sync(resources);

        expect(objects.has('entertainment.config-1')).toBe(true);
        expect(states.get('entertainment.config-1.lights.device-1')).toBe('TV left');
        expect(states.has('entertainment.config-1.lights.device-2')).toBe(false);
        expect(deleted).toContain('entertainment.config-1.lights.device-2');
        expect(deleted).not.toContain('entertainment.config-1');
    });

    it('removes entertainment configurations that no longer exist', async () => {
        const { adapter, objects, deleted } = createAdapterMock();
        const manager = new EntertainmentObjectManager(adapter);

        await manager.sync(createResources());
        expect(objects.has('entertainment.config-1')).toBe(true);

        await manager.sync(new ResourceManager());

        expect(objects.has('entertainment')).toBe(false);
        expect(deleted).toContain('entertainment');
    });
});
