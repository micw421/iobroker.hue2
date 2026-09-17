import axios, { type AxiosInstance } from 'axios';
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

/**
 * Minimal client for the Philips Hue CLIP API v2.
 *
 * The client deliberately exposes generic resources first. Typed resource
 * methods will be added as the adapter's domain model grows.
 */
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

    /** Get all resources known to the Hue Bridge. */
    public async getResources(): Promise<HueResource[]> {
        const response = await this.http.get<HueResponse<HueResource>>(`${this.baseUrl}/resource`);

        if (response.data.errors.length > 0) {
            throw new Error(response.data.errors.map(error => error.description).join('; '));
        }

        return response.data.data;
    }
}
