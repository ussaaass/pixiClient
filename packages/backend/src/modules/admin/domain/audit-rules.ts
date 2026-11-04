/**
 * admin 模块纯领域规则（agent_domain / withdrawal / trade 状态机转换表 +
 * 审计 snapshot 脱敏校验，无 IO）。
 *
 * 领域所有者：admin 模块（domain/audit-rules.ts；用例层 / 适配器层
 * 前置校验经本文件纯函数，不直接读表）。
 * 对应 SDD 章节：后端实施 SDD §9 第 9 步（Admin 全量切换收口：
 * agent_domain 状态机审批/暂停/撤销 + coin_market_trade DISPUTE 裁决 +
 * withdrawal 双人复核 + ai_asset_job 审核推进 + admin_audit_event
 * append-only 审计）；数据库设计 SDD §5.2.1 / §5.8（agent_domain
 * 5 态 + admin_audit_event 不可变 DDL 权威）。
 *
 * 约定：
 * - agent_domain 5 态转换表（DDL 权威，models/admin.ts AgentDomainStatus）；
 * - withdrawal 9 态审批 / 驳回转换表（DDL 权威，models/payments.ts
 *   WithdrawalStatus；双人复核经用例层 operated_by / approved_by 校验）；
 * - trade DISPUTE 裁决转换表（DDL 权威，models/coin-market.ts
 *   CoinMarketTradeStatus；DISPUTE 态 3/4/5/6 → RELEASED=7 /
 *   RESOLVED_RETURN=10，Admin 裁决路径）；
 * - job 审核推进转换表（DDL 权威，models/assets.ts AiJobStatus；
 *   REVIEW_REQUIRED=6 → SUCCEEDED=3 / FAILED=4）；
 * - 审计 snapshot 脱敏校验（request_key 幂等 + 前后值快照 + 不含正文
 *   外敏感信息，A.8 第 4 条红线：审计 snapshot 不得含消息正文 /
 *   认证秘密 / 支付凭证明文）。
 */

import { AdminDomainError, AD } from './errors.js';

/** AgentDomainStatus：agent_domain 5 态常量（DDL 权威，models/admin.ts）。 */
export const AdminAgentDomainStatus5 = {
  PENDING_REVIEW: 1,
  ACTIVE: 2,
  SUSPENDED: 3,
  REVOKED: 4,
  WITHDRAWN: 5,
} as const;

export type AdminAgentDomainStatus5Value = (typeof AdminAgentDomainStatus5)[keyof typeof AdminAgentDomainStatus5];

/** WithdrawalStatus：withdrawal 9 态常量（DDL 权威，models/payments.ts）。 */
export const AdminWithdrawalStatus9 = {
  REQUESTED: 1,
  REVIEWING: 2,
  APPROVED: 3,
  PAYING: 4,
  SUCCEEDED: 5,
  REJECTED: 6,
  CANCELLED: 7,
  PAYMENT_UNKNOWN: 8,
  FAILED: 9,
} as const;

export type AdminWithdrawalStatus9Value = (typeof AdminWithdrawalStatus9)[keyof typeof AdminWithdrawalStatus9];

/**
 * agent_domain 状态机转换表（5 态 DDL 权威）：
 * - PENDING_REVIEW=1 → [ACTIVE=2]（Admin 审批；幂等重放：已 ACTIVE → 静默）
 * - ACTIVE=2 → [SUSPENDED=3]（Admin 暂停）
 * - SUSPENDED=3 → [ACTIVE=2, REVOKED=4]（恢复 / 撤销）
 * - ACTIVE=2 / SUSPENDED=3 → [REVOKED=4]（Admin 撤销）
 * - REVOKED=4 / WITHDRAWN=5 → []（终态，实体保留供审计）
 */
export const AGENT_DOMAIN_TRANSITIONS: Readonly<Record<number, readonly number[]>> = Object.freeze({
  [AdminAgentDomainStatus5.PENDING_REVIEW]: [AdminAgentDomainStatus5.ACTIVE],
  [AdminAgentDomainStatus5.ACTIVE]: [AdminAgentDomainStatus5.SUSPENDED, AdminAgentDomainStatus5.REVOKED],
  [AdminAgentDomainStatus5.SUSPENDED]: [AdminAgentDomainStatus5.ACTIVE, AdminAgentDomainStatus5.REVOKED],
  [AdminAgentDomainStatus5.REVOKED]: [],
  [AdminAgentDomainStatus5.WITHDRAWN]: [],
});

