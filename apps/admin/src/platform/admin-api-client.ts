/**
 * Shared Admin API client for all 19 domain workspaces.
 *
 * Per SDD §7.1 dual-track cutover: each workspace composition.ts wires its
 * Local*Adapter to a Remote*Adapter that sends requests through this client.
 * - Prefix: /admin-api/v1 (dev proxy target; production overrides via VITE_ADMIN_API_BASE).
 * - Envelope: `{ code, message, data, requestId, serverNow }` per packages/contracts common/api-envelope.
 * - Auth: Bearer token read from sessionStorage('admin.accessToken') via the
 *   per-workspace config's getToken(); on 401 the client invokes onUnauthorized
 *   and retries once (single refresh window).
 */
export interface AdminApiConfig {
  base: string;
  getToken(): string | null;
  onUnauthorized?(): void;
}

export class AdminApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

interface Envelope<TData> {
  requestId: string;
  code: string;
  message: string;
  data: TData;
  serverNow: string;
}

export class AdminApiClient {
  constructor(private readonly config: AdminApiConfig) {}

  async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const url = this.buildUrl(path, params);
    const response = await this.request(url, { method: 'GET' });
    return this.parseEnvelope<T>(response);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path);
    const init: { method: string; headers?: Record<string, string>; body?: string } = { method: 'POST' };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const response = await this.request(url, init);
    return this.parseEnvelope<T>(response);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path);
    const init: { method: string; headers?: Record<string, string>; body?: string } = { method: 'PATCH' };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const response = await this.request(url, init);
    return this.parseEnvelope<T>(response);
  }

  private buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
    const base = this.config.base.replace(/\/+$/, '');
    const normalized = path.startsWith('/') ? path : `/${path}`;
    let url = `${base}${normalized}`;
    if (params) {
      const search = Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');
      if (search) url = `${url}?${search}`;
    }
    return url;
  }

  private headers(method: string): Record<string, string> {
    const token = this.config.getToken();
    const result: Record<string, string> = {};
    if (token) result.Authorization = `Bearer ${token}`;
    if (method !== 'GET') result['Content-Type'] = 'application/json';
    return result;
  }

  private async request(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
    const response = await fetch(url, { ...init, headers: { ...this.headers(init.method), ...init.headers } });
    if (response.status === 401) {
      this.config.onUnauthorized?.();
      const retried = await fetch(url, { ...init, headers: { ...this.headers(init.method), ...init.headers } });
      if (retried.status === 401) throw new AdminApiError('UNAUTHORIZED', '认证已失效，请重新登录。');
      return retried;
    }
    if (!response.ok) {
      const message = response.statusText || `HTTP ${response.status}`;
      throw new AdminApiError(`HTTP_${response.status}`, message);
    }
    return response;
  }

  private async parseEnvelope<TData>(response: Response): Promise<TData> {
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== 'object') throw new AdminApiError('INVALID_ENVELOPE', '响应不是有效的 envelope。');
    const envelope = raw as Envelope<TData>;
    if (envelope.code === 'OK') return envelope.data;
    throw new AdminApiError(envelope.code, envelope.message);
  }
}
