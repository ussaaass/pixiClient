import { describe, expect, it } from 'vitest';
import { toPublicSession, type SessionResult } from './session-result.js';

describe('public session projection', () => {
  it('strips cookie credentials while preserving the public DTO', () => {
    const internal: SessionResult = {
      accessToken: 'access',
      tokenType: 'Bearer',
      expiresAt: '2026-11-06T00:00:00.000Z',
      user: { userId: '42', displayName: 'Player', roleType: 1 },
      device: { deviceId: '7', trusted: true },
      sid: 'opaque-sid',
      refreshToken: 'opaque-refresh',
    };
    const result = toPublicSession(internal);
    expect(result).not.toHaveProperty('sid');
    expect(result).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(result)).not.toContain('opaque-refresh');
    expect(result).toMatchObject({ accessToken: 'access', tokenType: 'Bearer' });
    expect(Object.keys(result).sort()).toEqual(['accessToken', 'device', 'expiresAt', 'tokenType', 'user']);
  });
});
