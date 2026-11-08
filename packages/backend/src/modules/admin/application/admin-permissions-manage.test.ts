import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdminPermissionsManageUseCase } from './admin-permissions-manage.js';
import type { AdminAuditEventRepo, AdminPermissionRepo, AdminUserRepo } from '../ports/admin-repository.js';

const routePermission = {
  id: '1',
  permissionCode: 'admin.permissions.manage',
  name: '权限管理',
  httpMethod: 'PATCH',
  pathPattern: '/api/v1/admin/users/:user_id/permissions',
  status: 1,
  deletedAt: null,
};
const supportPermission = {
  id: '2',
  permissionCode: 'admin.support.claim',
  name: '领取客服工单',
  httpMethod: 'POST',
  pathPattern: '/api/v1/admin/support/conversations/:id/claim',
  status: 1,
  deletedAt: null,
};
const targetDefault = { id: '90002', username: 'agent', roleType: 4, status: 1, permissions: [], authVersion: '4', deletedAt: null };
const actorDefault = {
  id: '90001',
  username: 'admin',
  roleType: 4,
  status: 1,
  permissions: ['admin.permissions.manage'],
  authVersion: '1',
  deletedAt: null,
};

function fixture(
  opts: {
    actor?: Record<string, unknown> | null;
    target?: Record<string, unknown> | null;
    manage?: Record<string, unknown> | null;
    codes?: Record<string, unknown>[];
    auditFailure?: boolean;
  } = {},
) {
  const state = {
    target: opts.target === undefined ? { ...targetDefault } : opts.target,
    audit: null as Record<string, unknown> | null,
    writes: 0,
    auditWrites: 0,
  };
  const permissions = [routePermission, supportPermission];
  const permissionRepo = {
    findPermissionByRoute: async () => (opts.manage === undefined ? routePermission : opts.manage),
    findPermissionsByCodes: async (codes: readonly string[]) =>
      (opts.codes ?? permissions).filter((p) => codes.includes(String(p.permissionCode))),
    listActivePermissions: async () => permissions,
  } as unknown as AdminPermissionRepo;
  const userRepo = {
    findUserByPk: async (id: string) => (id === '90001' ? (opts.actor === undefined ? actorDefault : opts.actor) : state.target),
    lockPermissionTargetUser: async () => state.target,
    updateUserPermissions: async (input: { permissions: readonly string[]; expectedAuthVersion: string }) => {
      state.writes += 1;
      if (!state.target || state.target.authVersion !== input.expectedAuthVersion) return 0;
      state.target = { ...state.target, permissions: [...input.permissions], authVersion: String(BigInt(input.expectedAuthVersion) + 1n) };
      return 1;
    },
  } as unknown as AdminUserRepo;
  const auditRepo = {
    findPermissionAuditByRequestKey: async (key: string) => (state.audit?.requestKey === key ? state.audit : null),
    listPermissionAuditsForTarget: async () => (state.audit ? [state.audit] : []),
    createAuditEvent: async (input: Record<string, unknown>) => {
      state.auditWrites += 1;
      if (opts.auditFailure) throw new Error('audit insert failed');
      const event = { id: '70001', createdAt: '2026-11-08T12:00:00.000Z', ...input };
      state.audit = event;
      return { inserted: true, event };
    },
  } as unknown as AdminAuditEventRepo;
  return { useCase: new AdminPermissionsManageUseCase(permissionRepo, userRepo, auditRepo), state };
}

const input = {
  actorUserId: '90001',
  actorSessionKey: 'sid',
  targetUserId: '90002',
  permissionCodes: ['admin.support.claim'],
  requestKey: 'request-0001',
  reason: '客服值班授权',
  ipHashHex: '0'.repeat(64),
  tx: { transaction: null },
};

test('updates only active directory grants and appends audit with incremented auth version', async () => {
  const { useCase, state } = fixture();
  const result = await useCase.update(input);
  assert.deepEqual(result.user.permissions, ['admin.support.claim']);
  assert.equal(result.user.authVersion, '5');
  assert.equal(result.audit.previousAuthVersion, '4');
  assert.equal(result.audit.nextAuthVersion, '5');
  assert.equal(state.auditWrites, 1);
  const auditList = await useCase.listUserAuditEvents({ targetAdminUserId: '90002', tx: input.tx });
  assert.equal(auditList[0]?.auditId, '70001');
  assert.equal(auditList[0]?.action, 'PERMISSIONS_UPDATED');
});

test('requires an active current actor and exact management route grant', async () => {
  await assert.rejects(() => fixture({ actor: { ...actorDefault, permissions: [] } }).useCase.update(input), /manage/);
  await assert.rejects(() => fixture({ manage: { ...routePermission, status: 2 } }).useCase.update(input));
  await assert.rejects(() => fixture({ actor: { ...actorDefault, roleType: 1 } }).useCase.update(input));
});

test('rejects unknown permissions and no-op assignments without writing', async () => {
  await assert.rejects(() => fixture({ codes: [] }).useCase.update(input), /未登记/);
  const { useCase, state } = fixture({ target: { ...targetDefault, permissions: ['admin.support.claim'] } });
  await assert.rejects(() => useCase.update(input), /没有变化/);
  assert.equal(state.writes, 0);
  await assert.rejects(
    () => fixture().useCase.update({ ...input, permissionCodes: ['admin.support.claim', 'admin.support.claim'] }),
    /重复/,
  );
});

test('replays matching request key without a second grant or audit insert', async () => {
  const { useCase, state } = fixture();
  const first = await useCase.update(input);
  const replay = await useCase.update(input);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(state.writes, 1);
  assert.equal(state.auditWrites, 1);
});

test('audit write uses supplied transaction and failure propagates for rollback', async () => {
  const { useCase, state } = fixture({ auditFailure: true });
  await assert.rejects(() => useCase.update(input), /audit insert failed/);
  // Real rollback is owned by the route transaction; this fixture confirms update was attempted before audit.
  assert.equal(state.writes, 1);
  assert.equal(state.auditWrites, 1);
});
