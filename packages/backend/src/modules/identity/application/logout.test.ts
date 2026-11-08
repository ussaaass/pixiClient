import { describe, expect, it, vi } from 'vitest';
import { LogoutUseCase } from './logout.js';
import type { IdentityRepository } from '../ports/identity-repository.js';

describe('LogoutUseCase', () => {
  it('revokes and clears registration replay even when Redis session is already absent', async () => {
    const sessions = {
      getSession: vi.fn(async () => null),
      revokeSession: vi.fn(async () => undefined),
    };
    const repo = {
      clearRegistrationReplayForSession: vi.fn(async () => 1),
    } as unknown as IdentityRepository;
    const securityEvents = {
      append: vi.fn(async () => undefined),
      revokeEvent: vi.fn(() => ({ eventKey: 'logout:ok:sid-1' })),
    };
    const outbox = { append: vi.fn(async () => undefined) };
    const clock = { now: () => new Date('2026-11-08T12:00:00.000Z') };
    const useCase = new LogoutUseCase(repo, sessions as never, outbox as never, clock, securityEvents as never);
    const input = { sid: 'sid-1', userId: '42', deviceId: '7' };

    await expect(useCase.run(input, { transaction: {} })).resolves.toEqual({ loggedOut: true });
    expect(repo.clearRegistrationReplayForSession).toHaveBeenCalledWith('sid-1', { transaction: {} });
    expect(sessions.revokeSession).toHaveBeenCalledWith('sid-1', '42');
    expect(outbox.append).toHaveBeenCalledOnce();
  });

  it('does not claim logout success when Redis is unavailable', async () => {
    const sessions = {
      getSession: vi.fn(async () => {
        throw new Error('Redis unavailable');
      }),
      revokeSession: vi.fn(async () => undefined),
    };
    const repo = { clearRegistrationReplayForSession: vi.fn(async () => 0) } as unknown as IdentityRepository;
    const securityEvents = { append: vi.fn(async () => undefined), revokeEvent: vi.fn(() => ({})) };
    const outbox = { append: vi.fn(async () => undefined) };
    const clock = { now: () => new Date('2026-11-08T12:00:00.000Z') };
    const useCase = new LogoutUseCase(repo, sessions as never, outbox as never, clock, securityEvents as never);

    await expect(useCase.run({ sid: 'sid-1', userId: '42', deviceId: null }, { transaction: {} })).rejects.toThrow('Redis unavailable');
    expect(sessions.revokeSession).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });
});
