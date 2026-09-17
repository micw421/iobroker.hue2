import axios, { AxiosError, type AxiosInstance } from 'axios';
import https from 'node:https';

export interface HueResource {
    id: string;
    id_v1?: string;
    type: string;
    [key: string]: unknown;
}

export interface HueResponse<T> {
    errors: Array<{ description: string }>;
    data: T[];
}

export interface HueV2ClientOptions {
    address: string;
    applicationKey: string;
}

/** Minimal client for the Philips Hue CLIP API v2. */
export class HueV2Client {
    private readonly baseUrl: string;
    private readonly http: AxiosInstance;

    public constructor(options: HueV2ClientOptions) {
        this.baseUrl = `https://${options.address}/clip/v2`;
        this.http = axios.create({
            headers: {
                'hue-application-key': options.applicationKey,
            },
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            timeout: 10_000,
        });
    }

    public async getResources(): Promise<HueResource[]> {
        try {
            const response = await this.http.get<HueResponse<HueResource>>(`${this.baseUrl}/resource`);
            this.throwHueErrors(response.data.errors);
            return response.data.data;
        } catch (error) {
            throw this.toHueError(error);
        }
    }

    /** Update one Hue v2 resource using its resource type and UUID. */
    public async updateResource(type: string, id: string, payload: Record<string, unknown>): Promise<void> {
        try {
            const response = await this.http.put<HueResponse<unknown>>(
                `${this.baseUrl}/resource/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
                payload,
            );
            this.throwHueErrors(response.data.errors);
        } catch (error) {
            throw this.toHueError(error);
        }
    }

    private throwHueErrors(errors: Array<{ description: string }>): void {
        if (errors.length > 0) {
            throw new Error(errors.map(error => error.description).join('; '));
        }
    }

    private toHueError(error: unknown): Error {
        if (error instanceof AxiosError) {
            const data = error.response?.data as Partial<HueResponse<unknown>> | undefined;
            if (Array.isArray(data?.errors) && data.errors.length > 0) {
                return new Error(data.errors.map(entry => entry.description).join('; '));
            }

            const status = error.response?.status;
            if (status !== undefined) {
                return new Error(`Hue API request failed with HTTP ${status}`);
            }
        }

        return error instanceof Error ? error : new Error(String(error));
    }
}
