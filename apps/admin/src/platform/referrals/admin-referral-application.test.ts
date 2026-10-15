import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createAdminReferralApplication } from './admin-referral-application';
import { createIndexedDbAdminReferralRepository } from './indexeddb-admin-referral-adapter';

describe('admin referral local demo application', () => {
  it('filters, previews, rejects a bad TOTP, preserves reward history, and completes the social migration demo', async () => {
    const app = createAdminReferralApplication(createIndexedDbAdminReferralRepository(`referral-test-${crypto.randomUUID()}`));
    const before = await app.detail('94001');
    expect(before.binding.ancestors.parent1UserId).toBe('94002');
    expect(before.allocations).toHaveLength(1);
    expect((await app.list({ parent1UserId: '94002' })).items.map((row) => row.userId)).toContain('94001');
    expect((await app.list({ rewardType: 2 })).items.map((row) => row.userId)).toContain('94014');

    const preview = await app.preview('94001', '94100');
    expect(preview.affectedUsers.map((row) => row.userId)).toEqual(['94001', '94011', '94012', '94013']);
    expect(preview.historicalAllocationsUnchanged).toBe(true);
    await expect(app.rebind({ requestKey: 'bad-totp-0001', previewKey: preview.previewKey, workspaceRevision: preview.workspaceRevision, userId: '94001', newParent1UserId: '94100', reason: '测试换绑原因', totpCode: '000000' })).rejects.toThrow('TOTP_INVALID');

    const saved = await app.rebind({ requestKey: 'good-totp-0001', previewKey: preview.previewKey, workspaceRevision: preview.workspaceRevision, userId: '94001', newParent1UserId: '94100', reason: '测试换绑原因', totpCode: app.demoTotp });
    expect(saved.affectedCount).toBe(4);
    expect(saved.migrationTasks).toHaveLength(4);
    await expect(app.rebind({ requestKey: 'good-totp-0001', previewKey: preview.previewKey, workspaceRevision: preview.workspaceRevision, userId: '94001', newParent1UserId: '94100', reason: '测试换绑原因', totpCode: app.demoTotp })).resolves.toEqual(saved);
    const after = await app.detail('94001');
    expect(after.binding.ancestors.parent1UserId).toBe('94100');
    expect(after.allocations[0]).toEqual(before.allocations[0]);
    expect(after.events).toHaveLength(1);
    expect(after.migrationTasks[0]?.status).toBe(1);

    const processed = await app.processMigration(after.migrationTasks[0]!.taskId);
    expect(processed.remainingPendingTasks).toBe(3);
    expect((await app.detail('94001')).migrationTasks[0]?.status).toBe(2);
  });

  it('rejects a cyclic new parent and stale previews', async () => {
    const app = createAdminReferralApplication(createIndexedDbAdminReferralRepository(`referral-errors-${crypto.randomUUID()}`));
    await expect(app.preview('94001', '94011')).rejects.toThrow('REFERRAL_CYCLE');
    const preview = await app.preview('94001', '94100');
    await app.processMigration('98000').catch(() => undefined);
    await app.rebind({ requestKey: 'first-bind-0001', previewKey: preview.previewKey, workspaceRevision: preview.workspaceRevision, userId: '94001', newParent1UserId: '94100', reason: '测试有效换绑', totpCode: app.demoTotp });
    await expect(app.rebind({ requestKey: 'stale-bind-0001', previewKey: preview.previewKey, workspaceRevision: preview.workspaceRevision, userId: '94001', newParent1UserId: '94100', reason: '测试过期预览', totpCode: app.demoTotp })).rejects.toThrow('PREVIEW_STALE');
  });
});
