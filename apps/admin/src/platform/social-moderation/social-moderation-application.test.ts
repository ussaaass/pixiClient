import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { Value } from '@sinclair/typebox/value';
import { SocialContentStatus, SocialModerationAction, SocialModerationCaseStatus, SocialModerationDecisionResponseSchema } from '@gameing/contracts/social';
import { createSocialModerationApplication } from './social-moderation-application';
import { IndexedDbSocialModerationAdapter } from './indexeddb-social-moderation-adapter';

let app: ReturnType<typeof createSocialModerationApplication>;
beforeEach(() => { app = createSocialModerationApplication(new IndexedDbSocialModerationAdapter(`social-moderation-test-${crypto.randomUUID()}`)); });

describe('Social moderation offline DDD flow', () => {
  it('validates filters and advances stable cursor pages', async () => {
    expect(await app.list({ caseStatus: 0 })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    const first = await app.list({ caseStatus: SocialModerationCaseStatus.OPEN, pageSize: 2 });
    expect(first.ok && first.value.items.map((item) => item.caseId)).toHaveLength(2);
    expect(first.ok && first.value.total).toBe(4);
    const second = await app.list({ caseStatus: SocialModerationCaseStatus.OPEN, pageSize: 2, cursor: '3' });
    expect(second.ok && second.value.items).toHaveLength(2);
    expect(first.ok && second.ok && first.value.items.some((item) => item.caseId === second.value.items[0]?.caseId)).toBe(false);
  });

  it('approves pending content, records an immutable reason and safely replays the command', async () => {
    const request = { action: SocialModerationAction.APPROVE, reason: '内容符合社区规范，审核后发布。', requestKey: 'c1111111-1111-4111-8111-111111111111' };
    const first = await app.decide('97001', request);
    expect(first.ok && Value.Check(SocialModerationDecisionResponseSchema, first.value)).toBe(true);
    expect(first.ok && first.value.item.contentStatus).toBe(SocialContentStatus.PUBLISHED);
    expect(first.ok && first.value.item.caseStatus).toBe(SocialModerationCaseStatus.RESOLVED);
    const replay = await app.decide('97001', request);
    expect(replay.ok && replay.value.audit.auditId).toBe(first.ok ? first.value.audit.auditId : null);
    expect(await app.decide('97001', { ...request, reason: '修改后的理由。' })).toEqual({ ok: false, code: 'REQUEST_KEY_REUSED' });
    const audits = await app.listAudits('97001');
    expect(audits.ok && audits.value).toHaveLength(1);
    expect(audits.ok && audits.value[0]?.reason).toBe(request.reason);
    expect(audits.ok && audits.value[0]?.reviewerAdminUserId).toBe('90001');
  });

  it('hides and restores public content, dismisses a false report without changing content', async () => {
    const hidden = await app.decide('97002', { action: SocialModerationAction.HIDE, reason: '内容包含针对用户的侮辱性表达。', requestKey: 'c2222222-2222-4222-8222-222222222222' });
    expect(hidden.ok && hidden.value.item.contentStatus).toBe(SocialContentStatus.HIDDEN);
    const restored = await app.decide('97003', { action: SocialModerationAction.RESTORE, reason: '复核确认举报不成立，恢复原内容。', requestKey: 'c3333333-3333-4333-8333-333333333333' });
    expect(restored.ok && restored.value.item.contentStatus).toBe(SocialContentStatus.PUBLISHED);
    const dismissed = await app.decide('97004', { action: SocialModerationAction.DISMISS, reason: '复核未发现违反社区规范的内容。', requestKey: 'c4444444-4444-4444-8444-444444444444' });
    expect(dismissed.ok && dismissed.value.item.caseStatus).toBe(SocialModerationCaseStatus.DISMISSED);
    expect(dismissed.ok && dismissed.value.item.contentStatus).toBe(SocialContentStatus.PUBLISHED);
    expect(await app.decide('97002', { action: SocialModerationAction.APPROVE, reason: '状态转换不适用。', requestKey: 'c5555555-5555-4555-8555-555555555555' })).toEqual({ ok: false, code: 'CASE_ALREADY_CLOSED' });
  });

  it('rejects invalid transitions and whitespace-only reasons before mutation', async () => {
    expect(await app.decide('97002', { action: SocialModerationAction.APPROVE, reason: '该操作不适用于已发布内容。', requestKey: 'c6666666-6666-4666-8666-666666666666' })).toEqual({ ok: false, code: 'INVALID_TRANSITION' });
    expect(await app.decide('97001', { action: SocialModerationAction.DISMISS, reason: '待审核内容不能直接驳回举报并关闭案件。', requestKey: 'c6666666-6666-4666-8666-666666666667' })).toEqual({ ok: false, code: 'INVALID_TRANSITION' });
    expect(await app.decide('97001', { action: SocialModerationAction.APPROVE, reason: '   ', requestKey: 'c7777777-7777-4777-8777-777777777777' })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    const stillPending = await app.list({ caseStatus: SocialModerationCaseStatus.OPEN, keyword: '海盐汽水' });
    expect(stillPending.ok && stillPending.value.items[0]?.contentStatus).toBe(SocialContentStatus.PENDING_REVIEW);
    expect(stillPending.ok && stillPending.value.items[0]?.caseStatus).toBe(SocialModerationCaseStatus.OPEN);
  });
});
