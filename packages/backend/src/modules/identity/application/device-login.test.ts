import { describe, expect, it, vi } from 'vitest';
import { CredentialStatus, UserStatus } from '../../../infrastructure/database/models/identity.js';
import { DeviceLoginUseCase, matchesDeviceDigest } from './device-login.js';

const expected = Uint8Array.from({ length: 32 }, (_, index) => index);
const expectedHex = Buffer.from(expected).toString('hex');
const now = new Date('2026-11-06T00:00:00.000Z');
const tx = { transaction: null };

function createUseCase(patch: { device?: Record<string, unknown> | null; user?: Record<string, unknown> | null; limited?: boolean } = {}) {
  const device = {
    id: '7',
    userId: '42',
    credentialKey: 'credential-key-123456',
    credentialSecretHash: Uint8Array.from(expected),
    deviceDigest: Uint8Array.from(expected),
    credentialStatus: CredentialStatus.ACTIVE,
    credentialExpiresAt: null,
    ...patch.device,
  };
  const user = {
    id: '42',
    nickname: 'Player',
    roleType: 1,
    status: UserStatus.ACTIVE,
    authVersion: '3',
    ...patch.user,
  };
  const repo = {
    findDeviceByCredentialKey: vi.fn().mockResolvedValue(patch.device === null ? null : device),
    findUserById: vi.fn().mockResolvedValue(patch.user === null ? null : user),
    updateUser: vi.fn().mockResolvedValue(1),
  };
  const sessions = { createSession: vi.fn().mockResolvedValue(undefined) };
  const jwt = {
    createRefreshToken: vi.fn(() => 'refresh-token'),
    hashRefreshToken: vi.fn(() => 'refresh-hash'),
    signAccessToken: vi.fn().mockResolvedValue('access-token'),
  };
  const clock = { now: () => now };
  const rateLimit = { check: vi.fn().mockResolvedValue({ limited: patch.limited ?? false, count: 1, retryAfterSeconds: 0 }) };
  const securityEvents = {
    loginEvent: vi.fn((event: unknown) => event),
    append: vi.fn().mockResolvedValue(undefined),
  };
  const useCase = new DeviceLoginUseCase(
    repo as never,
    sessions as never,
    jwt as never,
    clock,
    rateLimit as never,
    securityEvents as never,
  );
  const input = {
    ctx: { credentialKey: 'credential-key-123456', deviceDigestHex: expectedHex, principalType: 'PLAYER' as const, audience: 'player' },
    rateLimitSubject: 'credential-key-123456',
  };
  return { useCase, input, device, repo, sessions, jwt, rateLimit, securityEvents };
}

describe('device credential digest comparison', () => {
  it('accepts an exact 32-byte digest in either hex case', () => {
    expect(matchesDeviceDigest(expected, expectedHex)).toBe(true);
    expect(matchesDeviceDigest(expected, expectedHex.toUpperCase())).toBe(true);
  });

  it.each(['', 'abc', 'g'.repeat(64), '0'.repeat(62)])('rejects malformed digest strings', (digest) => {
    expect(matchesDeviceDigest(expected, digest)).toBe(false);
  });

  it('rejects incorrect digests and invalid stored digest lengths', () => {
    expect(matchesDeviceDigest(expected, 'ff'.repeat(32))).toBe(false);
    expect(matchesDeviceDigest(new Uint8Array(31), expectedHex)).toBe(false);
    expect(matchesDeviceDigest(null, expectedHex)).toBe(false);
  });
});

