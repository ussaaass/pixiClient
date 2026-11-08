import { describe, expect, it, vi } from 'vitest';
import type { AdminApiClient } from '../admin-api-client.js';
import { RemoteAdminPermissionAdapter } from './remote-admin-permission-adapter.js';

describe('RemoteAdminPermissionAdapter', () => {
  it('loads server permission paths and normalizes bigint DTO versions', async () => {
    const client = {
      get: vi.fn(async (path: string) =>
        path.endsWith('/permissions')
          ? [
              {
                permissionCode: 'admin.support.resolve',
                name: '关闭客服工单',
                httpMethod: 'POST',
                pathPattern: '/api/v1/support/conversations/:id/resolve',
                status: 1,
              },
            ]
          : [{ userId: '90002', username: 'agent', roleType: 4, status: 1, permissions: [], authVersion: '7', source: 2 }],
      ),
    } as unknown as AdminApiClient;
    const adapter = new RemoteAdminPermissionAdapter(client);
    expect((await adapter.listPaths())[0]?.permissionCode).toBe('admin.support.resolve');
    expect((await adapter.listUsers())[0]?.authVersion).toBe(7);
  });

  it('sends only the requested grant command, ignoring client audit snapshots', async () => {
    const patch = vi.fn(async () => ({
      replayed: false,
      user: { userId: '90002', username: 'agent', roleType: 4, status: 1, permissions: ['admin.support.claim'], authVersion: 8, source: 2 },
      audit: {
        auditId: '70001',
        requestKey: 'request-0001',
        adminUserId: '90001',
        targetAdminUserId: '90002',
        action: 'PERMISSIONS_UPDATED',
        previousPermissions: [],
        nextPermissions: ['admin.support.claim'],
        previousAuthVersion: 7,
        nextAuthVersion: 8,
        reason: '客服值班授权',
        source: 2,
        createdAt: '2026-11-08T00:00:00.000Z',
      },
    }));
    const adapter = new RemoteAdminPermissionAdapter({ patch } as unknown as AdminApiClient);
    const user = {
      userId: '90002',
      username: 'agent',
      roleType: 4 as const,
      status: 1 as const,
      permissions: ['admin.support.claim'],
      authVersion: 8,
      source: 2 as const,
    };
    const audit = {
      auditId: 'forged',
      requestKey: 'request-0001',
      adminUserId: '90001',
      targetAdminUserId: user.userId,
      action: 'PERMISSIONS_UPDATED' as const,
      previousPermissions: [],
      nextPermissions: user.permissions,
      previousAuthVersion: 7,
      nextAuthVersion: 8,
      reason: '客服值班授权',
      source: 1 as const,
      createdAt: '2026-11-08T00:00:00.000Z',
    };
    await adapter.commit(user, audit);
    expect(patch).toHaveBeenCalledWith('/admin-permissions/users/90002/permissions', {
      targetAdminUserId: '90002',
      permissionCodes: ['admin.support.claim'],
      reason: '客服值班授权',
      requestKey: 'request-0001',
    });
    expect(audit.auditId).toBe('70001');
    expect(audit.source).toBe(2);
  });

  it('fails closed when server response schemas are invalid', async () => {
    const adapter = new RemoteAdminPermissionAdapter({
      get: vi.fn(async (path: string) => path.endsWith('/permissions')
        ? [{ permissionCode: 'not-valid' }]
        : [{ userId: '90002', username: 'agent', roleType: 4, status: 1, permissions: [], authVersion: 1, source: 2, isSuperuser: true }]),
    } as unknown as AdminApiClient);
    await expect(adapter.listPaths()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(adapter.listUsers()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
