import { AgentAuditActionCode, AgentAuditResultType, type AgentAuditEventDto } from '@gameing/contracts/agent-audit';
import { AgentSocialSource, type AgentSocialConversationDto, type AgentSocialConversationReadRequestDto, type AgentSocialConversationReadResponseDto, type AgentSocialConversationListResponseDto, type AgentSocialModerationDecisionResponseDto } from '@gameing/contracts/agent-social';
import type { SocialMessageDto, SocialModerationDecisionRequestDto, SocialModerationListResponseDto, SocialModerationQueryDto } from '@gameing/contracts/social';
import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase } from '../browser-development-database';
import type { AgentSocialRepositoryPort } from './agent-social-application';
import { IndexedDbSocialModerationAdapter } from '../social-moderation/indexeddb-social-moderation-adapter';
import { applyModerationDecision } from '../social-moderation/social-moderation-domain';

const demoConversations: AgentSocialConversationDto[] = [
  { conversationId: '93001', agentDomainId: '92001', participants: [{ userId: '94001', displayName: '陈先生' }, { userId: '94002', displayName: '林女士' }], messageCount: 3, lastMessageAt: '2026-10-15T10:04:00.000Z' },
  { conversationId: '93002', agentDomainId: '92001', participants: [{ userId: '94003', displayName: '周先生' }, { userId: '94004', displayName: '许女士' }], messageCount: 2, lastMessageAt: '2026-10-14T08:22:00.000Z' },
  { conversationId: '93003', agentDomainId: '92002', participants: [{ userId: '94005', displayName: '赵先生' }, { userId: '94006', displayName: '吴女士' }], messageCount: 1, lastMessageAt: '2026-10-14T07:00:00.000Z' },
];
const demoMessages: Record<string, SocialMessageDto[]> = {
  '93001': [
    { messageId: '95001', conversationId: '93001', clientMessageId: 'c0000001-0001-4001-8001-000000000001', senderUserId: '94001', body: '你好，我想确认一下这周的活动时间。', createdAt: '2026-10-15T10:01:00.000Z' },
    { messageId: '95002', conversationId: '93001', clientMessageId: 'c0000001-0001-4001-8001-000000000002', senderUserId: '94002', body: '周五晚上八点开始，活动页也会显示规则。', createdAt: '2026-10-15T10:02:00.000Z' },
    { messageId: '95003', conversationId: '93001', clientMessageId: 'c0000001-0001-4001-8001-000000000003', senderUserId: '94001', body: '收到，谢谢。', createdAt: '2026-10-15T10:04:00.000Z' },
  ],
  '93002': [
    { messageId: '95004', conversationId: '93002', clientMessageId: 'c0000002-0002-4002-8002-000000000001', senderUserId: '94003', body: '我提交的客服问题有人跟进吗？', createdAt: '2026-10-14T08:20:00.000Z' },
    { messageId: '95005', conversationId: '93002', clientMessageId: 'c0000002-0002-4002-8002-000000000002', senderUserId: '94004', body: '客服工单已经受理，可以在客服中心查看进度。', createdAt: '2026-10-14T08:22:00.000Z' },
  ],
  '93003': [
    { messageId: '95006', conversationId: '93003', clientMessageId: 'c0000003-0003-4003-8003-000000000001', senderUserId: '94005', body: '这段对话属于另一个代理域。', createdAt: '2026-10-14T07:00:00.000Z' },
  ],
};

