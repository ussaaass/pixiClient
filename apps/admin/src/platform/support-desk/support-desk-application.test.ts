import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { Value } from '@sinclair/typebox/value';
import { SupportConversationStatus, SupportDeskDetailResponseSchema, SupportSenderType } from '@gameing/contracts/support';
import { createSupportDeskApplication } from './support-desk-application';
import { IndexedDbSupportDeskAdapter } from './indexeddb-support-desk-adapter';

let app: ReturnType<typeof createSupportDeskApplication>;

beforeEach(() => {
  app = createSupportDeskApplication(new IndexedDbSupportDeskAdapter(`support-desk-test-${crypto.randomUUID()}`));
});

describe('Admin support desk local DDD flow', () => {
  it('filters, reads a seeded conversation and claims it before replying', async () => {
    const invalid = await app.list({ status: 0 });
    expect(invalid).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    const queue = await app.list({ keyword: '登录', pageSize: 10 });
    expect(queue.ok && queue.value.total).toBe(1);
    expect(queue.ok && queue.value.items[0]?.customerDisplayName).toBe('林先生');
    const detail = await app.detail('93001');
    expect(detail.ok && detail.value.messages).toHaveLength(1);
    expect(detail.ok && detail.value.messages[0]?.senderType).toBe(SupportSenderType.CUSTOMER);
    if (detail.ok) expect(Value.Check(SupportDeskDetailResponseSchema, detail.value)).toBe(true);

    const claimRequest = { requestKey: 'b1111111-1111-4111-8111-111111111111' };
    const claim = await app.claim('93001', claimRequest);
    expect(claim.ok && claim.value.item.assignedAdminUserId).toBe('90001');
    const claimRetry = await app.claim('93001', claimRequest);
    expect(claimRetry.ok && claimRetry.value.item.assignedAdminUserId).toBe('90001');
    expect(await app.resolve('93001', claimRequest)).toEqual({ ok: false, code: 'REQUEST_KEY_REUSED' });
    const replyRequest = { bodyText: '请在账号入口选择“恢复本设备”，客服不会索取您的验证码。', messageKey: 'b2222222-2222-4222-8222-222222222222' };
    const sent = await app.reply('93001', replyRequest);
    expect(sent.ok && sent.value.item.conversation.status).toBe(SupportConversationStatus.WAITING_USER);
    expect(sent.ok && sent.value.messages).toHaveLength(2);
    expect(sent.ok && sent.value.messages[1]?.senderType).toBe(SupportSenderType.ADMIN);
    const retry = await app.reply('93001', replyRequest);
    expect(retry.ok && retry.value.messages).toHaveLength(2);
  });

  it('uses stable cursor pages without repeating a conversation', async () => {
    const first = await app.list({ pageSize: 2 });
    expect(first.ok && first.value.items).toHaveLength(2);
    expect(first.ok && first.value.nextCursor).toBe('3');
    const cursor = first.ok ? first.value.nextCursor : null;
    const second = await app.list({ pageSize: 2, ...(cursor ? { cursor } : {}) });
    expect(second.ok && second.value.items).toHaveLength(1);
    expect(first.ok && second.ok && first.value.items.some((item) => item.conversation.conversationId === second.value.items[0]?.conversation.conversationId)).toBe(false);
  });

  it('preserves closed history and supports reopen and resolve transitions', async () => {
    const cannotReply = await app.reply('93003', { bodyText: '已结束的会话不能回复。', messageKey: 'b3333333-3333-4333-8333-333333333333' });
    expect(cannotReply).toEqual({ ok: false, code: 'CLOSED' });
    const reopened = await app.reopen('93003', { requestKey: 'b4444444-4444-4444-8444-444444444444' });
    expect(reopened.ok && reopened.value.item.conversation.status).toBe(SupportConversationStatus.WAITING_SUPPORT);
    const resolved = await app.resolve('93003', { requestKey: 'b5555555-5555-4555-8555-555555555555' });
    expect(resolved.ok && resolved.value.item.conversation.status).toBe(SupportConversationStatus.CLOSED);
    const filtered = await app.list({ status: SupportConversationStatus.CLOSED });
    expect(filtered.ok && filtered.value.items.some((item) => item.conversation.conversationId === '93003')).toBe(true);
  });

  it('does not allow responding to an unclaimed conversation or replaying a key with a different body', async () => {
    const denied = await app.reply('93001', { bodyText: '未领取不得回复', messageKey: 'b6666666-6666-4666-8666-666666666666' });
    expect(denied).toEqual({ ok: false, code: 'ASSIGNED_TO_OTHER' });
    await app.claim('93001', { requestKey: 'b7777777-7777-4777-8777-777777777777' });
    const key = 'b8888888-8888-4888-8888-888888888888';
    expect((await app.reply('93001', { bodyText: '首次内容', messageKey: key })).ok).toBe(true);
    expect(await app.reply('93001', { bodyText: '另一段内容', messageKey: key })).toEqual({ ok: false, code: 'REQUEST_KEY_REUSED' });
  });
});
