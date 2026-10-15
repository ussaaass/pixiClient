import { describe, expect, it } from 'vitest';
import { AdminUserDetailSection, AdminUserRoleType, AdminUserStatus } from '@gameing/admin-contracts/admin-users';
import { createAdminUserApplication, type AdminUserRepositoryPort } from './admin-user-application';
import { LocalDemoAdminUserAdapter } from './local-demo-admin-user-adapter';

describe('Admin user query and detail application', () => {
  it('filters by ID, username, role, and status and returns a cursor page', async () => {
    const app = createAdminUserApplication(new LocalDemoAdminUserAdapter());
    expect(await app.list({ roleType: AdminUserRoleType.PLAYER_AGENT, status: AdminUserStatus.ACTIVE, pageSize: 1 }))
      .toMatchObject({ ok: true, value: { total: 2, items: [{ userId: '91002' }], nextCursor: '1' } });
    expect(await app.list({ username: 'closed' })).toMatchObject({ ok: true, value: { total: 1, items: [{ userId: '91005' }] } });
    expect(await app.list({ userId: '91001' })).toMatchObject({ ok: true, value: { total: 1, items: [{ userId: '91001' }] } });
  });

  it('rejects zero filters, out-of-range IDs, and malformed cursors', async () => {
    const app = createAdminUserApplication(new LocalDemoAdminUserAdapter());
    expect(await app.list({ status: 0 })).toEqual({ ok: false, code: 'INVALID_QUERY' });
    expect(await app.list({ userId: '18446744073709551616' })).toEqual({ ok: false, code: 'INVALID_QUERY' });
    expect(await app.list({ cursor: '0' })).toEqual({ ok: false, code: 'INVALID_QUERY' });
    expect(await app.detail('91001', 'UNKNOWN')).toEqual({ ok: false, code: 'INVALID_QUERY' });
  });

  it('loads only a requested validated detail section and distinguishes missing users', async () => {
    const app = createAdminUserApplication(new LocalDemoAdminUserAdapter());
    expect(await app.detail('91001', AdminUserDetailSection.ASSETS)).toMatchObject({
      ok: true, value: { section: AdminUserDetailSection.ASSETS, data: { accounts: expect.arrayContaining([expect.objectContaining({ assetType: 'COIN' })]) } },
    });
    expect(await app.detail('91999', AdminUserDetailSection.OVERVIEW)).toEqual({ ok: false, code: 'USER_NOT_FOUND' });
  });

  it('rejects repository data outside BIGINT UNSIGNED and invalid section DTOs', async () => {
    const base = new LocalDemoAdminUserAdapter();
    const invalidIds: AdminUserRepositoryPort = {
      listSummaries: async () => [{ ...(await base.listSummaries())[0]!, userId: '18446744073709551616' }],
      readSection: (id, section) => base.readSection(id, section),
    };
    expect(await createAdminUserApplication(invalidIds).list({})).toEqual({ ok: false, code: 'INVALID_DATA' });
    const invalidSection: AdminUserRepositoryPort = {
      listSummaries: () => base.listSummaries(),
      readSection: async () => ({ section: AdminUserDetailSection.OVERVIEW, data: {} } as never),
    };
    expect(await createAdminUserApplication(invalidSection).detail('91001', AdminUserDetailSection.OVERVIEW))
      .toEqual({ ok: false, code: 'INVALID_DATA' });
  });
});
