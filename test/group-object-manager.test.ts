import { describe, expect, it } from 'vitest';
import type { HueResource } from '../src/lib/hue-v2-client';
import { GroupObjectManager } from '../src/lib/group-object-manager';
import { ResourceManager } from '../src/lib/resource-manager';

function resource(value: HueResource): HueResource {
    return value;
}

function createAdapterMock() {
    const objects = new Map<string, any>();
    const states = new Map<string, unknown>();
    const foreignObjects = new Map<string, any>();
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
        async getForeignObjectAsync(id: string) {
            return foreignObjects.get(id) ?? null;
        },
        async setForeignObjectAsync(id: string, object: any) {
            foreignObjects.set(id, object);
        },
        async getForeignObjectsAsync(pattern: string) {
            const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
            const result: Record<string, any> = {};
            for (const [id, object] of objects) {
                const fullId = id.startsWith('hue2.0.') ? id : `hue2.0.${id}`;
                if (fullId.startsWith(prefix)) result[fullId] = object;
            }
            for (const [id, object] of foreignObjects) {
                if (id.startsWith(prefix)) result[id] = object;
            }
            return result;
        },
        async delForeignObjectAsync(id: string) {
            deleted.push(id);
            foreignObjects.delete(id);
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

    return { adapter: adapter as any, objects, states, foreignObjects, deleted };
}

function createGroupResources(type: 'room' | 'zone', allOn: boolean): ResourceManager {
    return new ResourceManager([
        resource({
            id: 'device-1',
            type: 'device',
            metadata: { name: 'Ceiling' },
            services: [{ rid: 'light-1', rtype: 'light' }],
        }),
        resource({
            id: 'device-2',
            type: 'device',
            metadata: { name: 'Floor lamp' },
            services: [{ rid: 'light-2', rtype: 'light' }],
        }),
        resource({
            id: 'light-1',
            type: 'light',
            on: { on: true },
            dimming: { brightness: 60 },
        }),
        resource({
            id: 'light-2',
            type: 'light',
            on: { on: allOn },
            dimming: { brightness: 40 },
        }),
        resource({
            id: 'grouped-light-1',
            type: 'grouped_light',
            on: { on: true },
            dimming: { brightness: 50 },
        }),
        resource({
            id: `${type}-1`,
            type,
            metadata: type === 'room'
                ? { name: 'Living room', archetype: 'living_room' }
                : { name: 'Downstairs' },
            children: [
                { rid: 'device-1', rtype: 'device' },
                { rid: 'device-2', rtype: 'device' },
            ],
            services: [{ rid: 'grouped-light-1', rtype: 'grouped_light' }],
        }),
    ]);
}

describe('GroupObjectManager', () => {
    it('creates room light membership using device UUIDs and names', async () => {
        const { adapter, objects, states } = createAdapterMock();
        const manager = new GroupObjectManager(adapter);

        await manager.sync(createGroupResources('room', true));

        expect(objects.get('rooms.room-1.lights.device-1')?.common.name).toBe('Ceiling');
        expect(objects.get('rooms.room-1.lights.device-2')?.common.name).toBe('Floor lamp');
        expect(states.get('rooms.room-1.lights.device-1')).toBe('Ceiling');
        expect(states.get('rooms.room-1.lights.device-2')).toBe('Floor lamp');
    });

    it('exposes the Hue room archetype', async () => {
        const { adapter, states } = createAdapterMock();

        await new GroupObjectManager(adapter).sync(createGroupResources('room', true));

        expect(states.get('rooms.room-1.archetype')).toBe('living_room');
    });

    it('mirrors Hue rooms to ioBroker room enums', async () => {
        const { adapter, foreignObjects } = createAdapterMock();

        await new GroupObjectManager(adapter).sync(createGroupResources('room', true));

        const room = foreignObjects.get('enum.rooms.hue2_room-1');
        expect(room?.type).toBe('enum');
        expect(room?.common.name).toBe('Living room');
        expect(room?.common.members).toEqual([
            'hue2.0.rooms.room-1',
            'hue2.0.devices.device-1',
            'hue2.0.devices.device-2',
        ]);
        expect(room?.native.hue2Managed).toBe(true);
        expect(room?.native.hueRoomResourceId).toBe('room-1');
    });

    it('sets all_on true only when every room light is on', async () => {
        const first = createAdapterMock();
        await new GroupObjectManager(first.adapter).sync(createGroupResources('room', true));
        expect(first.states.get('rooms.room-1.all_on')).toBe(true);

        const second = createAdapterMock();
        await new GroupObjectManager(second.adapter).sync(createGroupResources('room', false));
        expect(second.states.get('rooms.room-1.all_on')).toBe(false);
    });

    it('applies the same all_on and light membership logic to zones', async () => {
        const { adapter, states } = createAdapterMock();
        const manager = new GroupObjectManager(adapter);

        await manager.sync(createGroupResources('zone', false));

        expect(states.get('zones.zone-1.all_on')).toBe(false);
        expect(states.get('zones.zone-1.lights.device-1')).toBe('Ceiling');
        expect(states.get('zones.zone-1.lights.device-2')).toBe('Floor lamp');
    });

    it('updates all_on when a member light changes', async () => {
        const { adapter, states } = createAdapterMock();
        const resources = createGroupResources('room', true);
        const manager = new GroupObjectManager(adapter);

        await manager.sync(resources);
        expect(states.get('rooms.room-1.all_on')).toBe(true);

        const update = resources.patch(resource({
            id: 'light-2',
            type: 'light',
            on: { on: false },
        }));
        await manager.updateResource(resources, update);

        expect(states.get('rooms.room-1.all_on')).toBe(false);
    });

    it('derives a shared color-temperature range from all member lights', async () => {
        const { adapter, objects } = createAdapterMock();
        const resources = new ResourceManager([
            resource({
                id: 'device-1',
                type: 'device',
                metadata: { name: 'Warm light' },
                services: [{ rid: 'light-1', rtype: 'light' }],
            }),
            resource({
                id: 'device-2',
                type: 'device',
                metadata: { name: 'Wide range light' },
                services: [{ rid: 'light-2', rtype: 'light' }],
            }),
            resource({
                id: 'light-1',
                type: 'light',
                color_temperature: {
                    mirek: 300,
                    mirek_schema: { mirek_minimum: 200, mirek_maximum: 454 },
                },
            }),
            resource({
                id: 'light-2',
                type: 'light',
                color_temperature: {
                    mirek: 250,
                    mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 },
                },
            }),
            resource({
                id: 'grouped-light-1',
                type: 'grouped_light',
                on: { on: true },
                dimming: { brightness: 50 },
                color_temperature: {},
            }),
            resource({
                id: 'room-1',
                type: 'room',
                metadata: { name: 'Living room' },
                children: [
                    { rid: 'device-1', rtype: 'device' },
                    { rid: 'device-2', rtype: 'device' },
                ],
                services: [{ rid: 'grouped-light-1', rtype: 'grouped_light' }],
            }),
        ]);

        await new GroupObjectManager(adapter).sync(resources);

        const ct = objects.get('rooms.room-1.color_temperature');
        expect(ct?.common.min).toBe(200);
        expect(ct?.common.max).toBe(454);
    });
});
