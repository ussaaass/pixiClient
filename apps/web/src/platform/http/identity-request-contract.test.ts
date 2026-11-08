import { Value } from '@sinclair/typebox/value';
import { describe, expect, it, vi } from 'vitest';
import { IdentityEndpoint } from '@gameing/contracts/identity';
import { createApiClient } from './api-client';

describe('identity request contracts', () => {
  it('uses the cookie-only device-login contract and validates refresh operation IDs', async () => {
    const validDeviceLogin = {};
    const validRefresh = { operationId: 'operation_id_123456' };

    expect(Value.Check(IdentityEndpoint.deviceLogin.request, {})).toBe(true);
    expect(
      Value.Check(IdentityEndpoint.deviceLogin.request, {
        userId: '123',
        deviceDigestHex: 'a'.repeat(64),
        credentialKey: 'credential-key-123456',
      }),
    ).toBe(false);
    expect(Value.Check(IdentityEndpoint.deviceLogin.request, { extra: true })).toBe(false);
    expect(Value.Check(IdentityEndpoint.deviceLogin.request, validDeviceLogin)).toBe(true);
    expect(Value.Check(IdentityEndpoint.refresh.request, {})).toBe(false);
    expect(Value.Check(IdentityEndpoint.refresh.request, validRefresh)).toBe(true);

    const fetchPort = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            requestId: 'request-1',
            code: 'OK',
            message: 'OK',
            data: {
              accessToken: 'access',
              tokenType: 'Bearer',
              expiresAt: '2026-11-08T00:00:00.000Z',
              user: { userId: '1', displayName: 'Player', roleType: 1 },
              device: { deviceId: '2', trusted: true },
            },
            serverNow: '2026-11-07T12:00:00.000Z',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            requestId: 'request-2',
            code: 'OK',
            message: 'OK',
            data: {
              accessToken: 'access',
              tokenType: 'Bearer',
              expiresAt: '2026-11-08T00:00:00.000Z',
              user: { userId: '1', displayName: 'Player', roleType: 1 },
              device: { deviceId: '2', trusted: true },
            },
            serverNow: '2026-11-07T12:00:00.000Z',
          }),
          { status: 200 },
        ),
      );
    const client = createApiClient(fetchPort);

    await expect(client.deviceLogin()).resolves.toMatchObject({ accessToken: 'access' });
    await expect(client.refresh({ operationId: 'operation_id_123456' })).resolves.toMatchObject({ accessToken: 'access' });
    expect(fetchPort).toHaveBeenCalledTimes(2);
    expect(fetchPort.mock.calls[0]?.[0]).toBe(IdentityEndpoint.deviceLogin.path);
    expect(fetchPort.mock.calls[1]?.[0]).toBe(IdentityEndpoint.refresh.path);
    expect(JSON.parse(String(fetchPort.mock.calls[1]?.[1]?.body))).toEqual({ operationId: 'operation_id_123456' });
  });
});