export class IndexedDbAgentSocialAdapter implements AgentSocialRepositoryPort {
  private databasePromise: ReturnType<typeof openAdminDevelopmentDatabase> | null = null;
  private readonly socialModeration: IndexedDbSocialModerationAdapter;
  constructor(private readonly databaseName = ADMIN_DEVELOPMENT_DATABASE) { this.socialModeration = new IndexedDbSocialModerationAdapter(databaseName); }
  close(): void { void this.databasePromise?.then((db) => db.close()); this.databasePromise = null; }
  async listConversations(agentDomainId: string): Promise<AgentSocialConversationListResponseDto> {
    return { conversations: structuredClone(demoConversations.filter((conversation) => conversation.agentDomainId === agentDomainId)), source: AgentSocialSource.LOCAL_DEMO };
  }
  async listModerationCases(agentDomainId: string, query: SocialModerationQueryDto): Promise<SocialModerationListResponseDto> {
    await this.socialModeration.list({});
    const keyword = query.keyword?.trim().toLocaleLowerCase();
    const all = (await (await this.database()).getAll('social_moderation_cases'))
      .filter((item) => item.agentDomainId === agentDomainId)
      .filter((item) => query.resourceType === undefined || item.resourceType === query.resourceType)
      .filter((item) => query.caseStatus === undefined || item.caseStatus === query.caseStatus)
      .filter((item) => !keyword || `${item.topicTitle} ${item.contentTitle} ${item.contentBody} ${item.authorLabel} ${item.caseId} ${item.resourceId}`.toLocaleLowerCase().includes(keyword))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.caseId.localeCompare(left.caseId));
    const pageSize = query.pageSize ?? 20;
    const start = query.cursor ? Number(query.cursor) - 1 : 0;
    const items = all.slice(start, start + pageSize);
    const next = start + items.length;
    return { items, total: all.length, nextCursor: next < all.length ? String(next + 1) : null };
  }
  async decideModerationCase(agentDomainId: string, agentUserId: string, caseId: string, request: SocialModerationDecisionRequestDto): Promise<AgentSocialModerationDecisionResponseDto | 'NOT_FOUND' | 'CASE_ALREADY_CLOSED' | 'REQUEST_KEY_REUSED' | 'INVALID_TRANSITION'> {
    await this.socialModeration.list({});
    const db = await this.database();
    const transaction = db.transaction(['social_moderation_cases', 'agent_audit_events'], 'readwrite');
    const cases = transaction.objectStore('social_moderation_cases');
    const audits = transaction.objectStore('agent_audit_events');
    const previous = await audits.index('by-request-key').get(request.requestKey);
    if (previous) {
      await transaction.done;
      if (previous.agentDomainId !== agentDomainId || previous.agentUserId !== agentUserId || previous.actionCode !== AgentAuditActionCode.SOCIAL_MODERATION_DECISION || previous.resourceKey !== caseId || previous.purpose !== request.reason.trim() || previous.snapshot.action !== request.action) return 'REQUEST_KEY_REUSED';
      if (previous.resultType === AgentAuditResultType.DENIED) return 'NOT_FOUND';
      const item = await db.get('social_moderation_cases', caseId);
      if (!item || item.agentDomainId !== agentDomainId) return 'NOT_FOUND';
      return { item, audit: previous };
    }
    const item = await cases.get(caseId);
    if (!item || item.agentDomainId !== agentDomainId) {
      const audit = createAgentAudit(agentDomainId, agentUserId, AgentAuditActionCode.SOCIAL_MODERATION_DECISION, 'SOCIAL_MODERATION_CASE', caseId, request.reason.trim(), request.requestKey, AgentAuditResultType.DENIED, { denied: 'NOT_FOUND', action: request.action });
      await audits.add(audit);
      await transaction.done;
      return 'NOT_FOUND';
    }
    const result = applyModerationDecision(item, { ...request, reason: request.reason.trim() });
    if (typeof result === 'string') { await transaction.done; return result; }
    const audit = createAgentAudit(agentDomainId, agentUserId, AgentAuditActionCode.SOCIAL_MODERATION_DECISION, 'SOCIAL_MODERATION_CASE', caseId, request.reason.trim(), request.requestKey, AgentAuditResultType.SUCCESS, { action: request.action, previousStatus: result.previousStatus, nextStatus: result.nextStatus });
    await cases.put(result.item);
    await audits.add(audit);
    await transaction.done;
    return { item: result.item, audit };
  }
  async readConversation(agentDomainId: string, agentUserId: string, conversationId: string, request: AgentSocialConversationReadRequestDto): Promise<AgentSocialConversationReadResponseDto | 'NOT_FOUND' | 'REQUEST_KEY_REUSED'> {
    const conversation = demoConversations.find((item) => item.conversationId === conversationId && item.agentDomainId === agentDomainId);
    const messages = conversation ? demoMessages[conversationId] : undefined;
    const db = await this.database();
    const transaction = db.transaction('agent_audit_events', 'readwrite');
    const audits = transaction.store;
    const previous = await audits.index('by-request-key').get(request.requestKey);
    if (previous) {
      await transaction.done;
      if (previous.agentDomainId !== agentDomainId || previous.agentUserId !== agentUserId || previous.actionCode !== AgentAuditActionCode.PRIVATE_MESSAGE_READ || previous.resourceKey !== conversationId || previous.purpose !== request.reason.trim()) return 'REQUEST_KEY_REUSED';
      return conversation && messages ? { conversation: structuredClone(conversation), messages: structuredClone(messages), source: AgentSocialSource.LOCAL_DEMO } : 'NOT_FOUND';
    }
    const audit: AgentAuditEventDto = {
      auditId: createAuditId(), agentDomainId, agentUserId, actionCode: AgentAuditActionCode.PRIVATE_MESSAGE_READ,
      resourceType: 'SOCIAL_CONVERSATION', resourceKey: conversationId, purpose: request.reason.trim(), requestKey: request.requestKey,
      resultType: conversation && messages ? AgentAuditResultType.SUCCESS : AgentAuditResultType.DENIED,
      snapshot: conversation && messages ? { messageCount: messages.length } : { denied: 'NOT_FOUND' }, createdAt: new Date().toISOString(),
    };
    await audits.add(audit);
    await transaction.done;
    return conversation && messages ? { conversation: structuredClone(conversation), messages: structuredClone(messages), source: AgentSocialSource.LOCAL_DEMO } : 'NOT_FOUND';
  }
  private database(): ReturnType<typeof openAdminDevelopmentDatabase> { return this.databasePromise ??= openAdminDevelopmentDatabase(this.databaseName); }
}

function createAuditId(): string { return String(BigInt(Date.now()) * 1_000_000n + BigInt(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000)); }
function createAgentAudit(agentDomainId: string, agentUserId: string, actionCode: typeof AgentAuditActionCode[keyof typeof AgentAuditActionCode], resourceType: string, resourceKey: string, purpose: string, requestKey: string, resultType: typeof AgentAuditResultType[keyof typeof AgentAuditResultType], snapshot: Record<string, string | number>): AgentAuditEventDto {
  return { auditId: createAuditId(), agentDomainId, agentUserId, actionCode, resourceType, resourceKey, purpose, requestKey, resultType, snapshot, createdAt: new Date().toISOString() };
}
