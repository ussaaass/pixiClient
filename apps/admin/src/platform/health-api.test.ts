import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAdminHealth } from './health-api';

describe('getAdminHealth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the shared live response and requests the real liveness endpoint', async () => {
    const payload = {
      requestId: 'req-1', code: 'OK', message: 'ok',
      data: { status: 'live', service: 'gameing-hall-api' },
      serverNow: '2026-10-13T10:11:12.123Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getAdminHealth()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/health/live', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('rejects error responses and invalid payloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'ERROR' }), { status: 503 })));
    await expect(getAdminHealth()).rejects.toThrow('Health endpoint returned an invalid response');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'OK', data: { status: 'live' } }), { status: 200 })));
    await expect(getAdminHealth()).rejects.toThrow('Health endpoint returned an invalid response');
  });
});
