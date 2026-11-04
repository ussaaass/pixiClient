/**
 * admin 模块用例：代理域审批（POST /admin-api/v1/agent-domains/:id/approve，
 * PENDING_REVIEW=1 → ACTIVE=2，幂等重放；同事务审计经 admin_audit_event
 * append-only）。
 *
 * 领域所有者：admin 模块（agent_domain 行锁读 + UPDATE status /
 * approved_at；admin_audit_event 同事务 append-only 写；SDD §6.3
 * "所有分录 / outbox 同事务"约定；A.12 第 5 条不可变审计）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 agent_domain →
 * admin_audit_event，幂等先抢唯一约束）、§9 第 9 步（Admin 全量
 * 切换收口：agent-domain-review 工作区 → agent_domain 审批 /
 * 暂停 / 撤销端点 + 审计）；数据库设计 SDD §5.2.1（agent_domain
 * 5 态 DDL 权威 + U(user_id)；admin_audit_event U(request_key)）。
 *
 * 用例语义：
 * - 行锁读 agent_domain（缺行 → AD_AGENT_DOMAIN_NOT_FOUND 404 语义）；
 * - 幂等重放：已 ACTIVE=2 → 静默返回既有值 `inserted: false`（200，
 *   验收红线"审批幂等"）；
 * - 状态机前置校验：PENDING_REVIEW=1 → ACTIVE=2 经
 *   `canAgentDomainTransition` 纯函数（models/admin.ts 5 态 DDL 权威）；
 *   非 PENDING → 抛 AD_AGENT_DOMAIN_NOT_PENDING（409 语义）；
 * - 同事务写 admin_audit_event（request_key = `agent-domain:{id}:approve`
 *   幂等兜底；snapshot 经 `validateAuditSnapshot` 脱敏校验，
 *   不含正文外敏感信息；ipHash 经路由层带密钥摘要计算，
 *   登记 KMS 未闭环）；
 * - 影响行数 0 → 读回既有值（并发推进兜底，幂等重放）；
 *   读回非 ACTIVE → STORAGE_UNAVAILABLE（可重试）。
 *
 * 错误码映射（AD → 触发条件）：
 * - `AD_AGENT_DOMAIN_NOT_FOUND`：agent_domain 行缺失（404 语义）。
 * - `AD_AGENT_DOMAIN_NOT_PENDING`：非 PENDING_REVIEW=1，不可审批
 *   （409 语义，状态机前置校验失败）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 状态机影响行数 0
 *   （可重试，503 语义）。
 *
 * 锁顺序（SDD §4）：agent_domain（行锁读 + UPDATE status / approved_at）
 * → admin_audit_event（append-only create，同事务），
 * 两表操作无跨表锁竞争（审计经 U(request_key) 幂等兜底，无锁）。
 */

import type { AgentDomainRepo, AdminAuditEventRepo, Tx } from '../ports/admin-repository.js';
import { AdminDomainError, AD } from '../domain/errors.js';
import {
  AdminAgentDomainStatus5,
  canAgentDomainTransition,
} from '../domain/audit-rules.js';

/** 审批结果（wire DTO；ID / 时间戳十进制字符串 wire；status 数值常量 wire）。 */
export interface AgentDomainApprovedDto {
  domainId: string;
  status: number;
  approvedAt: string | null;
  inserted: boolean;
}

export class AgentDomainApproveUseCase {
  constructor(
    private readonly agentDomainRepo: AgentDomainRepo,
    private readonly auditRepo: AdminAuditEventRepo,
  ) {}

  /**
   * POST /admin-api/v1/agent-domains/:id/approve：代理域审批
   * （PENDING_REVIEW=1 → ACTIVE=2 + approved_at 回填 + 同事务审计）。
   * 调用方（路由层）负责开事务 + Admin audience 鉴权 + 前置 role_type
   * 校验，传入 `tx`；`adminUserId` / `requestKey` / `snapshot` 经
   * 路由层解析后传入。
   */
  async run(input: {
    domainId: string;
    adminUserId: string;
    requestKey: string;
    snapshot: Record<string, unknown>;
    tx: Tx;
  }): Promise<AgentDomainApprovedDto> {
    const now = new Date();

    // 1. 行锁读 agent_domain（缺行 → 领域错误 404 语义）
    const domain = await this.agentDomainRepo.lockAgentDomain(input.domainId, input.tx);
    if (domain === null) {
      throw new AdminDomainError(AD.AD_AGENT_DOMAIN_NOT_FOUND, `代理域不存在：${input.domainId}`);
    }

    // 2. 幂等重放：已 ACTIVE=2 → 静默返回既有值（不产生第二笔）
    if (domain.status === AdminAgentDomainStatus5.ACTIVE) {
      return {
        domainId: domain.id,
        status: domain.status,
        approvedAt:
          domain.approvedAt === null
            ? null
            : typeof domain.approvedAt === 'string'
              ? domain.approvedAt
              : domain.approvedAt.toISOString(),
        inserted: false,
      };
    }

    // 3. 状态机前置校验（PENDING_REVIEW=1 → ACTIVE=2）
    if (!canAgentDomainTransition(domain.status, AdminAgentDomainStatus5.ACTIVE)) {
      throw new AdminDomainError(AD.AD_AGENT_DOMAIN_NOT_PENDING, `代理域状态非 PENDING_REVIEW，不可审批（status=${domain.status}）。`, {
        retryable: false,
      });
    }

    // 4. 同事务推进 agent_domain 状态 + 审计 append-only
    const result = await this.agentDomainRepo.approveAgentDomain({
      domainId: domain.id,
      approvedAt: now,
      tx: input.tx,
    });
    if (result === null) {
      // 影响行数 0 = 并发推进 → 读回既有值（幂等兜底）
      const re = await this.agentDomainRepo.lockAgentDomain(input.domainId, input.tx);
      if (re !== null && re.status === AdminAgentDomainStatus5.ACTIVE) {
        return {
          domainId: re.id,
          status: re.status,
          approvedAt:
            re.approvedAt === null
              ? null
              : typeof re.approvedAt === 'string'
                ? re.approvedAt
                : re.approvedAt.toISOString(),
          inserted: false,
        };
      }
      throw new AdminDomainError(AD.STORAGE_UNAVAILABLE, '代理域审批状态机转换失败（影响行数 0），请重试。', {
        retryable: true,
      });
    }

    // 5. 同事务写审计（append-only；U(request_key) 幂等兜底）
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
      actionCode: 'AGENT_DOMAIN_APPROVE',
      resultType: 1,
      reason: 'Admin 审批代理域 PENDING_REVIEW → ACTIVE。',
      snapshot: input.snapshot,
      ipHashHex: '0'.repeat(64), // 登记决策点：KMS 带密钥摘要未闭环，首版占位 32 字节零
      tx: input.tx,
    });

    return {
      domainId: result.id,
      status: result.status,
      approvedAt:
        result.approvedAt === null
          ? null
          : typeof result.approvedAt === 'string'
            ? result.approvedAt
            : result.approvedAt.toISOString(),
      inserted: true,
    };
  }
}
