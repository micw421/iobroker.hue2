import axios, { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HueV2Client } from '../src/lib/hue-v2-client';

vi.mock('axios', async () => {
    const actual = await vi.importActual<typeof import('axios')>('axios');
    return {
        ...actual,
        default: {
            ...actual.default,
            create: vi.fn(),
        },
    };
});

function response(status: number, data: unknown = {}) {
    return {
        status,
        data,
        headers: {},
        statusText: String(status),
        config: { headers: {} },
    } as any;
}

function httpError(status: number): AxiosError {
    return new AxiosError(
        `HTTP ${status}`,
        undefined,
        undefined,
        undefined,
        response(status, { errors: [] }),
    );
}

describe('HueV2Client updateResource 429 retry', () => {
    const put = vi.fn();
    const get = vi.fn();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        vi.mocked(axios.create).mockReturnValue({ put, get } as any);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('retries HTTP 429 with configured backoff and eventually succeeds', async () => {
        put
            .mockRejectedValueOnce(httpError(429))
            .mockRejectedValueOnce(httpError(429))
            .mockResolvedValueOnce(response(200, { errors: [], data: [] }));

        const client = new HueV2Client({
            address: 'bridge.local',
            applicationKey: 'key',
            retry429DelaysMs: [250, 500],
        });

        const promise = client.updateResource('light', 'light-1', { on: { on: true } });

        expect(put).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(250);
        expect(put).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(500);
        await promise;

        expect(put).toHaveBeenCalledTimes(3);
    });

    it('throws after the configured 429 retries are exhausted', async () => {
        put.mockRejectedValue(httpError(429));

        const client = new HueV2Client({
            address: 'bridge.local',
            applicationKey: 'key',
            retry429DelaysMs: [100, 200],
        });

        const promise = client.updateResource('light', 'light-1', { dimming: { brightness: 50 } });
        const assertion = expect(promise).rejects.toThrow('Hue API request failed with HTTP 429');

        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(200);

        await assertion;
        expect(put).toHaveBeenCalledTimes(3);
    });

    it('does not retry non-429 HTTP errors', async () => {
        put.mockRejectedValueOnce(httpError(400));

        const client = new HueV2Client({
            address: 'bridge.local',
            applicationKey: 'key',
            retry429DelaysMs: [100, 200],
        });

        await expect(
            client.updateResource('light', 'light-1', { on: { on: true } }),
        ).rejects.toThrow('Hue API request failed with HTTP 400');

        expect(put).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not retry Hue API errors returned with HTTP 200', async () => {
        put.mockResolvedValueOnce(response(200, {
            errors: [{ description: 'invalid value' }],
            data: [],
        }));

        const client = new HueV2Client({
            address: 'bridge.local',
            applicationKey: 'key',
            retry429DelaysMs: [100],
        });

        await expect(
            client.updateResource('light', 'light-1', { dimming: { brightness: 200 } }),
        ).rejects.toThrow('invalid value');

        expect(put).toHaveBeenCalledTimes(1);
    });

    it('uses the default retry delays when none are configured', async () => {
        put
            .mockRejectedValueOnce(httpError(429))
            .mockResolvedValueOnce(response(200, { errors: [], data: [] }));

        const client = new HueV2Client({
            address: 'bridge.local',
            applicationKey: 'key',
        });

        const promise = client.updateResource('light', 'light-1', { on: { on: true } });

        await vi.advanceTimersByTimeAsync(249);
        expect(put).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await promise;

        expect(put).toHaveBeenCalledTimes(2);
    });
});
