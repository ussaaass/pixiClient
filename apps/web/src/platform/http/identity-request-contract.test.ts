import { Value } from '@sinclair/typebox/value';
import { describe, expect, it, vi } from 'vitest';
import { IdentityEndpoint } from '@gameing/contracts/identity';
import { ApiRequestError, createApiClient } from './api-client';

describe('identity request contract mismatch', () => {
  it('documents device-login and refresh client requests failing local schema validation', async () => {
    const validDeviceLogin = {
      userId: '123',
      deviceDigestHex: 'a'.repeat(64),
      credentialKey: 'credential-key-123456',
    };
    const validRefresh = { operationId: 'operation_id_123456' };

    expect(Value.Check(IdentityEndpoint.deviceLogin.request, {})).toBe(false);
    expect(Value.Check(IdentityEndpoint.deviceLogin.request, validDeviceLogin)).toBe(true);
    expect(Value.Check(IdentityEndpoint.refresh.request, {})).toBe(false);
    expect(Value.Check(IdentityEndpoint.refresh.request, validRefresh)).toBe(true);

    const fetchPort = vi.fn();
    const client = createApiClient(fetchPort);

    for (const result of [client.deviceLogin(), client.refresh()]) {
      await expect(result).rejects.toBeInstanceOf(ApiRequestError);
      await expect(result).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    }
    expect(fetchPort).not.toHaveBeenCalled();
  });
});
