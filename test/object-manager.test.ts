import { describe, expect, it } from 'vitest';
import type { HueResource } from '../src/lib/hue-v2-client';
import { ObjectManager } from '../src/lib/object-manager';
import { ResourceManager } from '../src/lib/resource-manager';

function resource(value: HueResource): HueResource {
    return value;
}

function createAdapterMock() {
    const objects = new Map<string, any>();
    const states = new Map<string, unknown>();

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
        async getForeignObjectsAsync() {
            return {};
        },
        async delObjectAsync() {},
    };

    return { adapter: adapter as any, objects, states };
}

describe('ObjectManager identify', () => {
    it('creates identify as a writable button mapped to the Hue device resource', async () => {
        const { adapter, objects, states } = createAdapterMock();
        const resources = new ResourceManager([
            resource({
                id: 'device-1',
                type: 'device',
                metadata: { name: 'Living room 1' },
                services: [{ rid: 'light-1', rtype: 'light' }],
            }),
            resource({
                id: 'light-1',
                type: 'light',
                on: { on: true },
                dimming: { brightness: 50 },
            }),
        ]);

        await new ObjectManager(adapter).syncDevices(resources);

        const identify = objects.get('devices.device-1.identify');

        expect(identify?.type).toBe('state');
        expect(identify?.common.role).toBe('button');
        expect(identify?.common.write).toBe(true);
        expect(identify?.native.hueResourceId).toBe('device-1');
        expect(identify?.native.hueResourceType).toBe('device');
        expect(states.get('devices.device-1.identify')).toBe(false);
        expect(states.has('devices.device-1.info.name')).toBe(false);
    });

    it('adds a Zigbee2MQTT product image for known Hue model IDs', async () => {
        const { adapter, objects } = createAdapterMock();
        const resources = new ResourceManager([
            resource({
                id: 'device-1',
                type: 'device',
                metadata: { name: 'GU10' },
                product_data: { model_id: 'LTG002' },
                services: [{ rid: 'light-1', rtype: 'light' }],
            }),
            resource({
                id: 'light-1',
                type: 'light',
                on: { on: true },
            }),
        ]);

        await new ObjectManager(adapter).syncDevices(resources);

        expect(objects.get('devices.device-1')?.common.icon).toBe(
            'https://www.zigbee2mqtt.io/images/devices/929001953301.png',
        );
    });

    it('leaves the icon unset for unknown Hue model IDs', async () => {
        const { adapter, objects } = createAdapterMock();
        const resources = new ResourceManager([
            resource({
                id: 'device-1',
                type: 'device',
                metadata: { name: 'Unknown' },
                product_data: { model_id: 'UNKNOWN' },
                services: [],
            }),
        ]);

        await new ObjectManager(adapter).syncDevices(resources);

        expect(objects.get('devices.device-1')?.common.icon).toBeUndefined();
    });

    it('does not create identify for devices without a light service', async () => {
        const { adapter, objects } = createAdapterMock();
        const resources = new ResourceManager([
            resource({
                id: 'device-1',
                type: 'device',
                metadata: { name: 'Sensor' },
                services: [{ rid: 'motion-1', rtype: 'motion' }],
            }),
            resource({
                id: 'motion-1',
                type: 'motion',
                motion: { motion: false },
            }),
        ]);

        await new ObjectManager(adapter).syncDevices(resources);

        expect(objects.has('devices.device-1.identify')).toBe(false);
    });
});
