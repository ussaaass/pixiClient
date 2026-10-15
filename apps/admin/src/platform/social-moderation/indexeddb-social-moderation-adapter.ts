import {
  SocialContentStatus,
  SocialModerationAction,
  SocialModerationCaseStatus,
  SocialModerationResourceType,
  type SocialModerationAuditDto,
  type SocialModerationAuditListResponseDto,
  type SocialModerationCaseDto,
  type SocialModerationDecisionRequestDto,
  type SocialModerationDecisionResponseDto,
  type SocialModerationListResponseDto,
  type SocialModerationQueryDto,
} from '@gameing/contracts/social';
import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase } from '../browser-development-database';
import type { SocialModerationRepositoryPort } from './social-moderation-application';
import { applyModerationDecision } from './social-moderation-domain';

const minsAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const DEMO_CASES: SocialModerationCaseDto[] = [
  { caseId: '97001', resourceType: SocialModerationResourceType.POST, resourceId: '97101', topicTitle: '新手交流', contentTitle: '求好友一起练习', contentBody: '最近开始玩十三张，想找朋友一起练习交流规则。', authorLabel: '海盐汽水', contentStatus: SocialContentStatus.PENDING_REVIEW, caseStatus: SocialModerationCaseStatus.OPEN, reasonCode: 'SPAM', reporterCount: 2, reportSummary: '多位用户反馈短时间重复发布相似内容。', agentDomainId: null, createdAt: minsAgo(21) },
  { caseId: '97002', resourceType: SocialModerationResourceType.REPLY, resourceId: '97102', topicTitle: '牌局讨论', contentTitle: '回复：牌型规则求解', contentBody: '不要再来烦我了。', authorLabel: '夜航船', contentStatus: SocialContentStatus.PUBLISHED, caseStatus: SocialModerationCaseStatus.OPEN, reasonCode: 'HARASSMENT', reporterCount: 1, reportSummary: '被回复用户举报针对性攻击。', agentDomainId: '92001', createdAt: minsAgo(48) },
  { caseId: '97003', resourceType: SocialModerationResourceType.POST, resourceId: '97103', topicTitle: '赛事分享', contentTitle: '周末练习赛记录', contentBody: '分享一下周末的练习赛体验和规则心得。', authorLabel: '陈先生', contentStatus: SocialContentStatus.HIDDEN, caseStatus: SocialModerationCaseStatus.OPEN, reasonCode: 'FALSE_REPORT', reporterCount: 1, reportSummary: '作者申诉原内容已被误隐藏，请复核。', agentDomainId: null, createdAt: minsAgo(92) },
  { caseId: '97004', resourceType: SocialModerationResourceType.REPLY, resourceId: '97104', topicTitle: '新手交流', contentTitle: '回复：规则求解', contentBody: '这里有官方规则链接可以先看看。', authorLabel: '白露', contentStatus: SocialContentStatus.PUBLISHED, caseStatus: SocialModerationCaseStatus.OPEN, reasonCode: 'FALSE_REPORT', reporterCount: 1, reportSummary: '举报未描述违反规范的具体内容。', agentDomainId: null, createdAt: minsAgo(125) },
];

type StoredAudit = SocialModerationAuditDto & { requestKey: string };

export class IndexedDbSocialModerationAdapter implements SocialModerationRepositoryPort {
  constructor(private readonly databaseName = ADMIN_DEVELOPMENT_DATABASE) {}

  async list(query: SocialModerationQueryDto): Promise<SocialModerationListResponseDto> {
    const db = await openAdminDevelopmentDatabase(this.databaseName);
    await this.ensureSeed(db);
    const keyword = query.keyword?.trim().toLocaleLowerCase();
    const all = (await db.getAll('social_moderation_cases'))
      .filter((item) => query.resourceType === undefined || item.resourceType === query.resourceType)
      .filter((item) => query.caseStatus === undefined || item.caseStatus === query.caseStatus)
      .filter((item) => !keyword || `${item.topicTitle} ${item.contentTitle} ${item.contentBody} ${item.authorLabel} ${item.caseId} ${item.resourceId}`.toLocaleLowerCase().includes(keyword))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.caseId.localeCompare(a.caseId));
    const pageSize = query.pageSize ?? 20;
    const start = query.cursor ? Number(query.cursor) - 1 : 0;
    const items = all.slice(start, start + pageSize);
    const next = start + items.length;
    return { items, total: all.length, nextCursor: next < all.length ? String(next + 1) : null };
  }

  async listAudits(caseId: string): Promise<SocialModerationAuditListResponseDto | null> {
    const db = await openAdminDevelopmentDatabase(this.databaseName);
    await this.ensureSeed(db);
    if (!(await db.get('social_moderation_cases', caseId))) return null;
    const rows = await db.getAllFromIndex('social_moderation_audit', 'by-case-created', IDBKeyRange.bound([caseId, ''], [caseId, '\uffff']));
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.auditId.localeCompare(b.auditId)).map(withoutRequestKey);
  }

  async decide(caseId: string, reviewerAdminUserId: string, request: SocialModerationDecisionRequestDto): Promise<SocialModerationDecisionResponseDto | 'NOT_FOUND' | 'CASE_ALREADY_CLOSED' | 'REQUEST_KEY_REUSED' | 'INVALID_TRANSITION'> {
    const db = await openAdminDevelopmentDatabase(this.databaseName);
    await this.ensureSeed(db);
    const transaction = db.transaction(['social_moderation_cases', 'social_moderation_audit'], 'readwrite');
    const cases = transaction.objectStore('social_moderation_cases');
    const auditStore = transaction.objectStore('social_moderation_audit');
    const existing = await auditStore.index('by-request-key').get(request.requestKey);
    if (existing) {
      await transaction.done;
      if (existing.caseId !== caseId || existing.reviewerAdminUserId !== reviewerAdminUserId || existing.action !== request.action || existing.reason !== request.reason.trim()) return 'REQUEST_KEY_REUSED';
      const item = await db.get('social_moderation_cases', caseId);
      if (!item) return 'NOT_FOUND';
      return { item, audit: withoutRequestKey(existing) };
    }
    const item = await cases.get(caseId);
    if (!item) { await transaction.done; return 'NOT_FOUND'; }
    const outcome = applyModerationDecision(item, { ...request, reason: request.reason.trim() });
    if (typeof outcome === 'string') { await transaction.done; return outcome; }
    const createdAt = new Date().toISOString();
    const audit: StoredAudit = {
      auditId: newLocalId(), caseId, action: request.action, reviewerAdminUserId,
      reason: request.reason.trim(), previousStatus: outcome.previousStatus, nextStatus: outcome.nextStatus,
      createdAt, requestKey: request.requestKey,
    };
    await cases.put(outcome.item);
    await auditStore.add(audit);
    await transaction.done;
    return { item: outcome.item, audit: withoutRequestKey(audit) };
  }

  private async ensureSeed(db: Awaited<ReturnType<typeof openAdminDevelopmentDatabase>>): Promise<void> {
    if (await db.count('social_moderation_cases') > 0) return;
    const transaction = db.transaction('social_moderation_cases', 'readwrite');
    for (const item of DEMO_CASES) await transaction.store.put(item);
    await transaction.done;
  }
}

function withoutRequestKey(audit: StoredAudit): SocialModerationAuditDto {
  const { requestKey: _requestKey, ...dto } = audit;
  return dto;
}

function newLocalId(): string {
  return (BigInt(Date.now()) * 1_000n + BigInt(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000)).toString();
}
