import { describe, expect, it, vi } from 'vitest';
import { CredentialStatus, UserStatus } from '../../../infrastructure/database/models/identity.js';
import { DeviceRegisterUseCase } from './device-register.js';

const input = {
  request: { deviceCode: 'device-code', fingerprintVersion: 'v1' },
  principalType: 'PLAYER' as const,
  audience: 'player',
  user: { id: '42', nickname: 'Player', roleType: 1, status: UserStatus.ACTIVE, authVersion: '1' },
  device: {
    id: '7',
    userId: '42',
    credentialKey: 'credential-key-123456',
    credentialSecretHash: new Uint8Array(32),
    deviceDigest: new Uint8Array(32),
    credentialStatus: CredentialStatus.ACTIVE,
    credentialExpiresAt: null,
  },
};

function createUseCase(options: { gift?: { grantWelcomeGift: ReturnType<typeof vi.fn> } | null } = {}) {
  const sessions = {
    createSession: vi.fn().mockResolvedValue(undefined),
    revokeSession: vi.fn().mockResolvedValue(undefined),
  };
  const jwt = {
    createRefreshToken: vi.fn(() => 'refresh-token'),
    hashRefreshToken: vi.fn(() => 'refresh-hash'),
    signAccessToken: vi.fn().mockResolvedValue('access-token'),
  };
  const repo = { updateUser: vi.fn().mockResolvedValue(undefined) };
  const gift = options.gift === undefined ? { grantWelcomeGift: vi.fn().mockResolvedValue(undefined) } : options.gift;
  const clock = { now: () => new Date('2026-11-06T00:00:00.000Z') };
  const useCase = new DeviceRegisterUseCase(repo as never, sessions as never, jwt as never, clock, gift as never);
  return { useCase, sessions, jwt, repo, gift };
}

describe('DeviceRegisterUseCase welcome-gift boundary', () => {
  it.each([
    { name: 'another user', patch: { userId: '43' } },
    { name: 'missing credential key', patch: { credentialKey: null } },
    { name: 'missing secret hash', patch: { credentialSecretHash: null } },
    { name: 'malformed secret hash', patch: { credentialSecretHash: new Uint8Array(31) } },
    { name: 'missing device digest', patch: { deviceDigest: null } },
    { name: 'malformed device digest', patch: { deviceDigest: new Uint8Array(31) } },
    { name: 'revoked credential', patch: { credentialStatus: 2 } },
    { name: 'expired credential', patch: { credentialStatus: 3 } },
    { name: 'past expiry', patch: { credentialExpiresAt: new Date('2026-11-05T00:00:00.000Z') } },
    { name: 'invalid expiry date', patch: { credentialExpiresAt: new Date('invalid') } },
  ])('rejects $name before granting or creating a session', async ({ patch }) => {
    const { useCase, sessions, gift, jwt } = createUseCase();
    const invalidInput = { ...input, device: { ...input.device, ...patch } };
    await expect(useCase.run(invalidInput as never, { transaction: null })).rejects.toMatchObject({
      code: 'DEVICE_CREDENTIAL_MISSING',
    });
    expect(gift?.grantWelcomeGift).not.toHaveBeenCalled();
    expect(jwt.signAccessToken).not.toHaveBeenCalled();
    expect(sessions.createSession).not.toHaveBeenCalled();
  });

  it('grants once, creates a session, then returns registration credentials', async () => {
    const { useCase, sessions, jwt, repo, gift } = createUseCase();
    const result = await useCase.run(input as never, { transaction: null });
    expect(gift?.grantWelcomeGift).toHaveBeenCalledTimes(1);
    expect(gift?.grantWelcomeGift).toHaveBeenCalledWith('42');
    expect(sessions.createSession).toHaveBeenCalledTimes(1);
    expect(sessions.revokeSession).not.toHaveBeenCalled();
    expect(jwt.signAccessToken).toHaveBeenCalledTimes(1);
    expect(repo.updateUser).toHaveBeenCalledTimes(1);
    expect(result.accessToken).toBe('access-token');
  });

  it('fails closed before creating a session if the wallet port is unavailable', async () => {
    const { useCase, sessions } = createUseCase({ gift: null });
    await expect(useCase.run(input as never, { transaction: null })).rejects.toMatchObject({
      code: 'IDENTITY_STORAGE_UNAVAILABLE',
    });
    expect(sessions.createSession).not.toHaveBeenCalled();
  });

  it('does not create a Redis session when the SQL gift grant fails', async () => {
    const gift = { grantWelcomeGift: vi.fn().mockRejectedValue(new Error('wallet unavailable')) };
    const { useCase, sessions } = createUseCase({ gift });
    await expect(useCase.run(input as never, { transaction: null })).rejects.toThrow('wallet unavailable');
    expect(sessions.createSession).not.toHaveBeenCalled();
    expect(sessions.revokeSession).not.toHaveBeenCalled();
  });

  it('does not grant or create a session when access-token signing fails', async () => {
    const { useCase, sessions, jwt, gift } = createUseCase();
    jwt.signAccessToken.mockRejectedValueOnce(new Error('signing failed'));
    await expect(useCase.run(input as never, { transaction: null })).rejects.toThrow('signing failed');
    expect(gift?.grantWelcomeGift).not.toHaveBeenCalled();
    expect(sessions.createSession).not.toHaveBeenCalled();
    expect(sessions.revokeSession).not.toHaveBeenCalled();
  });

  it('keeps the gift idempotently retryable if Redis session creation fails', async () => {
    const gift = { grantWelcomeGift: vi.fn().mockResolvedValue(undefined) };
    const { useCase, sessions, jwt, repo } = createUseCase({ gift });
    sessions.createSession.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(useCase.run(input as never, { transaction: null })).rejects.toThrow('redis unavailable');
    expect(jwt.signAccessToken).toHaveBeenCalledTimes(1);
    expect(gift.grantWelcomeGift).toHaveBeenCalledWith('42');
    expect(repo.updateUser).toHaveBeenCalledTimes(1);
  });

  it('does not create a Redis session if last-login SQL update fails after the gift', async () => {
    const gift = { grantWelcomeGift: vi.fn().mockResolvedValue(undefined) };
    const { useCase, sessions, repo } = createUseCase({ gift });
    repo.updateUser.mockRejectedValueOnce(new Error('last-login update failed'));
    await expect(useCase.run(input as never, { transaction: null })).rejects.toThrow('last-login update failed');
    expect(gift.grantWelcomeGift).toHaveBeenCalledWith('42');
    expect(sessions.createSession).not.toHaveBeenCalled();
  });
});
