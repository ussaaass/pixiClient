import {
  AgentDownlineStatus,
  type AgentDownlineDetailDto,
  type AgentDownlineDto,
  type AgentDownlineListResponseDto,
  type AgentDownlineQueryDto,
  type AgentDownlineDetailReadRequestDto,
} from '@gameing/contracts/agent-downlines';
import { AgentAuditResultType, type AgentAuditEventDto, type AgentAuditListResponseDto, type AgentAuditQueryDto } from '@gameing/contracts/agent-audit';
import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase } from '../browser-development-database';
import type { AgentDownlineReadRepositoryPort } from './agent-downlines-application';

const DEMO_DOWNLINES: AgentDownlineDetailDto[] = [
  {
    downline: { userId: '91001', displayName: '海盐汽水', userStatus: AgentDownlineStatus.ACTIVE, joinedAt: '2026-09-04T05:20:00.000Z', lastActiveAt: '2026-10-15T08:35:00.000Z', directDownlineCount: 2, coinAvailable: '18420', coinFrozen: '500', cnyAvailableFen: '2860', cnyFrozenFen: '0' },
    userRewardType: 1, turnoverRemainingCoins: '0',
    referralChain: [{ level: 1, displayName: '当前代理' }, { level: 2, displayName: '北岸先生' }, { level: 3, displayName: '平台代理' }],
    recentActivities: [
      { activityId: '991001', category: 'GAME_ROUND', summary: '十三张 · 海风厅', amount: '-300', asset: 'COIN', occurredAt: '2026-10-15T08:34:00.000Z' },
      { activityId: '991002', category: 'ASSET_OPERATION', summary: '直属代理转入金币', amount: '5000', asset: 'COIN', occurredAt: '2026-10-14T12:20:00.000Z' },
      { activityId: '991003', category: 'PAYMENT_ORDER', summary: '金币充值 · 已完成', amount: '12000', asset: 'COIN', occurredAt: '2026-10-12T04:05:00.000Z' },
    ],
  },
  {
    downline: { userId: '91002', displayName: '晚风拂柳', userStatus: AgentDownlineStatus.ACTIVE, joinedAt: '2026-09-22T09:10:00.000Z', lastActiveAt: '2026-10-15T07:11:00.000Z', directDownlineCount: 0, coinAvailable: '-120', coinFrozen: '0', cnyAvailableFen: '0', cnyFrozenFen: '2500' },
    userRewardType: 2, turnoverRemainingCoins: '850',
    referralChain: [{ level: 1, displayName: '当前代理' }, { level: 2, displayName: '北岸先生' }],
    recentActivities: [
      { activityId: '992001', category: 'WITHDRAWAL', summary: '提现申请 · 审核中', amount: '2500', asset: 'CNY_FEN', occurredAt: '2026-10-15T07:10:00.000Z' },
      { activityId: '992002', category: 'GAME_ROUND', summary: '跳高高 · 经典厅', amount: '-1800', asset: 'COIN', occurredAt: '2026-10-15T07:02:00.000Z' },
    ],
  },
  {
    downline: { userId: '91003', displayName: '青柠汽泡', userStatus: AgentDownlineStatus.SUSPENDED, joinedAt: '2026-08-18T01:40:00.000Z', lastActiveAt: null, directDownlineCount: 0, coinAvailable: '0', coinFrozen: '0', cnyAvailableFen: '0', cnyFrozenFen: '0' },
    userRewardType: 1, turnoverRemainingCoins: '0', referralChain: [{ level: 1, displayName: '当前代理' }],
    recentActivities: [{ activityId: '993001', category: 'ASSET_OPERATION', summary: '账号暂停 · 资产冻结状态保留', amount: '0', asset: 'NONE', occurredAt: '2026-10-10T10:00:00.000Z' }],
  },
];

export class OfflineAgentDownlineAdapter implements AgentDownlineReadRepositoryPort {
  constructor(private readonly databaseName = ADMIN_DEVELOPMENT_DATABASE) {}

