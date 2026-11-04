/**
 * admin 模块仓储端口（agent_domain / admin_permission / admin_audit_event
 * append-only / coin_market_trade 裁决 / withdrawal 审批 / ai_asset_job
 * 审核推进 / user admin 视角读）。
 *
 * 领域所有者：admin 模块（adapters/sequelize-admin.ts 各 Repo 类实现
 * 各端口；models/admin.ts 4 model + 跨模块 model 经本层落库，
 * admin_audit_event 不可变表经 model hooks 拦截 update/destroy，
 * A.12 第 5 条）。
 * 对应 SDD 章节：后端实施 SDD §4（构造注入 ports，用例 / 适配器经
 * 端口落库；锁顺序 agent_domain / coin_market_trade / withdrawal /
 * ai_asset_job → admin_audit_event，幂等先抢唯一约束）、§9 第 9 步
 * （Admin 全量切换收口：审计 append-only + request_key 幂等 + 双人
 * 复核服务端强制 + 状态机前置校验）；数据库设计 SDD §5.2.1 / §5.8
 * （admin_audit_event U(request_key) + append-only；agent_domain
 * 5 态 DDL 权威）。
 *
 * 约定（与 referral / coin-market / ai-assets 模块 ports 同款纪律）：
 * - 方法名经实体前缀区分（lockAgentDomain / approveAgentDomain /
 *   suspendAgentDomain / revokeAgentDomain / createAuditEvent /
 *   lockTrade / adjudicateTrade / lockWithdrawal / approveWithdrawal /
 *   rejectWithdrawal / lockJob / reviewJob / listUsers / findUserByPk，
 *   各表 CRUD 语义独立，无重名冲突）；
 * - `Tx` 复用 wallet 模块 `Tx`（Sequelize 事务句柄鸭子类型），用例内
 *   所有写操作共享同一事务（随事务提交 / 回滚，SDD §6.3 "所有分录 /
 *   outbox 同事务"）；
 * - 不可变表：`admin_audit_event` 只 create（model hooks 拦截
 *   update/destroy），U(request_key) 命中 → 返回既有行（`inserted:
 *   false` 幂等重放，验收红线"审计幂等"）；
 * - 跨模块 model 读（coin_market_trade / withdrawal / ai_asset_job /
 *   user）经本端口封装，admin 模块不直接 import 各模块 ports，
 *   保持模块边界（SDD §3.2 实体归属矩阵：admin owns
 *   agent_domain + admin_audit_event，读其他表经端口）。
 */

import type { AgentDomainModel, AdminAuditEventModel, AdminPermissionModel } from '../../../infrastructure/database/models/admin.js';
import type { CoinMarketTradeModel } from '../../../infrastructure/database/models/coin-market.js';
import type { WithdrawalModel } from '../../../infrastructure/database/models/payments.js';
import type { AiAssetJobModel } from '../../../infrastructure/database/models/assets.js';
import type { UserModel } from '../../../infrastructure/database/models/identity.js';
import type { Tx } from '../../wallet/ports/wallet-repository.js';

export type { Tx };

// ---------------------------------------------------------------------------
// AgentDomainRepo（agent_domain 写：审批 / 暂停 / 撤销；U(user_id) 幂等）
// ---------------------------------------------------------------------------

export interface AgentDomainRepo {
  /**
   * 按 id 行锁读 agent_domain 行（审批 / 暂停 / 撤销前置；status +
   * 状态机经用例层 `canAgentDomainTransition` 校验）。
   */
  lockAgentDomain(domainId: string, tx: Tx): Promise<AgentDomainModel | null>;

  /**
   * 审批 agent_domain（PENDING_REVIEW=1 → ACTIVE=2，approved_at 回填；
   * 幂等重放：已 ACTIVE → 静默返回既有值；非 PENDING → 用例层前置
   * 校验抛 AD_AGENT_DOMAIN_NOT_PENDING）。
   * @returns 更新后的行（影响行数 0 → null，由用例层映射 STORAGE_UNAVAILABLE）。
   */
  approveAgentDomain(input: { domainId: string; approvedAt: Date; tx: Tx }): Promise<AgentDomainModel | null>;

