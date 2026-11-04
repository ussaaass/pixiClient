/**
 * admin 模块领域错误码 + 错误类型（SDD §9 第 9 步：Admin 全量切换收口）。
 *
 * 领域所有者：admin 模块（domain/errors.ts 纯函数，无 IO；用例层 /
 * 适配器层经本表抛错，路由层映射 HTTP 错误码）。
 * 对应 SDD 章节：后端实施 SDD §4（用例/仓储错误映射）、§9 第 9 步
 * （Admin 全量切换收口：/admin-api/v1 端点，Admin audience 鉴权；
 * 双人复核、审计 append-only、状态机前置校验）；数据库设计 SDD §5.2.1 /
 * §5.8（agent_domain / admin_permission / admin_audit_event /
 * agent_audit_event DDL 权威）。
 *
 * 错误码约定（AD 前缀）：
 * - `AD_ADMIN_UNAUTHORIZED`：Admin audience 令牌缺失 / 验签失败 /
 *   Redis admin session 撤销 / auth_version 不一致（401 语义）。
 * - `AD_PERMISSION_DENIED`：角色 / 权限前置校验失败（role_type 不含
 *   ADMIN=4 位；双人复核同 admin 操作）（403/409 语义）。
 * - `AD_AUDIT_REQUIRED`：审计事件缺失（写操作未同事务写
 *   admin_audit_event）（400 语义，内部不变量，路由层不应见）。
 * - `AD_AGENT_DOMAIN_NOT_FOUND`：agent_domain 行缺失（404 语义）。
 * - `AD_AGENT_DOMAIN_NOT_PENDING`：agent_domain 非 PENDING_REVIEW=1
 *   （审批 / 激活前置校验失败，409 语义）。
 * - `AD_AGENT_DOMAIN_NOT_ACTIVE`：agent_domain 非 ACTIVE=2（暂停 /
 *   撤销前置校验失败，409 语义）。
 * - `AD_TRADE_NOT_FOUND`：coin_market_trade 行缺失（404 语义）。
 * - `AD_TRADE_NOT_DISPUTE`：trade 非 DISPUTE 态（3/4/5/6），不可裁决
 *   （409 语义）。
 * - `AD_WITHDRAWAL_NOT_FOUND`：withdrawal 行缺失（404 语义）。
 * - `AD_WITHDRAWAL_NOT_REVIEWABLE`：withdrawal 非 REQUESTED=1 /
 *   REVIEWING=2，不可审批 / 驳回（409 语义）。
 * - `AD_JOB_NOT_FOUND`：ai_asset_job 行缺失（404 语义）。
 * - `AD_JOB_NOT_REVIEW`：job 非 REVIEW_REQUIRED=6，不可审核
 *   （409 语义）。
 * - `AD_USER_NOT_FOUND`：user 行缺失（404 语义）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 行缺失 / 状态机影响行数 0
 *   （可重试，503 语义）。
 *
 * 注：Admin 路由挂载条件 identityModule + adminModule + sequelize 均
 * 就绪；Admin audience 鉴权经 createAdminAuthMiddleware（Admin JWT
 * `aud: 'admin'` + Redis admin session + auth_version 三重门禁，
 * 与 player 中间件同款纪律）。
 */

import { UniqueConstraintError } from 'sequelize';

/** admin 错误码常量表（AD 前缀；常量 0 不占位，错误码全 4xx/5xx 语义映射）。 */
export const AD = {
  /** Admin audience 令牌缺失 / 验签失败 / session 撤销（401 语义）。 */
  AD_ADMIN_UNAUTHORIZED: 'AD_ADMIN_UNAUTHORIZED',
  /** 角色 / 权限前置校验失败 / 双人复核同 admin（403/409 语义）。 */
  AD_PERMISSION_DENIED: 'AD_PERMISSION_DENIED',
  /** 审计事件缺失（内部不变量，400 语义）。 */
  AD_AUDIT_REQUIRED: 'AD_AUDIT_REQUIRED',
  /** agent_domain 行缺失（404 语义）。 */
  AD_AGENT_DOMAIN_NOT_FOUND: 'AD_AGENT_DOMAIN_NOT_FOUND',
  /** agent_domain 非 PENDING_REVIEW=1（409 语义）。 */
  AD_AGENT_DOMAIN_NOT_PENDING: 'AD_AGENT_DOMAIN_NOT_PENDING',
  /** agent_domain 非 ACTIVE=2（409 语义）。 */
  AD_AGENT_DOMAIN_NOT_ACTIVE: 'AD_AGENT_DOMAIN_NOT_ACTIVE',
  /** coin_market_trade 行缺失（404 语义）。 */
  AD_TRADE_NOT_FOUND: 'AD_TRADE_NOT_FOUND',
  /** trade 非 DISPUTE 态（3/4/5/6），不可裁决（409 语义）。 */
  AD_TRADE_NOT_DISPUTE: 'AD_TRADE_NOT_DISPUTE',
  /** withdrawal 行缺失（404 语义）。 */
  AD_WITHDRAWAL_NOT_FOUND: 'AD_WITHDRAWAL_NOT_FOUND',
  /** withdrawal 非 REQUESTED=1/REVIEWING=2（409 语义）。 */
  AD_WITHDRAWAL_NOT_REVIEWABLE: 'AD_WITHDRAWAL_NOT_REVIEWABLE',
  /** ai_asset_job 行缺失（404 语义）。 */
  AD_JOB_NOT_FOUND: 'AD_JOB_NOT_FOUND',
  /** job 非 REVIEW_REQUIRED=6（409 语义）。 */
  AD_JOB_NOT_REVIEW: 'AD_JOB_NOT_REVIEW',
  /** user 行缺失（404 语义）。 */
  AD_USER_NOT_FOUND: 'AD_USER_NOT_FOUND',
  /** Sequelize 故障 / 行缺失 / 状态机影响行数 0（可重试，503 语义）。 */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const;

/** admin 错误码联合类型。 */
export type AdminErrorCode = (typeof AD)[keyof typeof AD];

/**
 * 领域错误类（用例 / 仓储层抛出；路由层 `isAdminDomainError` 捕获映射 HTTP）。
 * 携带 `code`（AD 表之一）+ 可选 `retryable`（决定路由层 5xx vs 4xx 映射）。
 */
export class AdminDomainError extends Error {
  constructor(
    public readonly code: AdminErrorCode,
    message: string,
    public readonly options?: { retryable?: boolean },
  ) {
    super(message);
    this.name = 'AdminDomainError';
  }
}

/** 类型守卫：捕获 AdminDomainError（路由层错误映射用）。 */
export function isAdminDomainError(err: unknown): err is AdminDomainError {
  return err instanceof AdminDomainError;
}

/**
 * Sequelize 唯一约束冲突检测（幂等兜底用；U(request_key) 命中 →
 * 返回既有行，不产生第二行，验收红线"审计幂等"）。
 * 检测 `UniqueConstraintError`（Sequelize 6 抽象）或
 * MySQL `ER_DUP_ENTRY`（errno 1062，驱动层直接抛出时兜底）。
 */
export function isDuplicateKeyError(err: unknown): boolean {
  if (err instanceof UniqueConstraintError) return true;
  const anyErr = err as { code?: string; errno?: number };
  if (anyErr.code === 'ER_DUP_ENTRY' || anyErr.errno === 1062) return true;
  return false;
}
