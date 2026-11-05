import { stripTrailingSlashes } from '@maintainerr/contracts';
import axios, { type AxiosInstance } from 'axios';
import { applyHttpRetry } from '../lib/httpRetry';
import { MEDIA_SERVER_REQUEST_TIMEOUT_MS } from '../lib/httpTimeouts';

/** Silo's native API. `/api/v1` is frozen upstream; never target it. */
const SILO_API_PATH = '/api/v2';

interface SiloApiOptions {
  url: string;
  apiKey: string;
  timeout?: number;
}

/**
 * Thin wrapper around `axios.create` for talking to a user-configured Silo
 * server, in the same shape as `EmbyApi`: HTTP-client construction lives in
 * `modules/api/<server>/` rather than inside the media-server adapter.
 *
 * Silo authenticates every non-public route with `Authorization: Bearer`,
 * taking either a session token or an API key. Maintainerr only ever sends an
 * API key owned by an admin account.
 */
export class SiloApi {
  readonly axios: AxiosInstance;

  constructor(options: SiloApiOptions) {
    this.axios = axios.create({
      baseURL: `${stripTrailingSlashes(options.url)}${SILO_API_PATH}`,
      timeout: options.timeout ?? MEDIA_SERVER_REQUEST_TIMEOUT_MS,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      // Silo takes a repeated parameter for lists (`content_ids=a&content_ids=b`),
      // not axios' default `content_ids[]=a`.
      paramsSerializer: { indexes: null },
    });

    // Retry transient failures with exponential backoff, like every other
    // outbound client.
    applyHttpRetry(this.axios);
  }
}
