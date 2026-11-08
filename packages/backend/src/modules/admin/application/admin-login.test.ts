import { describe, expect, it, vi } from 'vitest';
import { AdminLoginUseCase } from './admin-login.js';
import type { AdminUserRepo } from '../ports/admin-repository.js';
import type { JwtIssuerPort } from '../../identity/ports/jwt-port.js';
import type { SessionPort } from '../../identity/ports/session-port.js';

vi.mock('../../identity/domain/password.js', () => ({ verifyPassword: vi.fn(async () => true) }));

const fixedUser: {
  id: string;
  username: string;
  roleType: number;
  status: number;
  passwordHash: string;
  authVersion: string;
  totpEnabledAt: Date | null;
} = {
  id: '41',
  username: 'ops-admin',
  roleType: 4,
  status: 1,
  passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$AA$AA',
  authVersion: '3',
  totpEnabledAt: null,
};

function createRepo(user: typeof fixedUser = fixedUser): AdminUserRepo {
  return {
    findUserByUsername: vi.fn(async () => user as never),
    findUserByPk: vi.fn(async () => null),
    listUsers: vi.fn(async () => ({ items: [], nextCursor: null })),
    lockPermissionTargetUser: vi.fn(async () => null),
    updateUserPermissions: vi.fn(async () => 0),
  };
}

describe('AdminLoginUseCase', () => {
  it('issues an admin-audience token and creates an ADMIN session', async () => {
    const createSession = vi.fn(async () => undefined);
    const jwtIssuer = {
      signAccessToken: vi.fn(async () => 'jwt-admin'),
      createRefreshToken: vi.fn(() => 'opaque-refresh'),
      hashRefreshToken: vi.fn(() => 'a'.repeat(64)),
    } as unknown as JwtIssuerPort;
    const sessionPort = { createSession } as unknown as SessionPort;
    const useCase = new AdminLoginUseCase(createRepo(), { jwtIssuer, sessionPort });

    const result = await useCase.run({ username: 'ops-admin', password: 'secret', tx: { transaction: null } });

    expect(jwtIssuer.signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '41',
        authVersion: '3',
        audience: 'admin',
      }),
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '41',
        principalType: 'ADMIN',
        refreshHash: 'a'.repeat(64),
      }),
      expect.any(Number),
    );
    expect(result).toMatchObject({ adminUserId: '41', accessToken: 'jwt-admin', sessionKey: expect.any(String), expiresInSecs: 900 });
    expect(result.refreshToken).toBe('opaque-refresh');
  });

  it('fails closed for accounts with TOTP enabled', async () => {
    const repo = createRepo({ ...fixedUser, totpEnabledAt: new Date('2026-01-01T00:00:00.000Z') });
    const useCase = new AdminLoginUseCase(repo, {
      jwtIssuer: {
        signAccessToken: vi.fn(async () => 'jwt-admin'),
        createRefreshToken: vi.fn(() => 'opaque-refresh'),
        hashRefreshToken: vi.fn(() => 'a'.repeat(64)),
      } as unknown as JwtIssuerPort,
      sessionPort: { createSession: vi.fn(async () => undefined) } as unknown as SessionPort,
    });

    await expect(useCase.run({ username: 'ops-admin', password: 'secret', tx: { transaction: null } })).rejects.toMatchObject({
      code: 'AD_PERMISSION_DENIED',
    });
  });

  it('fails closed when identity token/session ports are not wired', async () => {
    const useCase = new AdminLoginUseCase(createRepo());
    await expect(useCase.run({ username: 'ops-admin', password: 'secret', tx: { transaction: null } })).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });
});