  async list(query: AgentDownlineQueryDto): Promise<AgentDownlineListResponseDto> {
    const keyword = query.keyword?.toLocaleLowerCase();
    const filtered = DEMO_DOWNLINES.map((item) => item.downline).filter((item) => {
      const matchesKeyword = !keyword || item.displayName.toLocaleLowerCase().includes(keyword) || item.userId.includes(keyword);
      return matchesKeyword && (query.status === undefined || query.status === item.userStatus);
    });
    const pageSize = query.pageSize ?? 20;
    const start = query.cursor ? Number(query.cursor) - 1 : 0;
    const items = filtered.slice(start, start + pageSize);
    const next = start + items.length;
    return { items, nextCursor: next < filtered.length ? String(next + 1) : null, total: filtered.length };
  }

  async readDetail(userId: string, request: AgentDownlineDetailReadRequestDto): Promise<AgentDownlineDetailDto | null> {
    const database = await openAdminDevelopmentDatabase(this.databaseName);
    const transaction = database.transaction('agent_audit_events', 'readwrite');
    const auditIndex = transaction.store.index('by-request-key');
    const previous = await auditIndex.get(request.requestKey);
    if (previous) {
      await transaction.done;
      if (previous.resourceKey !== userId || previous.purpose !== formatPurpose(request)) throw new Error('REQUEST_KEY_REUSED');
      return DEMO_DOWNLINES.find((record) => record.downline.userId === userId) ?? null;
    }

    const item = DEMO_DOWNLINES.find((record) => record.downline.userId === userId);
    const audit: AgentAuditEventDto = {
      auditId: createAuditId(),
      agentDomainId: '92001',
      agentUserId: '92000',
      actionCode: 'DOWNLINE_DETAIL_READ',
      resourceType: 'USER',
      resourceKey: userId,
      purpose: formatPurpose(request),
      requestKey: request.requestKey,
      resultType: item ? AgentAuditResultType.SUCCESS : AgentAuditResultType.DENIED,
      snapshot: item ? { activityCount: item.recentActivities.length, referralParentCount: item.referralChain.length } : { denied: 'NOT_FOUND' },
      createdAt: new Date().toISOString(),
    };
    await transaction.store.add(audit);
    await transaction.done;
    return item ? structuredClone(item) : null;
  }

  async listAuditEvents(query: AgentAuditQueryDto): Promise<AgentAuditListResponseDto> {
    const database = await openAdminDevelopmentDatabase(this.databaseName);
    const keyword = query.keyword?.toLocaleLowerCase();
    const filtered = (await database.getAll('agent_audit_events'))
      .filter((event) => event.agentUserId === '92000')
      .filter((event) => query.resultType === undefined || event.resultType === query.resultType)
      .filter((event) => !keyword || `${event.actionCode} ${event.resourceType} ${event.resourceKey} ${event.purpose}`.toLocaleLowerCase().includes(keyword))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.auditId.localeCompare(left.auditId));
    const pageSize = query.pageSize ?? 20;
    const start = query.cursor ? Number(query.cursor) - 1 : 0;
    const items = filtered.slice(start, start + pageSize);
    const next = start + items.length;
    return { items, nextCursor: next < filtered.length ? String(next + 1) : null, total: filtered.length };
  }
}

function formatPurpose(request: AgentDownlineDetailReadRequestDto): string {
  const labels: Record<AgentDownlineDetailReadRequestDto['purposeCode'], string> = {
    ROUTINE_OPERATIONS_REVIEW: '日常业务核查',
    ASSET_EXCEPTION_FOLLOWUP: '资产异常跟进',
    PAYMENT_FOLLOWUP: '充值或提现跟进',
    GAME_DISPUTE_FOLLOWUP: '牌局争议跟进',
    SUPPORT_CASE: '客服工单处理',
  };
  return request.caseReference ? `${labels[request.purposeCode]}：${request.caseReference}` : labels[request.purposeCode];
}

function createAuditId(): string {
  const suffix = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return String(BigInt(Date.now()) * 1_000_000n + BigInt(suffix));
}