describe('DeviceLoginUseCase cookie credential authentication', () => {
  it('authenticates only when both stored hashes match the cookie secret digest', async () => {
    const { useCase, input, repo, sessions, jwt, securityEvents } = createUseCase();
    const result = await useCase.run(input, tx);

    expect(repo.findDeviceByCredentialKey).toHaveBeenCalledWith(input.ctx.credentialKey, tx);
    expect(repo.findUserById).toHaveBeenCalledWith('42', tx);
    expect(sessions.createSession).toHaveBeenCalledOnce();
    expect(jwt.hashRefreshToken).toHaveBeenCalledWith('refresh-token');
    expect(jwt.signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: '42', deviceId: '7', authVersion: '3', audience: 'player', now }),
    );
    expect(repo.updateUser).toHaveBeenCalledWith('42', { lastLoginAt: now }, tx);
    expect(securityEvents.append).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      accessToken: 'access-token',
      sid: expect.any(String),
      refreshToken: 'refresh-token',
      user: { userId: '42' },
      device: { deviceId: '7' },
    });
    expect(JSON.stringify(securityEvents.append.mock.calls)).not.toContain(expectedHex);
  });

  it.each([
    { name: 'incorrect credential secret hash', patch: { credentialSecretHash: new Uint8Array(32).fill(0xff) } },
    { name: 'missing credential secret hash', patch: { credentialSecretHash: null } },
    { name: 'short credential secret hash', patch: { credentialSecretHash: new Uint8Array(31) } },
    { name: 'long credential secret hash', patch: { credentialSecretHash: new Uint8Array(33) } },
    { name: 'missing device digest', patch: { deviceDigest: null } },
    { name: 'short device digest', patch: { deviceDigest: new Uint8Array(31) } },
  ])('rejects $name before creating a session', async ({ patch }) => {
    const { useCase, input, repo, sessions, jwt, securityEvents } = createUseCase({ device: patch });
    await expect(useCase.run(input, tx)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(repo.findUserById).not.toHaveBeenCalled();
    expect(sessions.createSession).not.toHaveBeenCalled();
    expect(jwt.signAccessToken).not.toHaveBeenCalled();
    expect(repo.updateUser).not.toHaveBeenCalled();
    expect(securityEvents.append).toHaveBeenCalledWith(expect.objectContaining({ failureCode: 'INVALID_CREDENTIALS' }), tx);
  });

  it('rejects missing or mismatched credential keys without a user lookup', async () => {
    const missing = createUseCase({ device: null });
    await expect(missing.useCase.run(missing.input, tx)).rejects.toMatchObject({ code: 'DEVICE_CREDENTIAL_MISSING' });
    expect(missing.repo.findUserById).not.toHaveBeenCalled();

    const mismatched = createUseCase({ device: { credentialKey: 'another-key' } });
    await expect(mismatched.useCase.run(mismatched.input, tx)).rejects.toMatchObject({ code: 'DEVICE_CREDENTIAL_MISSING' });
    expect(mismatched.repo.findUserById).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'revoked status', patch: { credentialStatus: CredentialStatus.REVOKED }, code: 'DEVICE_CREDENTIAL_REVOKED' },
    { name: 'expired status', patch: { credentialStatus: CredentialStatus.EXPIRED }, code: 'DEVICE_CREDENTIAL_EXPIRED' },
    { name: 'past expiration', patch: { credentialExpiresAt: new Date(now.getTime() - 1) }, code: 'DEVICE_CREDENTIAL_EXPIRED' },
    { name: 'expiration exactly now', patch: { credentialExpiresAt: now }, code: 'DEVICE_CREDENTIAL_EXPIRED' },
    { name: 'invalid expiration date', patch: { credentialExpiresAt: new Date('invalid') }, code: 'DEVICE_CREDENTIAL_EXPIRED' },
  ])('rejects $name before creating a session', async ({ patch, code }) => {
    const { useCase, input, repo, sessions, securityEvents } = createUseCase({ device: patch });
    await expect(useCase.run(input, tx)).rejects.toMatchObject({ code });
    expect(repo.findUserById).not.toHaveBeenCalled();
    expect(sessions.createSession).not.toHaveBeenCalled();
    expect(securityEvents.append).toHaveBeenCalledWith(expect.objectContaining({ failureCode: code }), tx);
  });

  it('denies inactive/missing users and rate-limited requests without creating sessions', async () => {
    const inactive = createUseCase({ user: { status: UserStatus.DISABLED } });
    await expect(inactive.useCase.run(inactive.input, tx)).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });
    expect(inactive.sessions.createSession).not.toHaveBeenCalled();

    const limited = createUseCase({ limited: true });
    await expect(limited.useCase.run(limited.input, tx)).rejects.toMatchObject({ code: 'AUTH_RATE_LIMITED' });
    expect(limited.repo.findDeviceByCredentialKey).not.toHaveBeenCalled();
    expect(limited.sessions.createSession).not.toHaveBeenCalled();
  });
});
