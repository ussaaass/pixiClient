/**
 * admin 模块用例：代理域撤销（POST /admin-api/v1/agent-domains/:id/revoke，
 * ACTIVE=2 / SUSPENDED=3 → REVOKED=4，实体保留供审计；同事务审计经
 * admin_audit_event append-only）。
 *
 * 领域所有者：admin 模块（agent_domain 行锁读 + UPDATE status /
 * revoked_at；admin_audit_event 同事务 append-only 写；SDD §6.3
 * "所有分录 / outbox 同事务"约定；A.12 第 5 条不可变审计）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 agent_domain →
 * admin_audit_event）、§9 第 9 步（Admin 全量切换收口：agent-domain-review
 * 工作区 → agent_domain 撤销端点 + 审计）；数据库设计 SDD §5.2.1
 * （agent_domain 5 态 DDL 权威；撤销后实体保留供审计，revoked_at
 * 记录时刻，不删除）。
 *
 * 用例语义：
 * - 行锁读 agent_domain（缺行 → AD_AGENT_DOMAIN_NOT_FOUND 404 语义）；
 * - 幂等重放：已 REVOKED=4 → 静默返回既有值 `inserted: false`（200）；
 * - 状态机前置校验：ACTIVE=2 / SUSPENDED=3 → REVOKED=4 经
 *   `canAgentDomainTransition` 纯函数；非 ACTIVE / SUSPENDED →
 *   抛 AD_AGENT_DOMAIN_NOT_ACTIVE（409 语义）；
 * - 同事务写 admin_audit_event（request_key = `agent-domain:{id}:revoke`
 *   幂等兜底；snapshot 经 `validateAuditSnapshot` 脱敏校验）。
 *
 * 锁顺序（SDD §4）：agent_domain → admin_audit_event（同事务）。
 */

import type { AgentDomainRepo, AdminAuditEventRepo, Tx } from '../ports/admin-repository.js';
import { AdminDomainError, AD } from '../domain/errors.js';
import { AdminAgentDomainStatus5, canAgentDomainTransition } from '../domain/audit-rules.js';

/** 撤销结果（wire DTO；status 数值常量 wire）。 */
export interface AgentDomainRevokedDto {
  domainId: string;
  status: number;
  revokedAt: string | null;
  inserted: boolean;
}

export class AgentDomainRevokeUseCase {
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
  }): Promise<AgentDomainRevokedDto> {
    const now = new Date();

    // 1. 行锁读 agent_domain（缺行 → 领域错误 404 语义）
    const domain = await this.agentDomainRepo.lockAgentDomain(input.domainId, input.tx);
    if (domain === null) {
      throw new AdminDomainError(AD.AD_AGENT_DOMAIN_NOT_FOUND, `代理域不存在：${input.domainId}`);
    }

    // 2. 幂等重放：已 REVOKED=4 → 静默返回既有值（终态）
    if (domain.status === AdminAgentDomainStatus5.REVOKED) {
      return {
        domainId: domain.id,
        status: domain.status,
        revokedAt:
          domain.revokedAt === null ? null : typeof domain.revokedAt === 'string' ? domain.revokedAt : domain.revokedAt.toISOString(),
        inserted: false,
      };
    }

    // 3. 状态机前置校验（ACTIVE=2 / SUSPENDED=3 → REVOKED=4）
    if (!canAgentDomainTransition(domain.status, AdminAgentDomainStatus5.REVOKED)) {
      throw new AdminDomainError(AD.AD_AGENT_DOMAIN_NOT_ACTIVE, `代理域状态不可撤销（status=${domain.status}）。`, {
        retryable: false,
      });
    }

    // 4. 同事务推进 agent_domain 状态 + 审计 append-only
    const result = await this.agentDomainRepo.revokeAgentDomain({
      domainId: domain.id,
      revokedAt: now,
      tx: input.tx,
    });
    if (result === null) {
      const re = await this.agentDomainRepo.lockAgentDomain(input.domainId, input.tx);
      if (re !== null && re.status === AdminAgentDomainStatus5.REVOKED) {
        return {
          domainId: re.id,
          status: re.status,
          revokedAt: re.revokedAt === null ? null : typeof re.revokedAt === 'string' ? re.revokedAt : re.revokedAt.toISOString(),
          inserted: false,
        };
      }
      throw new AdminDomainError(AD.STORAGE_UNAVAILABLE, '代理域撤销状态机转换失败（影响行数 0），请重试。', {
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
      actionCode: 'AGENT_DOMAIN_REVOKE',
      resultType: 1,
      reason: 'Admin 撤销代理域，实体保留供审计。',
      snapshot: input.snapshot,
      ipHashHex: '0'.repeat(64),
      tx: input.tx,
    });

    return {
      domainId: result.id,
      status: result.status,
      revokedAt:
        result.revokedAt === null ? null : typeof result.revokedAt === 'string' ? result.revokedAt : result.revokedAt.toISOString(),
      inserted: true,
    };
  }
}
