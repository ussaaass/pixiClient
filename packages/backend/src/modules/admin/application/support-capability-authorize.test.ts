import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SupportAdminCapabilityAuthorizeUseCase, SUPPORT_ADMIN_PERMISSION_CODES } from './support-capability-authorize.js';
import type { AdminPermissionRepo, AdminUserRepo } from '../ports/admin-repository.js';

function fixture(options: { permission?: Record<string, unknown> | null; user?: Record<string, unknown> | null } = {}) {
  const queriedRoute: unknown[] = [];
  const permissionRepo = {
    findPermissionByRoute: async (method: string, path: string) => {
      queriedRoute.push({ method, path });
      return options.permission === undefined
        ? { permissionCode: SUPPORT_ADMIN_PERMISSION_CODES.claim, status: 1, deletedAt: null }
        : options.permission;
    },
  } as unknown as AdminPermissionRepo;
  const userRepo = {
    findUserByPk: async () =>
      options.user === undefined
        ? { id: '90001', status: 1, roleType: 4, permissions: [SUPPORT_ADMIN_PERMISSION_CODES.claim], deletedAt: null }
        : options.user,
  } as unknown as AdminUserRepo;
  return { useCase: new SupportAdminCapabilityAuthorizeUseCase(permissionRepo, userRepo), queriedRoute };
}

test('Support authorization requires active route permission and current Admin grant', async () => {
  const { useCase, queriedRoute } = fixture();
  assert.equal(await useCase.run({ adminUserId: '90001', action: 'claim', tx: { transaction: null } }), true);
  assert.deepEqual(queriedRoute, [{ method: 'POST', path: '/api/v1/admin/support/conversations/:id/claim' }]);
});

test('Support authorization denies missing, inactive, mismatched, and ungranted permission', async () => {
  for (const permission of [
    null,
    { permissionCode: SUPPORT_ADMIN_PERMISSION_CODES.claim, status: 2, deletedAt: null },
    { permissionCode: SUPPORT_ADMIN_PERMISSION_CODES.claim, status: 1, deletedAt: new Date() },
    { permissionCode: 'admin.support.resolve', status: 1, deletedAt: null },
  ]) {
    const { useCase } = fixture({ permission });
    assert.equal(await useCase.run({ adminUserId: '90001', action: 'claim', tx: { transaction: null } }), false);
  }
  const { useCase } = fixture({ user: { id: '90001', status: 1, roleType: 4, permissions: [], deletedAt: null } });
  assert.equal(await useCase.run({ adminUserId: '90001', action: 'claim', tx: { transaction: null } }), false);
});

test('Support authorization denies inactive or non-Admin principals', async () => {
  for (const user of [
    { id: '90001', status: 2, roleType: 4, permissions: [SUPPORT_ADMIN_PERMISSION_CODES.claim], deletedAt: null },
    { id: '90001', status: 1, roleType: 1, permissions: [SUPPORT_ADMIN_PERMISSION_CODES.claim], deletedAt: null },
    { id: '90001', status: 1, roleType: 4, permissions: [SUPPORT_ADMIN_PERMISSION_CODES.claim], deletedAt: new Date() },
    null,
  ]) {
    const { useCase } = fixture({ user });
    assert.equal(await useCase.run({ adminUserId: '90001', action: 'claim', tx: { transaction: null } }), false);
  }
});
