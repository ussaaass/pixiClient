import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHealth } from './health-api';

describe('getHealth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns a valid health response', async () => {
    const body = {
      requestId: 'test-request',
      code: 'OK',
      message: 'OK',
      data: { status: 'live', service: 'gameing-hall-api' },
      serverNow: '2026-10-10T00:00:00.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getHealth()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/health/live', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  it('rejects invalid response bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    await expect(getHealth()).rejects.toThrow('Health endpoint returned an invalid response');
  });
});
