import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { AdminManagedUserStatus } from '@gameing/admin-contracts/admin-permissions';
import { createAdminPermissionApplication } from './admin-permission-application';
import { IndexedDbAdminPermissionAdapter } from './indexeddb-admin-permission-adapter';

let app: ReturnType<typeof createAdminPermissionApplication>;
beforeEach(() => { app = createAdminPermissionApplication(new IndexedDbAdminPermissionAdapter(`admin-permissions-test-${crypto.randomUUID()}`)); });

const changeRequest = (overrides: Record<string, unknown> = {}) => ({
  targetAdminUserId: '90002',
  permissionCodes: ['admin.users.read', 'admin.system-config.read'],
  reason: '为演练账号开放配置查询。',
  requestKey: '44444444-4444-4444-8444-444444444444',
  ...overrides,
});

describe('Admin permission management LOCAL_DEMO workflow', () => {
  it('lists only registered HTTP method/path permission entries and filters accounts', async () => {
    const paths = app.listPaths();
    expect(paths.ok && paths.value.length).toBe(10);
    expect(await app.listUsers({ keyword: '运营' })).toMatchObject({ ok: true, value: [{ userId: '90002' }] });
    expect(await app.listUsers({ status: AdminManagedUserStatus.LOCKED })).toMatchObject({ ok: true, value: [{ userId: '90004' }] });
    expect(await app.listUsers({ permissionCode: 'admin.support.read' })).toMatchObject({ ok: true, value: [{ userId: '90003' }] });
    expect(await app.listUsers({ status: 0 })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
  });

  it('updates the unified Admin user permission JSON, bumps auth version and appends an audit in one transaction', async () => {
    const updated = await app.updatePermissions(changeRequest());
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.user.permissions).toEqual(['admin.system-config.read', 'admin.users.read']);
    expect(updated.value.user.authVersion).toBe(2);
    expect(updated.value.audit.previousPermissions).toEqual(['admin.audit.read', 'admin.users.read']);
    expect(updated.value.audit.adminUserId).toBe('90001');
    expect(await app.listAudits('90002')).toMatchObject({ ok: true, value: [{ nextAuthVersion: 2, reason: '为演练账号开放配置查询。' }] });
    expect(await app.listUsers({ permissionCode: 'admin.audit.read' })).toMatchObject({ ok: true, value: [] });
  });

  it('is idempotent under replay/concurrency and never applies an unknown, locked, or no-op grant', async () => {
    const request = changeRequest();
    const [first, concurrent] = await Promise.all([app.updatePermissions(request), app.updatePermissions(request)]);
    expect(first.ok && concurrent.ok && first.value.user.authVersion).toBe(2);
    expect(concurrent.ok && concurrent.value.audit.auditId).toBe(first.ok ? first.value.audit.auditId : null);
    expect(await app.updatePermissions(request)).toMatchObject({ ok: true, value: { replayed: true } });
    expect(await app.updatePermissions(changeRequest({ targetAdminUserId: '90004', requestKey: '55555555-5555-4555-8555-555555555551' }))).toEqual({ ok: false, code: 'USER_LOCKED' });
    expect(await app.updatePermissions(changeRequest({ permissionCodes: ['admin.not-registered'], requestKey: '55555555-5555-4555-8555-555555555552' }))).toEqual({ ok: false, code: 'UNKNOWN_PERMISSION' });
    expect(await app.updatePermissions(changeRequest({ requestKey: '55555555-5555-4555-8555-555555555553' }))).toEqual({ ok: false, code: 'NO_CHANGE' });
    expect(await app.updatePermissions(changeRequest({ permissionCodes: ['admin.support.read'] }))).toEqual({ ok: false, code: 'REQUEST_KEY_REUSED' });
  });
});
