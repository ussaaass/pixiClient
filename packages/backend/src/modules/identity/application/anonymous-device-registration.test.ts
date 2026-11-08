import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnonymousDeviceRegistrationUseCase } from './anonymous-device-registration.js';
import type { IdentityRepository } from '../ports/identity-repository.js';

const originalReplayKey = process.env.AUTH_DEVICE_REGISTER_REPLAY_ENCRYPTION_KEY;

afterEach(() => {
  if (originalReplayKey === undefined) delete process.env.AUTH_DEVICE_REGISTER_REPLAY_ENCRYPTION_KEY;
  else process.env.AUTH_DEVICE_REGISTER_REPLAY_ENCRYPTION_KEY = originalReplayKey;
});

const request = {
  fingerprintVersion: 'v1',
  deviceCode: 'device-code-1234567890',
  deviceSummary: { platform: 'web', browser: 'test' },
};

function createFixture() {
  const operation: Record<string, unknown> = {};
  const revokedSessions = new Set<string>();
  let userCount = 0;
  let deviceCount = 0;
  const user = {
    id: '42',
    nickname: 'Guest-test',
    roleType: 1,
    status: 1,
    authVersion: '1',
    publicCode: 'opaque',
    username: null,
    email: null,
    phone: null,
    assetId: null,
    permissions: [],
  };
  const device = { id: '7', userId: '42', credentialStatus: 1, credentialKey: 'key' };
  const repo = {
    clearExpiredRegistrationReplay: vi.fn(async () => 0),
    clearRegistrationReplayForSession: vi.fn(async (sessionId: string) => {
      if (operation.sessionId !== sessionId || operation.replayCiphertext == null) return 0;
      operation.replayCiphertext = null;
      operation.replayExpiresAt = null;
      return 1;
    }),
    findRegistrationOperation: vi.fn(async () => (Object.keys(operation).length ? operation : null)),
    insertRegistrationOperation: vi.fn(async (input: { idempotencyKey: string; requestHash: Uint8Array }) => {
      Object.assign(operation, { idempotencyKey: input.idempotencyKey, requestHash: input.requestHash, status: 1 });
      return operation;
    }),
    updateRegistrationOperation: vi.fn(async (_key: string, patch: Record<string, unknown>, _tx: unknown, status: number) => {
      if (operation.status !== status) return 0;
      Object.assign(operation, patch);
      return 1;
    }),
    createUser: vi.fn(async () => {
      userCount += 1;
      return user;
    }),
    upsertDevice: vi.fn(async () => {
      deviceCount += 1;
      return device;
    }),
    updateUser: vi.fn(async () => 1),
  } as unknown as IdentityRepository;
  const sessions = {
    createSession: vi.fn(async (record: { sessionId: string }) => {
      if (revokedSessions.has(record.sessionId)) throw new Error('cannot recreate a revoked session');
    }),
    revokeSession: vi.fn(async (sid: string) => {
      revokedSessions.add(sid);
    }),
  };
  const jwt = {
    createRefreshToken: vi.fn(() => 'refresh-token'),
    hashRefreshToken: vi.fn(() => 'refresh-hash'),
    signAccessToken: vi.fn(async () => 'access-token'),
  };
  const accounts = { ensure: vi.fn(async () => undefined) };
  const gift = { grantWelcomeGift: vi.fn(async () => undefined) };
  const unitOfWork = { run: vi.fn(async (fn: (scope: { transaction: object | null }) => unknown) => fn({ transaction: {} })) };
  const clock = { now: () => new Date('2026-11-08T12:00:00.000Z') };
  const useCase = new AnonymousDeviceRegistrationUseCase(repo, unitOfWork as never, accounts, gift, sessions as never, jwt as never, clock);
  return { useCase, repo, sessions, jwt, accounts, gift, operation, userCount: () => userCount, deviceCount: () => deviceCount };
}

