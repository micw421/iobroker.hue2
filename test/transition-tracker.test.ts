import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransitionTracker } from '../src/lib/transition-tracker';

describe('TransitionTracker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('sets all states active and clears them after the duration', async () => {
        const values = new Map<string, boolean>();
        const tracker = new TransitionTracker((id, value) => {
            values.set(id, value);
        });

        await tracker.start(['rooms.room-1.transition_active', 'devices.device-1.transition_active'], 5000);

        expect(values.get('rooms.room-1.transition_active')).toBe(true);
        expect(values.get('devices.device-1.transition_active')).toBe(true);

        await vi.advanceTimersByTimeAsync(5000);

        expect(values.get('rooms.room-1.transition_active')).toBe(false);
        expect(values.get('devices.device-1.transition_active')).toBe(false);
    });

    it('uses one operation for duplicate state IDs', async () => {
        const writes: Array<[string, boolean]> = [];
        const tracker = new TransitionTracker((id, value) => {
            writes.push([id, value]);
        });

        await tracker.start(['devices.device-1.transition_active', 'devices.device-1.transition_active'], 1000);

        expect(writes).toEqual([
            ['devices.device-1.transition_active', true],
        ]);

        await vi.advanceTimersByTimeAsync(1000);

        expect(writes).toEqual([
            ['devices.device-1.transition_active', true],
            ['devices.device-1.transition_active', false],
        ]);
    });

    it('cancels an active transition immediately', async () => {
        const values = new Map<string, boolean>();
        const tracker = new TransitionTracker((id, value) => {
            values.set(id, value);
        });

        await tracker.start(['devices.device-1.transition_active'], 5000);
        await tracker.cancel(['devices.device-1.transition_active']);

        expect(values.get('devices.device-1.transition_active')).toBe(false);

        await vi.advanceTimersByTimeAsync(5000);
        expect(values.get('devices.device-1.transition_active')).toBe(false);
    });

    it('does not let an older transition clear a newer one on the same state', async () => {
        const values = new Map<string, boolean>();
        const tracker = new TransitionTracker((id, value) => {
            values.set(id, value);
        });

        await tracker.start(['devices.device-1.transition_active'], 5000);

        await vi.advanceTimersByTimeAsync(1000);
        await tracker.start(['devices.device-1.transition_active'], 10000);

        await vi.advanceTimersByTimeAsync(4000);
        expect(values.get('devices.device-1.transition_active')).toBe(true);

        await vi.advanceTimersByTimeAsync(6000);
        expect(values.get('devices.device-1.transition_active')).toBe(false);
    });

    it('preserves overlapping group/device transitions independently', async () => {
        const values = new Map<string, boolean>();
        const tracker = new TransitionTracker((id, value) => {
            values.set(id, value);
        });

        await tracker.start([
            'rooms.room-1.transition_active',
            'devices.device-1.transition_active',
            'devices.device-2.transition_active',
        ], 5000);

        await vi.advanceTimersByTimeAsync(1000);

        await tracker.start([
            'zones.zone-1.transition_active',
            'devices.device-2.transition_active',
        ], 10000);

        await vi.advanceTimersByTimeAsync(4000);

        expect(values.get('rooms.room-1.transition_active')).toBe(false);
        expect(values.get('devices.device-1.transition_active')).toBe(false);
        expect(values.get('devices.device-2.transition_active')).toBe(true);
        expect(values.get('zones.zone-1.transition_active')).toBe(true);

        await vi.advanceTimersByTimeAsync(6000);

        expect(values.get('devices.device-2.transition_active')).toBe(false);
        expect(values.get('zones.zone-1.transition_active')).toBe(false);
    });

    it('handles duration zero without leaving an active transition', async () => {
        const values = new Map<string, boolean>();
        const tracker = new TransitionTracker((id, value) => {
            values.set(id, value);
        });

        await tracker.start(['devices.device-1.transition_active'], 0);

        expect(values.get('devices.device-1.transition_active')).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clears timers on stop without emitting delayed false writes', async () => {
        const writes: Array<[string, boolean]> = [];
        const tracker = new TransitionTracker((id, value) => {
            writes.push([id, value]);
        });

        await tracker.start(['devices.device-1.transition_active'], 5000);
        tracker.stop();

        await vi.advanceTimersByTimeAsync(5000);

        expect(writes).toEqual([
            ['devices.device-1.transition_active', true],
        ]);
    });
});