/**
 * withdrawal 审批 / 驳回转换表（9 态 DDL 权威；首版 Admin 只覆盖
 * REQUESTED=1 / REVIEWING=2 → APPROVED=3 / REJECTED=6 两条路径；
 * PAYING / SUCCEEDED / FAILED 推进经 payout worker 闭环，登记决策点）。
 */
export const WITHDRAWAL_APPROVE_FROM: readonly number[] = Object.freeze([
  AdminWithdrawalStatus9.REQUESTED,
  AdminWithdrawalStatus9.REVIEWING,
]);

/**
 * trade DISPUTE 裁决转换表（11 态 DDL 权威；Admin 裁决路径
 * DISPUTED=3 / BUYER_EVIDENCE_PENDING=4 / SELLER_EVIDENCE_PENDING=5 /
 * PLATFORM_REVIEW=6 → RELEASED=7（放币）/ RESOLVED_RETURN=10（返还），
 * 同事务 adjudicated_by_user_id + resolution_code + adjudicated_at 落库）。
 */
export const TRADE_ADJUDICATE_FROM: readonly number[] = Object.freeze([3, 4, 5, 6]);
export const TRADE_ADJUDICATE_RELEASED = 7;
export const TRADE_ADJUDICATE_RETURN = 10;

/** resolution_code 常量（DDL 权威，models/coin-market.ts 注释）：
 * RELEASE_TO_BUYER=1 / RETURN_TO_SELLER=2。 */
export const ResolutionCode = { RELEASE_TO_BUYER: 1, RETURN_TO_SELLER: 2 } as const;
export type ResolutionCodeValue = (typeof ResolutionCode)[keyof typeof ResolutionCode];

/**
 * job 审核推进转换表（6 态 DDL 权威；Admin 审核路径
 * REVIEW_REQUIRED=6 → SUCCEEDED=3（通过）/ FAILED=4（驳回），
 * 同事务 costMicroUsd 回填（经生成台账对接，登记 KMS 未闭环））。
 */
export const AI_JOB_REVIEW_FROM = 6; // REVIEW_REQUIRED
export const AI_JOB_REVIEW_TO_SUCCEEDED = 3;
export const AI_JOB_REVIEW_TO_FAILED = 4;

/**
 * 转换合法性校验（agent_domain）：from → to 是否合法；经转换表查。
 * @returns 合法返回 `true`；不合法返回 `false`（用例层映射 409 错误码）。
 */
export function canAgentDomainTransition(from: number, to: number): boolean {
  const allowed = AGENT_DOMAIN_TRANSITIONS[from];
  if (allowed === undefined) return false;
  return allowed.includes(to);
}

/**
 * 审批 withdrawal 前置校验（from ∈ {REQUESTED=1, REVIEWING=2}）。
 * @returns 可审批返回 `true`；否则 `false`（用例层抛 AD_WITHDRAWAL_NOT_REVIEWABLE）。
 */
export function canWithdrawalApprove(from: number): boolean {
  return WITHDRAWAL_APPROVE_FROM.includes(from);
}

/**
 * 裁决 trade 前置校验（from ∈ DISPUTE 态 3/4/5/6）。
 * @returns 可裁决返回 `true`；否则 `false`（用例层抛 AD_TRADE_NOT_DISPUTE）。
 */
export function canTradeAdjudicate(from: number): boolean {
  return TRADE_ADJUDICATE_FROM.includes(from);
}

/**
 * 审计 snapshot 脱敏校验（A.8 第 4 条红线：审计 snapshot 不得含
 * 消息正文 / 认证秘密 / 支付凭证明文；只允许 前后值摘要 + 关联对象
 * ID + 影响计数）。
 * @param snapshot 路由层传入的脱敏前后数据与关联对象。
 * @returns 校验通过的 snapshot（原样返回，供适配器落库）。
 * @throws AdminDomainError(AD_AUDIT_REQUIRED) 当 snapshot 缺失必填键
 *   或含黑名单敏感键（token / secret / password / 正文外敏感信息）。
 */
export function validateAuditSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  // 黑名单键（脱敏红线，A.8 第 4 条）：含任一键 → 拒绝落库。
  const SENSITIVE_KEYS = ['token', 'secret', 'password', 'credential', 'plaintext'];
  for (const key of Object.keys(snapshot)) {
    if (SENSITIVE_KEYS.some((sensitive) => key.toLowerCase().includes(sensitive))) {
      throw new AdminDomainError(AD.AD_AUDIT_REQUIRED, `审计 snapshot 含敏感键：${key}`, {
        retryable: false,
      });
    }
  }
  return snapshot;
}
