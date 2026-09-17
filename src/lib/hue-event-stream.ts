import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { HueResource } from './hue-v2-client';

export interface HueEventEnvelope {
    creationtime?: string;
    id?: string;
    type?: string;
    data?: HueResource[];
}

export interface HueEventStreamOptions {
    address: string;
    applicationKey: string;
    reconnectDelayMs?: number;
}

export interface HueEventStreamHandlers {
    onUpdate: (resource: HueResource) => void | Promise<void>;
    onConnected?: () => void;
    onDisconnected?: () => void;
    onError?: (error: Error) => void;
}

/**
 * Lightweight client for the Hue API v2 Server-Sent Event stream.
 * No EventSource dependency is needed and the Bridge's self-signed TLS
 * certificate is handled the same way as in the REST client.
 */
export class HueEventStream {
    private readonly url: URL;
    private readonly applicationKey: string;
    private readonly reconnectDelayMs: number;
    private readonly agent = new https.Agent({ rejectUnauthorized: false });
    private request?: ClientRequest;
    private response?: IncomingMessage;
    private reconnectTimer?: NodeJS.Timeout;
    private stopped = true;
    private handlers?: HueEventStreamHandlers;
    private eventQueue: Promise<void> = Promise.resolve();

    public constructor(options: HueEventStreamOptions) {
        this.url = new URL(`https://${options.address}/eventstream/clip/v2`);
        this.applicationKey = options.applicationKey;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 3_000;
    }

    public start(handlers: HueEventStreamHandlers): void {
        this.handlers = handlers;
        this.stopped = false;
        this.connect();
    }

    public stop(): void {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.response?.destroy();
        this.response = undefined;
        this.request?.destroy();
        this.request = undefined;
        this.agent.destroy();
    }

    private connect(): void {
        if (this.stopped) {
            return;
        }

        let buffer = '';
        let disconnected = false;

        const disconnect = (error?: Error): void => {
            if (disconnected) {
                return;
            }
            disconnected = true;
            this.response = undefined;
            this.request = undefined;
            if (error) {
                this.handlers?.onError?.(error);
            }
            this.handlers?.onDisconnected?.();
            this.scheduleReconnect();
        };

        this.request = https.get(
            this.url,
            {
                agent: this.agent,
                headers: {
                    Accept: 'text/event-stream',
                    'hue-application-key': this.applicationKey,
                },
            },
            response => {
                this.response = response;

                if (response.statusCode !== 200) {
                    response.resume();
                    disconnect(new Error(`Hue event stream returned HTTP ${response.statusCode ?? 'unknown'}`));
                    return;
                }

                response.setEncoding('utf8');
                this.handlers?.onConnected?.();

                response.on('data', (chunk: string) => {
                    buffer += chunk;
                    buffer = this.consumeSseFrames(buffer);
                });
                response.on('end', () => disconnect());
                response.on('close', () => disconnect());
                response.on('error', error => disconnect(error));
            },
        );

        this.request.on('error', error => disconnect(error));
    }

    /** Parse complete SSE frames and return the unconsumed tail. */
    private consumeSseFrames(buffer: string): string {
        const normalized = buffer.replace(/\r\n/g, '\n');
        const frames = normalized.split('\n\n');
        const tail = frames.pop() ?? '';

        for (const frame of frames) {
            const dataLines = frame
                .split('\n')
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart());

            if (dataLines.length === 0) {
                continue;
            }

            try {
                const payload = JSON.parse(dataLines.join('\n')) as unknown;
                this.enqueuePayload(payload);
            } catch (error) {
                this.handlers?.onError?.(
                    error instanceof Error ? error : new Error(`Could not parse Hue event: ${String(error)}`),
                );
            }
        }

        return tail;
    }

    private enqueuePayload(payload: unknown): void {
        if (!Array.isArray(payload)) {
            return;
        }

        this.eventQueue = this.eventQueue
            .then(async () => {
                for (const rawEnvelope of payload) {
                    if (!this.isEnvelope(rawEnvelope) || rawEnvelope.type !== 'update' || !Array.isArray(rawEnvelope.data)) {
                        continue;
                    }
                    for (const update of rawEnvelope.data) {
                        if (this.isHueResourceUpdate(update)) {
                            await this.handlers?.onUpdate(update);
                        }
                    }
                }
            })
            .catch(error => {
                this.handlers?.onError?.(error instanceof Error ? error : new Error(String(error)));
            });
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.reconnectTimer) {
            return;
        }
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
        }, this.reconnectDelayMs);
    }

    private isEnvelope(value: unknown): value is HueEventEnvelope {
        return typeof value === 'object' && value !== null;
    }

    private isHueResourceUpdate(value: unknown): value is HueResource {
        if (typeof value !== 'object' || value === null) {
            return false;
        }
        const resource = value as Record<string, unknown>;
        return typeof resource.id === 'string' && typeof resource.type === 'string';
    }
}
