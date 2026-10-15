import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { AdminAuditActionCode, AdminAuditResultType, AdminAuditSource, type AdminAuditDto } from '@gameing/admin-contracts/admin-audit';
import { openAdminDevelopmentDatabase } from '../browser-development-database';
import { createAdminAuditApplication } from './admin-audit-application';
import { IndexedDbAdminAuditAdapter } from './indexeddb-admin-audit-adapter';

const event = (overrides: Partial<AdminAuditDto> = {}): AdminAuditDto => ({
  auditId: 'permission:audit-1', adminUserId: '90001', adminDisplayName: '本机演练管理员', targetUserId: '90002',
  requestId: 'request-key-1', actionCode: AdminAuditActionCode.PERMISSIONS_UPDATED, resultType: AdminAuditResultType.SUCCESS,
  resourceType: 'ADMIN_USER', resourceKey: '90002', reason: '测试权限变更', beforeSummary: 'admin.users.read',
  afterSummary: 'admin.users.read, admin.audit.read', source: AdminAuditSource.LOCAL_DEMO, createdAt: '2026-10-15T09:00:00.000Z', ...overrides,
});

describe('Admin audit read projection', () => {
  it('filters and pages normalized audit events without mutating them', async () => {
    const events = [event(), event({ auditId: 'payment:change-2', targetUserId: null, requestId: 'request-key-2', actionCode: AdminAuditActionCode.PAYMENT_CHANNEL_SAVED, resourceType: 'PAYMENT_CHANNEL', resourceKey: '12002', reason: '调整渠道展示顺序', beforeSummary: '第二位', afterSummary: '第一位', createdAt: '2026-10-15T10:00:00.000Z' })];
    const app = createAdminAuditApplication({ listEvents: async () => events });
    const result = await app.list({ keyword: '渠道', page: 1, pageSize: 1 });
    expect(result).toMatchObject({ ok: true, value: { total: 1, page: 1, pageSize: 1, items: [{ auditId: 'payment:change-2' }] } });
    expect(await app.list({ actionCode: AdminAuditActionCode.PERMISSIONS_UPDATED, adminUserId: '90001' })).toMatchObject({ ok: true, value: { items: [{ auditId: 'permission:audit-1' }] } });
    expect(await app.list({ fromCreatedAt: '2026-10-16T00:00:00.000Z', toCreatedAt: '2026-10-15T00:00:00.000Z' })).toEqual({ ok: false, code: 'INVALID_QUERY' });
    expect(events).toHaveLength(2);
  });

  it('projects stored immutable permission audit facts from IndexedDB without a second audit store', async () => {
    const databaseName = `admin-audit-test-${crypto.randomUUID()}`;
    const database = await openAdminDevelopmentDatabase(databaseName);
    const audit = {
      auditId: 'audit-local-1', requestKey: 'request-key-123', adminUserId: '90001', targetAdminUserId: '90002',
      action: 'PERMISSIONS_UPDATED' as const, previousPermissions: ['admin.users.read'], nextPermissions: ['admin.audit.read', 'admin.users.read'],
      previousAuthVersion: 1, nextAuthVersion: 2, reason: '为演练管理员开放审计查询。', source: 1 as const, createdAt: '2026-10-15T09:15:00.000Z',
    };
    await database.add('admin_permission_audit', audit);
    const adapter = new IndexedDbAdminAuditAdapter(databaseName);
    const events = await adapter.listEvents();
    expect(events).toMatchObject([{
      auditId: 'admin-permission:audit-local-1', adminUserId: '90001', targetUserId: '90002', requestId: 'request-key-123',
      actionCode: AdminAuditActionCode.PERMISSIONS_UPDATED, resourceType: 'ADMIN_USER', source: AdminAuditSource.LOCAL_DEMO,
      beforeSummary: 'admin.users.read', afterSummary: 'admin.audit.read, admin.users.read',
    }]);
    await adapter.close();
    database.close();
  });
});
