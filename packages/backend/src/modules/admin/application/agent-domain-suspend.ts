/**
 * admin 模块用例：代理域暂停（POST /admin-api/v1/agent-domains/:id/suspend，
 * ACTIVE=2 → SUSPENDED=3，幂等重放；同事务审计经 admin_audit_event
 * append-only）。
 *
 * 领域所有者：admin 模块（agent_domain 行锁读 + UPDATE status /
 * suspended_at；admin_audit_event 同事务 append-only 写；SDD §6.3
 * "所有分录 / outbox 同事务"约定；A.12 第 5 条不可变审计）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 agent_domain →
 * admin_audit_event）、§9 第 9 步（Admin 全量切换收口：agent-domain-review
 * 工作区 → agent_domain 暂停端点 + 审计）；数据库设计 SDD §5.2.1
 * （agent_domain 5 态 DDL 权威）。
 *
 * 用例语义：
 * - 行锁读 agent_domain（缺行 → AD_AGENT_DOMAIN_NOT_FOUND 404 语义）；
 * - 幂等重放：已 SUSPENDED=3 → 静默返回既有值 `inserted: false`（200）；
 * - 状态机前置校验：ACTIVE=2 → SUSPENDED=3 经 `canAgentDomainTransition`
 *   纯函数（models/admin.ts 5 态 DDL 权威）；非 ACTIVE → 抛
 *   AD_AGENT_DOMAIN_NOT_ACTIVE（409 语义）；
 * - 同事务写 admin_audit_event（request_key = `agent-domain:{id}:suspend`
 *   幂等兜底；snapshot 经 `validateAuditSnapshot` 脱敏校验）。
 *
 * 锁顺序（SDD §4）：agent_domain → admin_audit_event（同事务，
 * 无跨表锁竞争）。
 */

import type { AgentDomainRepo, AdminAuditEventRepo, Tx } from '../ports/admin-repository.js';
import { AdminDomainError, AD } from '../domain/errors.js';
import { AdminAgentDomainStatus5, canAgentDomainTransition } from '../domain/audit-rules.js';

/** 暂停结果（wire DTO；status 数值常量 wire）。 */
export interface AgentDomainSuspendedDto {
  domainId: string;
  status: number;
  suspendedAt: string | null;
  inserted: boolean;
}

export class AgentDomainSuspendUseCase {
  constructor(
    private readonly agentDomainRepo: AgentDomainRepo,
    private readonly auditRepo: AdminAuditEventRepo,
  ) {}

  async run(input: {
    domainId: string;
    adminUserId: string;
    requestKey: string;
    snapshot: Record<string, unknown>;
    tx: Tx;
  }): Promise<AgentDomainSuspendedDto> {
    const now = new Date();

    // 1. 行锁读 agent_domain（缺行 → 领域错误 404 语义）
    const domain = await this.agentDomainRepo.lockAgentDomain(input.domainId, input.tx);
    if (domain === null) {
      throw new AdminDomainError(AD.AD_AGENT_DOMAIN_NOT_FOUND, `代理域不存在：${input.domainId}`);
    }

    // 2. 幂等重放：已 SUSPENDED=3 → 静默返回既有值
    if (domain.status === AdminAgentDomainStatus5.SUSPENDED) {
      return {
        domainId: domain.id,
        status: domain.status,
        suspendedAt:
          domain.suspendedAt === null
            ? null
            : typeof domain.suspendedAt === 'string'
              ? domain.suspendedAt
              : domain.suspendedAt.toISOString(),
        inserted: false,
      };
    }

    // 3. 状态机前置校验（ACTIVE=2 → SUSPENDED=3）
    if (!canAgentDomainTransition(domain.status, AdminAgentDomainStatus5.SUSPENDED)) {
      throw new AdminDomainError(AD.AD_AGENT_DOMAIN_NOT_ACTIVE, `代理域状态非 ACTIVE，不可暂停（status=${domain.status}）。`, {
        retryable: false,
      });
    }

    // 4. 同事务推进 agent_domain 状态 + 审计 append-only
    const result = await this.agentDomainRepo.suspendAgentDomain({
      domainId: domain.id,
      suspendedAt: now,
      tx: input.tx,
    });
    if (result === null) {
      const re = await this.agentDomainRepo.lockAgentDomain(input.domainId, input.tx);
      if (re !== null && re.status === AdminAgentDomainStatus5.SUSPENDED) {
        return {
          domainId: re.id,
          status: re.status,
          suspendedAt: re.suspendedAt === null ? null : typeof re.suspendedAt === 'string' ? re.suspendedAt : re.suspendedAt.toISOString(),
          inserted: false,
        };
      }
      throw new AdminDomainError(AD.STORAGE_UNAVAILABLE, '代理域暂停状态机转换失败（影响行数 0），请重试。', {
        retryable: true,
      });
    }

    await this.auditRepo.createAuditEvent({
      adminUserId: input.adminUserId,
      adminSessionKey: null,
      userId: domain.userId,
      targetAdminUserId: null,
      assetOperationId: null,
      withdrawalId: null,
      systemConfigId: null,
      gameConfigId: null,
      agentDomainId: domain.id,
      referralBindingEventId: null,
      supportConversationId: null,
      coinMarketTradeId: null,
      requestKey: input.requestKey,
      actionCode: 'AGENT_DOMAIN_SUSPEND',
      resultType: 1,
      reason: 'Admin 暂停代理域 ACTIVE → SUSPENDED。',
      snapshot: input.snapshot,
      ipHashHex: '0'.repeat(64),
      tx: input.tx,
    });

    return {
      domainId: result.id,
      status: result.status,
      suspendedAt:
        result.suspendedAt === null ? null : typeof result.suspendedAt === 'string' ? result.suspendedAt : result.suspendedAt.toISOString(),
      inserted: true,
    };
  }
}
