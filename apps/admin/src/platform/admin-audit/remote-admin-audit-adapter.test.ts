import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminAuditActionCode, AdminAuditResultType, AdminAuditSource, type AdminAuditDto } from '@gameing/admin-contracts/admin-audit';
import { AdminApiClient, AdminApiError } from '../admin-api-client.js';
import { RemoteAdminAuditAdapter } from './remote-admin-audit-adapter.js';

const audit: AdminAuditDto = {
  auditId: 'permission:audit-1',
  adminUserId: '90001',
  adminDisplayName: '审计管理员',
  targetUserId: '90002',
  requestId: 'request-1',
  actionCode: AdminAuditActionCode.PERMISSIONS_UPDATED,
  resultType: AdminAuditResultType.SUCCESS,
  resourceType: 'ADMIN_USER',
  resourceKey: '90002',
  reason: '核验权限变更',
  beforeSummary: 'admin.users.read',
  afterSummary: 'admin.users.read, admin.audit.read',
  source: AdminAuditSource.SERVER,
  createdAt: '2026-10-15T09:00:00.000Z',
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('RemoteAdminAuditAdapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses AdminApiClient GET with the existing audit path and page-size query, then returns events', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      code: 'OK',
      message: 'OK',
      data: [audit],
      requestId: 'request-1',
      serverNow: '2026-10-15T09:00:00.000Z',
    }));
    const client = new AdminApiClient({ base: 'https://admin.example.test/admin-api/v1', getToken: () => null });

    await expect(new RemoteAdminAuditAdapter(client).listEvents()).resolves.toEqual([audit]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      'https://admin.example.test/admin-api/v1/admin-audit/events?pageSize=100',
      { method: 'GET', headers: {} },
    );
  });

  it('propagates AdminApiClient errors without inventing a fallback result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      code: 'AUDIT_READ_FAILED',
      message: '审计读取失败',
      data: null,
      requestId: 'request-2',
      serverNow: '2026-10-15T09:00:00.000Z',
    }));
    const client = new AdminApiClient({ base: 'https://admin.example.test/admin-api/v1', getToken: () => null });

    const result = new RemoteAdminAuditAdapter(client).listEvents();
    await expect(result).rejects.toBeInstanceOf(AdminApiError);
    await expect(result).rejects.toMatchObject({ code: 'AUDIT_READ_FAILED', message: '审计读取失败' });
  });
});