  /**
   * 暂停 agent_domain（ACTIVE=2 → SUSPENDED=3，suspended_at 回填；
   * 非 ACTIVE → 用例层前置校验抛 AD_AGENT_DOMAIN_NOT_ACTIVE）。
   */
  suspendAgentDomain(input: { domainId: string; suspendedAt: Date; tx: Tx }): Promise<AgentDomainModel | null>;

  /**
   * 撤销 agent_domain（ACTIVE=2 / SUSPENDED=3 → REVOKED=4，revoked_at
   * 回填；实体保留供审计，不删除；终态幂等重放：已 REVOKED → 静默）。
   */
  revokeAgentDomain(input: { domainId: string; revokedAt: Date; tx: Tx }): Promise<AgentDomainModel | null>;
}

// ---------------------------------------------------------------------------
// AdminAuditEventRepo（admin_audit_event append-only；U(request_key) 幂等）
// ---------------------------------------------------------------------------

export interface AdminAuditEventRepo {
  /**
   * 写审计事件（append-only，status 固定 RECORDED=1；U(request_key)
   * 幂等兜底：命中 → 返回既有行 `inserted: false`，不产生第二行；
   * snapshot 经 `validateAuditSnapshot` 脱敏校验后落库；ipHash 经
   * 路由层 `crypto.createHash('sha256').update(ip + secret).digest()`
   * 计算（带密钥摘要，登记 KMS 未闭环）。
   */
  createAuditEvent(input: {
    adminUserId: string;
    adminSessionKey: string | null;
    userId: string | null;
    targetAdminUserId: string | null;
    assetOperationId: string | null;
    withdrawalId: string | null;
    systemConfigId: string | null;
    gameConfigId: string | null;
    agentDomainId: string | null;
    referralBindingEventId: string | null;
    supportConversationId: string | null;
    coinMarketTradeId: string | null;
    requestKey: string;
    actionCode: string;
    resultType: number;
    reason: string;
    snapshot: Record<string, unknown>;
    ipHashHex: string;
    tx: Tx;
  }): Promise<{ inserted: boolean; event: AdminAuditEventModel }>;

  /** 按 request_key 读既有审计事件（幂等重放 / 审计查询用；只读无锁）。 */
  findAuditEventByRequestKey(requestKey: string, tx: Tx): Promise<AdminAuditEventModel | null>;
}

// ---------------------------------------------------------------------------
// AdminPermissionRepo（admin_permission 只读目录）
// ---------------------------------------------------------------------------

export interface AdminPermissionRepo {
  /** 按 permission_code 读权限行（只读无锁；缺失返回 null）。 */
  findPermissionByCode(permissionCode: string, tx: Tx): Promise<AdminPermissionModel | null>;
}

// ---------------------------------------------------------------------------
// TradeAdjudicationRepo（coin_market_trade 裁决；跨模块读经本端口）
// ---------------------------------------------------------------------------

export interface TradeAdjudicationRepo {
  /**
   * 按 id 行锁读 trade 行（裁决前置；status ∈ DISPUTE 态 3/4/5/6 经
   * 用例层 `canTradeAdjudicate` 校验；support_conversation 关联经
   * trade.supportConversationId 读回，不写会话表）。
   */
  lockTrade(tradeId: string, tx: Tx): Promise<CoinMarketTradeModel | null>;

  /**
   * 裁决 trade（DISPUTE 态 → RELEASED=7 / RESOLVED_RETURN=10；同事务
   * adjudicated_by_user_id + resolution_code + resolution_note +
   * adjudicated_at 落库；幂等重放：已 RELEASED / RESOLVED_RETURN →
   * 静默返回既有值；非 DISPUTE → 用例层前置校验抛 AD_TRADE_NOT_DISPUTE）。
   * 注：asset_operation 放币 / 返还分录经 wallet ledger 扩展点登记
   * （COIN_MARKET_TRADE=13 / COIN_MARKET_RELEASE=14，§6.3 管线未建，
   * 登记决策点），本用例只推进状态 + 裁决字段。
   * @returns 更新后的行（影响行数 0 → null，由用例层映射 STORAGE_UNAVAILABLE）。
   */
  adjudicateTrade(input: {
    tradeId: string;
    targetStatus: number;
    resolutionCode: number;
    resolutionNote: string;
    adjudicatedByUserId: string;
    adjudicatedAt: Date;
    tx: Tx;
  }): Promise<CoinMarketTradeModel | null>;
}

