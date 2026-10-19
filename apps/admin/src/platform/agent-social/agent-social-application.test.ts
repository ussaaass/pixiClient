import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentAuditActionCode, AgentAuditResultType } from '@gameing/contracts/agent-audit';
import { AgentCapabilityCode } from '@gameing/contracts/invite-agent';
import { SocialModerationAction } from '@gameing/contracts/social';
import { createAgentSocialApplication } from './agent-social-application';
import { IndexedDbAgentSocialAdapter } from './indexeddb-agent-social-adapter';
import { openAdminDevelopmentDatabase } from '../browser-development-database';

let databaseName = '';
beforeEach(() => { databaseName = `agent-social-test-${crypto.randomUUID()}`; });
afterEach(async () => { const db = await openAdminDevelopmentDatabase(databaseName); db.close(); indexedDB.deleteDatabase(databaseName); });

describe('Agent social private-message read flow', () => {
  it('filters by domain and records a private-message read without copying message text to audit', async () => {
    const adapter = new IndexedDbAgentSocialAdapter(databaseName);
    const app = createAgentSocialApplication(adapter, scope());
    const list = await app.list({});
    expect(list).toMatchObject({ ok: true, value: { source: 'LOCAL_DEMO', conversations: [{ conversationId: '93001' }, { conversationId: '93002' }] } });
    if (!list.ok) return;
    expect(list.value.conversations.every((conversation) => conversation.agentDomainId === '92001')).toBe(true);
    const moderation = await app.listModeration({});
    expect(moderation).toMatchObject({ ok: true, value: { items: [{ caseId: '97002', agentDomainId: '92001' }] } });

    const request = { reason: '处理用户申诉工单', requestKey: crypto.randomUUID() };
    const result = await app.read('93001', request);
    expect(result).toMatchObject({ ok: true, value: { conversation: { conversationId: '93001' }, messages: expect.arrayContaining([expect.objectContaining({ body: '你好，我想确认一下这周的活动时间。' })]) } });
    expect(await app.read('93001', request)).toEqual(result);
    expect(await createAgentSocialApplication(adapter, scope('92009')).read('93001', request)).toEqual({ ok: false, code: 'REQUEST_KEY_REUSED' });
    expect(await app.read('93003', { reason: '越域访问测试', requestKey: crypto.randomUUID() })).toEqual({ ok: false, code: 'NOT_FOUND' });

    const db = await openAdminDevelopmentDatabase(databaseName);
    const audits = await db.getAll('agent_audit_events');
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ actionCode: AgentAuditActionCode.PRIVATE_MESSAGE_READ, resourceType: 'SOCIAL_CONVERSATION', resourceKey: '93001', purpose: request.reason, resultType: AgentAuditResultType.SUCCESS, snapshot: { messageCount: 3 } });
    expect(JSON.stringify(audits)).not.toContain('确认一下这周的活动时间');
    expect(audits[1]).toMatchObject({ resultType: AgentAuditResultType.DENIED, snapshot: { denied: 'NOT_FOUND' } });
    db.close();
    adapter.close?.();
  });

  it('moderates only current-domain content and atomically audits a retryable decision', async () => {
    const adapter = new IndexedDbAgentSocialAdapter(databaseName);
    const app = createAgentSocialApplication(adapter, scope());
    const request = { action: SocialModerationAction.HIDE, reason: '举报内容确认违反社区规范', requestKey: crypto.randomUUID() };
    const result = await app.decideModeration('97002', request);
    expect(result).toMatchObject({ ok: true, value: { item: { caseId: '97002', contentStatus: 'HIDDEN', caseStatus: 2 }, audit: { actionCode: 'SOCIAL_MODERATION_DECISION', resourceKey: '97002' } } });
    expect(await app.decideModeration('97002', request)).toEqual(result);
    expect(await createAgentSocialApplication(adapter, scope('92009')).decideModeration('97002', request)).toEqual({ ok: false, code: 'REQUEST_KEY_REUSED' });
    expect(await app.decideModeration('97001', { ...request, requestKey: crypto.randomUUID() })).toEqual({ ok: false, code: 'NOT_FOUND' });
    const db = await openAdminDevelopmentDatabase(databaseName);
    const events = await db.getAll('agent_audit_events');
    expect(events.filter((event) => event.actionCode === 'SOCIAL_MODERATION_DECISION')).toHaveLength(2);
    expect(events[0]?.snapshot).toMatchObject({ action: SocialModerationAction.HIDE, previousStatus: 'PUBLISHED', nextStatus: 'HIDDEN' });
    expect(events[0]?.snapshot).not.toHaveProperty('contentBody');
    db.close();
    adapter.close?.();
  });

  it('rejects missing capability, invalid inputs and idempotency-key reuse', async () => {
    const adapter = new IndexedDbAgentSocialAdapter(databaseName);
    const app = createAgentSocialApplication(adapter, scope());
    expect(await app.list({ agentDomainId: '92001' })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await app.read('0', { reason: '查看私聊', requestKey: crypto.randomUUID() })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await app.read('93001', { reason: '   ', requestKey: crypto.randomUUID() })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    const key = crypto.randomUUID();
    expect((await app.read('93001', { reason: '日常检查', requestKey: key })).ok).toBe(true);
    expect(await app.read('93001', { reason: '用途已更改', requestKey: key })).toEqual({ ok: false, code: 'REQUEST_KEY_REUSED' });
    expect(await createAgentSocialApplication(adapter, { resolve: () => null }).list({})).toEqual({ ok: false, code: 'SCOPE_UNAVAILABLE' });
    adapter.close?.();
  });
});

function scope(agentUserId = '92000') {
  return { resolve(capability: string) { return capability === AgentCapabilityCode.SOCIAL_READ_PRIVATE_MESSAGES || capability === AgentCapabilityCode.SOCIAL_MODERATE ? { agentDomainId: '92001', agentUserId } : null; } };
}
