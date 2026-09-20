import { describe, expect, it } from 'vitest';
import type { HueResource } from '../src/lib/hue-v2-client';
import { ResourceManager } from '../src/lib/resource-manager';

function resource(value: HueResource): HueResource {
    return value;
}

describe('ResourceManager', () => {
    it('indexes resources by id and type', () => {
        const manager = new ResourceManager([
            resource({ id: 'device-1', type: 'device' }),
            resource({ id: 'light-1', type: 'light' }),
            resource({ id: 'light-2', type: 'light' }),
        ]);

        expect(manager.size).toBe(3);
        expect(manager.getById('light-1')?.type).toBe('light');
        expect(manager.getByType('light').map(entry => entry.id)).toEqual(['light-1', 'light-2']);
    });

    it('maps services to their owning device', () => {
        const manager = new ResourceManager([
            resource({
                id: 'device-1',
                type: 'device',
                services: [
                    { rid: 'light-1', rtype: 'light' },
                    { rid: 'motion-1', rtype: 'motion' },
                ],
            }),
            resource({ id: 'light-1', type: 'light' }),
            resource({ id: 'motion-1', type: 'motion' }),
        ]);

        expect(manager.getDeviceIdForService('light-1')).toBe('device-1');
        expect(manager.getDeviceIdForService('motion-1')).toBe('device-1');
        expect(manager.getDeviceIdForService('unknown')).toBeUndefined();
    });

    it('resolves all existing services of a device', () => {
        const manager = new ResourceManager([
            resource({
                id: 'device-1',
                type: 'device',
                services: [
                    { rid: 'light-1', rtype: 'light' },
                    { rid: 'missing-service', rtype: 'motion' },
                ],
            }),
            resource({ id: 'light-1', type: 'light', on: { on: true } }),
        ]);

        expect(manager.getDeviceServices('device-1').map(entry => entry.id)).toEqual(['light-1']);
    });

    it('deep-merges partial event-stream updates', () => {
        const manager = new ResourceManager([
            resource({
                id: 'light-1',
                type: 'light',
                on: { on: true },
                dimming: { brightness: 20 },
                color_temperature: {
                    mirek: 250,
                    mirek_schema: {
                        mirek_minimum: 153,
                        mirek_maximum: 500,
                    },
                },
            }),
        ]);

        const merged = manager.patch(resource({
            id: 'light-1',
            type: 'light',
            dimming: { brightness: 65 },
            color_temperature: { mirek: 300 },
        }));

        expect(merged.on).toEqual({ on: true });
        expect(merged.dimming).toEqual({ brightness: 65 });
        expect(merged.color_temperature).toEqual({
            mirek: 300,
            mirek_schema: {
                mirek_minimum: 153,
                mirek_maximum: 500,
            },
        });
    });

    it('adds previously unknown resources received as updates', () => {
        const manager = new ResourceManager();

        const added = manager.patch(resource({
            id: 'temperature-1',
            type: 'temperature',
            temperature: { temperature: 21.5 },
        }));

        expect(added.id).toBe('temperature-1');
        expect(manager.getById('temperature-1')).toEqual(added);
        expect(manager.size).toBe(1);
    });

    it('rebuilds device-service relations after replaceAll', () => {
        const manager = new ResourceManager([
            resource({
                id: 'device-old',
                type: 'device',
                services: [{ rid: 'light-1', rtype: 'light' }],
            }),
            resource({ id: 'light-1', type: 'light' }),
        ]);

        manager.replaceAll([
            resource({
                id: 'device-new',
                type: 'device',
                services: [{ rid: 'light-2', rtype: 'light' }],
            }),
            resource({ id: 'light-2', type: 'light' }),
        ]);

        expect(manager.getDeviceIdForService('light-1')).toBeUndefined();
        expect(manager.getDeviceIdForService('light-2')).toBe('device-new');
        expect(manager.getById('device-old')).toBeUndefined();
    });

    it('updates service relations when a device resource changes', () => {
        const manager = new ResourceManager([
            resource({
                id: 'device-1',
                type: 'device',
                services: [{ rid: 'light-1', rtype: 'light' }],
            }),
            resource({ id: 'light-1', type: 'light' }),
            resource({ id: 'light-2', type: 'light' }),
        ]);

        manager.patch(resource({
            id: 'device-1',
            type: 'device',
            services: [{ rid: 'light-2', rtype: 'light' }],
        }));

        expect(manager.getDeviceIdForService('light-1')).toBeUndefined();
        expect(manager.getDeviceIdForService('light-2')).toBe('device-1');
    });
});
