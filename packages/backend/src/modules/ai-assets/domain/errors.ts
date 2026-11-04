/**
 * ai-assets 领域错误码 + 错误类型（SDD §9 第 8 步：AI 素材台账 0017）。
 *
 * 领域所有者：ai-assets 模块（domain/errors.ts 纯函数，无 IO；用例层 /
 * 适配器层经本表抛错，路由层映射 HTTP 错误码）。
 * 对应 SDD 章节：后端实施 SDD §4（用例/仓储错误映射）、§9 第 8 步
 * （AI 素材台账：asset/ai_asset_* 与发布，与现有 tools/asset-generation
 * 台账对接）；数据库设计 SDD §5.10 / §5.11（asset 6 model + 全部状态常量）。
 *
 * 错误码约定（AIAS 前缀）：
 * - `JOB_NOT_FOUND`：ai_asset_job 行缺失（404 语义）。
 * - `JOB_NOT_CANCELLABLE`：job 非 QUEUED=1（不可取消，409 语义，
 *   状态机前置校验失败）。
 * - `RELEASE_NOT_FOUND`：asset_release 行缺失（404 语义）。
 * - `RELEASE_NOT_DRAFT`：release 非 DRAFT=1（不可发布，409 语义，
 *   状态机前置校验失败）。
 * - `ASSET_NOT_FOUND`：asset 行缺失（404 语义）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 行缺失 / 状态机影响行数 0
 *   （可重试，503 语义）。
 *
 * 注：ai-assets 首版只建台账写路径（job 创建 / 取消 + release 创建 /
 * 发布），不实际调外部 KMS / Kling 网关（登记 KMS 未闭环，§9 第 9 步
 * Admin 审核路径闭环）；job 创建后 QUEUED=1 不实际调外部 API。
 */

import { UniqueConstraintError } from 'sequelize';

/** ai-assets 错误码常量表（AIAS 前缀；常量 0 不占位，错误码全 4xx/5xx 语义映射）。 */
export const AIAS = {
  /** ai_asset_job 行缺失（404 语义）。 */
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  /** job 非 QUEUED=1，不可取消（409 语义）。 */
  JOB_NOT_CANCELLABLE: 'JOB_NOT_CANCELLABLE',
  /** asset_release 行缺失（404 语义）。 */
  RELEASE_NOT_FOUND: 'RELEASE_NOT_FOUND',
  /** release 非 DRAFT=1，不可发布（409 语义）。 */
  RELEASE_NOT_DRAFT: 'RELEASE_NOT_DRAFT',
  /** asset 行缺失（404 语义）。 */
  ASSET_NOT_FOUND: 'ASSET_NOT_FOUND',
  /** Sequelize 故障 / 行缺失 / 状态机影响行数 0（可重试，503 语义）。 */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const;

/** ai-assets 错误码联合类型。 */
export type AiAssetsErrorCode = (typeof AIAS)[keyof typeof AIAS];

/**
 * 领域错误类（用例 / 仓储层抛出；路由层 `isAiAssetsDomainError` 捕获映射 HTTP）。
 * 携带 `code`（AIAS 表之一）+ 可选 `retryable`（决定路由层 5xx vs 4xx 映射）。
 */
export class AiAssetsDomainError extends Error {
  constructor(
    public readonly code: AiAssetsErrorCode,
    message: string,
    public readonly options?: { retryable?: boolean },
  ) {
    super(message);
    this.name = 'AiAssetsDomainError';
  }
}

/** 类型守卫：捕获 AiAssetsDomainError（路由层错误映射用）。 */
export function isAiAssetsDomainError(err: unknown): err is AiAssetsDomainError {
  return err instanceof AiAssetsDomainError;
}

/**
 * Sequelize 唯一约束冲突检测（幂等兜底用；U(job_key) / U(content_hash,
 * byte_size) / U(release_key) 命中 → 返回既有行，不产生第二行，
 * 验收红线"台账幂等"）。
 * 检测 `UniqueConstraintError`（Sequelize 6 抽象）或
 * MySQL `ER_DUP_ENTRY`（errno 1062，驱动层直接抛出时兜底）。
 */
export function isDuplicateKeyError(err: unknown): boolean {
  if (err instanceof UniqueConstraintError) return true;
  const anyErr = err as { code?: string; errno?: number; sqlMessage?: string };
  if (anyErr.code === 'ER_DUP_ENTRY' || anyErr.errno === 1062) return true;
  return false;
}