// ---------------------------------------------------------------------------
// WithdrawalReviewRepo（withdrawal 审批 / 驳回；双人复核经用例层强制）
// ---------------------------------------------------------------------------

export interface WithdrawalReviewRepo {
  /**
   * 按 id 行锁读 withdrawal 行（审批 / 驳回前置；status ∈
   * {REQUESTED=1, REVIEWING=2} 经用例层 `canWithdrawalApprove` 校验）。
   */
  lockWithdrawal(withdrawalId: string, tx: Tx): Promise<WithdrawalModel | null>;

  /**
   * 审批 withdrawal（REQUESTED=1 / REVIEWING=2 → APPROVED=3，
   * approval_key = `withdrawal:{id}:approve` + approved_at 回填；
   * 幂等重放：已 APPROVED → 静默返回既有值；双人复核
   * operated_by ≠ approved_by 经用例层前置校验（同 admin → 409
   * AD_PERMISSION_DENIED 语义）；注：出款经 payout worker 闭环，
   * 登记决策点，本用例只推进状态 + 审计同事务）。
   * @returns 更新后的行（影响行数 0 → null，由用例层映射 STORAGE_UNAVAILABLE）。
   */
  approveWithdrawal(input: { withdrawalId: string; approvedAt: Date; tx: Tx }): Promise<WithdrawalModel | null>;

  /**
   * 驳回 withdrawal（REQUESTED=1 / REVIEWING=2 → REJECTED=6，
   * failure_reason 回填；幂等重放：已 REJECTED → 静默返回既有值）。
   * @returns 更新后的行（影响行数 0 → null，由用例层映射 STORAGE_UNAVAILABLE）。
   */
  rejectWithdrawal(input: { withdrawalId: string; rejectedAt: Date; failureReason: string; tx: Tx }): Promise<WithdrawalModel | null>;
}

// ---------------------------------------------------------------------------
// AiJobReviewRepo（ai_asset_job 审核推进；跨模块读经本端口）
// ---------------------------------------------------------------------------

export interface AiJobReviewRepo {
  /**
   * 按 id 行锁读 job 行（审核前置；status = REVIEW_REQUIRED=6 经
   * 用例层校验；REVIEW 推进经 Admin 审核路径，§9 第 8 步登记扩展点
   * 在此闭环）。
   */
  lockJob(jobId: string, tx: Tx): Promise<AiAssetJobModel | null>;

  /**
   * 审核推进 job（REVIEW_REQUIRED=6 → SUCCEEDED=3（通过）/
   * FAILED=4（驳回），completed_at 回填；幂等重放：已 SUCCEEDED /
   * FAILED → 静默返回既有值；非 REVIEW_REQUIRED → 用例层前置校验
   * 抛 AD_JOB_NOT_REVIEW；costMicroUsd 回填经生成台账对接，
   * 登记 KMS 未闭环）。
   * @returns 更新后的行（影响行数 0 → null，由用例层映射 STORAGE_UNAVAILABLE）。
   */
  reviewJob(input: { jobId: string; targetStatus: number; completedAt: Date; tx: Tx }): Promise<AiAssetJobModel | null>;
}

// ---------------------------------------------------------------------------
// AdminUserRepo（user admin 视角读；经 identity UserModel，不写）
// ---------------------------------------------------------------------------

export interface AdminUserRepo {
  /**
   * 列出用户（admin 视角游标分页 50/页；筛选 userId / username /
   * roleType / status；orderBy created_at + id 稳定游标；
   * 只读 user 表，不写）。
   * @param input.filters 可选筛选（缺省 = 全量游标翻页）。
   */
  listUsers(input: {
    cursor: string | null;
    limit: number;
    userId?: string | undefined;
    username?: string | undefined;
    roleType?: number | undefined;
    status?: number | undefined;
    tx: Tx;
  }): Promise<{ items: UserModel[]; nextCursor: string | null }>;

  /** 按 id 读 user 行（详情 section 读前置；只读无锁；缺失返回 null）。 */
  findUserByPk(userId: string, tx: Tx): Promise<UserModel | null>;

  /** 按 username 读 user 行（Admin 登录前置；只读无锁；缺失返回 null）。 */
  findUserByUsername(username: string, tx: Tx): Promise<UserModel | null>;
}