describe('AnonymousDeviceRegistrationUseCase', () => {
  beforeEach(() => {
    process.env.AUTH_DEVICE_REGISTER_REPLAY_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  });

  it('creates once and replays the same credential and session after retry', async () => {
    const fixture = createFixture();
    const first = await fixture.useCase.run({ request, idempotencyKey: 'registration-key-123456', audience: 'player' });
    const second = await fixture.useCase.run({ request, idempotencyKey: 'registration-key-123456', audience: 'player' });

    expect(fixture.userCount()).toBe(1);
    expect(fixture.deviceCount()).toBe(1);
    expect(fixture.accounts.ensure).toHaveBeenCalledTimes(1);
    expect(fixture.gift.grantWelcomeGift).toHaveBeenCalledTimes(1);
    expect(fixture.sessions.createSession).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
    expect(fixture.operation.replayCiphertext).not.toContain(first.deviceCookie);
    expect(fixture.jwt.signAccessToken).toHaveBeenCalledTimes(1);
  });

  it('recovers the SQL-committed result after an uncertain Redis projection acknowledgement', async () => {
    const fixture = createFixture();
    fixture.sessions.createSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('simulated Redis timeout after write'))
      .mockResolvedValueOnce(undefined);

    await expect(fixture.useCase.run({ request, idempotencyKey: 'registration-key-123456', audience: 'player' })).rejects.toThrow(
      'simulated Redis timeout after write',
    );
    expect(fixture.operation.status).toBe(2);
    expect(fixture.userCount()).toBe(1);

    const recovered = await fixture.useCase.run({ request, idempotencyKey: 'registration-key-123456', audience: 'player' });
    expect(recovered.sessionRecord.sessionId).toBeDefined();
    expect(recovered.deviceCookie).toBeDefined();
    expect(fixture.userCount()).toBe(1);
    expect(fixture.deviceCount()).toBe(1);
    expect(fixture.accounts.ensure).toHaveBeenCalledTimes(1);
    expect(fixture.gift.grantWelcomeGift).toHaveBeenCalledTimes(1);
    expect(fixture.sessions.createSession).toHaveBeenCalledTimes(2);
  });

  it('keeps the committed tombstone and resumes after a provisioning failure', async () => {
    const fixture = createFixture();
    fixture.repo.createUser = vi
      .fn()
      .mockRejectedValueOnce(new Error('simulated SQL provisioning failure'))
      .mockResolvedValueOnce({ id: '42', nickname: 'Guest-test', roleType: 1, authVersion: '1', publicCode: 'opaque' } as never);
    await expect(fixture.useCase.run({ request, idempotencyKey: 'registration-key-123456', audience: 'player' })).rejects.toMatchObject({
      retryable: true,
    });
    expect(fixture.operation.status).toBe(1);
    const resumed = await fixture.useCase.run({ request, idempotencyKey: 'registration-key-123456', audience: 'player' });
    expect(resumed.sessionResult.user.userId).toBe('42');
    expect(fixture.repo.createUser).toHaveBeenCalledTimes(2);
    expect(fixture.gift.grantWelcomeGift).toHaveBeenCalledTimes(1);
  });

  it('does not pass a null SQL transaction to account or gift provisioning', async () => {
    const fixture = createFixture();
    let calls = 0;
    fixture.useCase['unitOfWork'].run = vi.fn(async (fn: (scope: { transaction: object | null }) => unknown) => {
      calls += 1;
      return fn({ transaction: calls === 2 ? null : {} });
    }) as never;
    await expect(fixture.useCase.run({ request, idempotencyKey: 'registration-key-123456', audience: 'player' })).rejects.toThrow(
      'requires an active SQL transaction',
    );
    expect(fixture.accounts.ensure).not.toHaveBeenCalled();
    expect(fixture.gift.grantWelcomeGift).not.toHaveBeenCalled();
  });

  it('does not resurrect the session after logout revokes it', async () => {
    const fixture = createFixture();
    const first = await fixture.useCase.run({ request, idempotencyKey: 'registration-key-123456', audience: 'player' });
    await fixture.sessions.revokeSession(first.sessionRecord.sessionId);
    await fixture.repo.clearRegistrationReplayForSession(first.sessionRecord.sessionId, { transaction: {} });
    await expect(fixture.useCase.run({ request, idempotencyKey: 'registration-key-123456', audience: 'player' })).rejects.toThrow(
      'registration replay window expired',
    );
    expect(fixture.repo.clearRegistrationReplayForSession).toHaveBeenCalledWith(first.sessionRecord.sessionId, { transaction: {} });
    expect(fixture.sessions.createSession).toHaveBeenCalledTimes(1);
    expect(fixture.userCount()).toBe(1);
  });

  it('rejects same key with a different canonical request before creating another account', async () => {
    const fixture = createFixture();
    await fixture.useCase.run({ request, idempotencyKey: 'registration-key-123456', audience: 'player' });
    await expect(
      fixture.useCase.run({
        request: { ...request, deviceCode: 'different-device-code-123' },
        idempotencyKey: 'registration-key-123456',
        audience: 'player',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(fixture.userCount()).toBe(1);
  });
});
