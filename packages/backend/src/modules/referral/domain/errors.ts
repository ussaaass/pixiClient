/**
 * referral 领域错误码 + 错误类型（SDD §9 第 6 步：邀请归因返佣）。
 *
 * 领域所有者：referral 模块（domain/errors.ts 纯函数，无 IO；用例层/适配器层
 * 经本表抛错，路由层映射 HTTP 错误码）。
 * 对应 SDD 章节：后端实施 SDD §4（用例/仓储错误映射）、§9 第 6 步
 * （邀请归因返佣与数据规范）、§3.2 实体归属矩阵（referral owns
 * referral_binding / referral_binding_event / referral_reward_allocation 3 表）。
 *
 * 错误码约定（REF 前缀，对齐 @gameing/contracts/referral + invite-agent 错误语义）：
 * - `REFERRAL_NOT_FOUND`：绑定行 / 奖励分配行缺失（不可重试，404 语义）。
 * - `BINDING_CHAIN_BROKEN`：链连续性校验失败（parent_2 非空 ⇒ parent_1 非空；
 *   或链含循环 / 自绑定）——领域前置校验失败（400 语义，数据不一致不可重试）。
 * - `REWARD_LOCKED`：奖励处于 FROZEN 未解冻期，不允许提前释放 / 提现门禁
 *   （2 天 / 1 天，SDD §4 "充值返点冻 2 天"；409 语义，可等待后重试）。
 * - `AGENT_DOMAIN_PENDING`：代理域处于 PENDING_REVIEW，不可行使域能力
 *   （409 语义，需 Admin 审批端点，§9 第 9 步）。
 * - `AGENT_DOMAIN_SUSPENDED`：代理域被 Admin 暂停（409 语义，可重试）。
 * - `AGENT_DOMAIN_REVOKED`：代理域已撤销（410 语义，实体保留供审计，不可恢复）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 行缺失 / 状态机转换影响行数 0
 *   （可重试，503 语义）。
 *
 * 幂等约定（SDD §4 "幂等先抢唯一约束"）：
 * - `U(user_id)`（referral_binding）命中 → 返回既有绑定行（`inserted: false`），
 *   不抛错；
 * - `U(binding_key)`（referral_binding_event）命中 → 返回既有 event 行
 *   （`inserted: false`），不抛错；
 * - 跨坐席 / 跨请求绑定冲突（已有上级不可再绑）→ 抛 `REFERRAL_NOT_FOUND`
 *   （语义：该用户无新绑定意图，已有链为准）——登记决策点，首版选择静默
 *   返回既有链而非 409。
 */

import { UniqueConstraintError } from 'sequelize';

/** referral 错误码常量表（REF 前缀；常量 0 不占位，错误码全 4xx/5xx 语义映射）。 */
export const REF = {
  /** 绑定 / 奖励 / 代理域行缺失（404 语义）。 */
  REFERRAL_NOT_FOUND: 'REFERRAL_NOT_FOUND',
  /** 链连续性校验失败（parent_n 非空 ⇒ parent_{n-1} 非空；自绑定 / 循环检测）（400 语义）。 */
  BINDING_CHAIN_BROKEN: 'BINDING_CHAIN_BROKEN',
  /** 奖励冻结期（充值返点 2 天 / 客损 1 天，SDD §4）（409 语义，等待解冻后重试）。 */
  REWARD_LOCKED: 'REWARD_LOCKED',
  /** 代理域 PENDING_REVIEW（需 Admin 审批，§9 第 9 步）（409 语义）。 */
  AGENT_DOMAIN_PENDING: 'AGENT_DOMAIN_PENDING',
  /** 代理域 SUSPENDED（409 语义，可重试）。 */
  AGENT_DOMAIN_SUSPENDED: 'AGENT_DOMAIN_SUSPENDED',
  /** 代理域 REVOKED（410 语义，不可恢复）。 */
  AGENT_DOMAIN_REVOKED: 'AGENT_DOMAIN_REVOKED',
  /** Sequelize 故障 / 行缺失 / 状态机影响行数 0（可重试，503 语义）。 */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const;

/** referral 错误码联合类型。 */
export type ReferralErrorCode = (typeof REF)[keyof typeof REF];

/**
 * 领域错误类（用例 / 仓储层抛出；路由层 `isReferralDomainError` 捕获映射 HTTP）。
 * 携带 `code`（REF 表之一）+ 可选 `retryable`（决定路由层 5xx vs 4xx 映射）。
 */
export class ReferralDomainError extends Error {
  constructor(
    public readonly code: ReferralErrorCode,
    message: string,
    public readonly options?: { retryable?: boolean },
  ) {
    super(message);
    this.name = 'ReferralDomainError';
  }
}

/** 类型守卫：捕获 ReferralDomainError（路由层错误映射用）。 */
export function isReferralDomainError(err: unknown): err is ReferralDomainError {
  return err instanceof ReferralDomainError;
}

/**
 * Sequelize 唯一约束冲突检测（幂等兜底用；U(user_id) / U(binding_key) /
 * U(order_id,user_id) / U(asset_hold_id) 命中 → 返回既有行，不产生第二行，
 * 验收红线"归因幂等"）。
 * 检测 `SequelizeUniqueConstraintError`（Sequelize 6 抽象）或
 * MySQL `ER_DUP_ENTRY`（errno 1062，驱动层直接抛出时兜底）。
 */
export function isDuplicateKeyError(err: unknown): boolean {
  if (err instanceof UniqueConstraintError) return true;
  const anyErr = err as { code?: string; errno?: number; sqlMessage?: string };
  if (anyErr.code === 'ER_DUP_ENTRY' || anyErr.errno === 1062) return true;
  return false;
}
