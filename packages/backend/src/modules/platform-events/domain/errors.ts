/**
 * platform-events 领域错误码 + 错误类型（SDD §9 第 7 步：平台事件公告）。
 *
 * 领域所有者：platform-events 模块（domain/errors.ts 纯函数，无 IO；
 * 用例层 / 适配器层经本表抛错，路由层映射 HTTP 错误码）。
 * 对应 SDD 章节：后端实施 SDD §4（用例/仓储错误映射）、§9 第 7 步
 * （平台事件公告：game_event_instance 活跃公告读 + 公告投影 wire）、
 * §7.3（system-config / announcement-templates 发布前后值快照，
 * 公告模板由 configuration 模块发布，本模块只读投影）；
 * 数据库设计 SDD §5.6（game_event_instance 活跃公告读路径）。
 *
 * 错误码约定（PE 前缀，对齐 contracts platform-events/announcement 错误语义）：
 * - `ANNOUNCEMENT_NOT_FOUND`：公告行缺失（不可重试，404 语义）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 行缺失（可重试，503 语义）。
 *
 * 注：platform-events 首版只建读路径（GET /me/platform-events/active 替换
 * 公告 stub，SDD §5.4）；公告模板 / 活动配置的写路径归 §9 第 7 步
 * configuration 模块 + Admin 端点（§9 第 9 步），本模块不写 game_event_instance。
 */

import { UniqueConstraintError } from 'sequelize';

/** platform-events 错误码常量表（PE 前缀；常量 0 不占位，错误码全 4xx/5xx 语义映射）。 */
export const PE = {
  /** 公告行缺失（404 语义）。 */
  ANNOUNCEMENT_NOT_FOUND: 'ANNOUNCEMENT_NOT_FOUND',
  /** Sequelize 故障 / 行缺失（可重试，503 语义）。 */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const;

/** platform-events 错误码联合类型。 */
export type PlatformEventsErrorCode = (typeof PE)[keyof typeof PE];

/**
 * 领域错误类（用例 / 仓储层抛出；路由层 `isPlatformEventsDomainError` 捕获映射 HTTP）。
 * 携带 `code`（PE 表之一）+ 可选 `retryable`（决定路由层 5xx vs 4xx 映射）。
 */
export class PlatformEventsDomainError extends Error {
  constructor(
    public readonly code: PlatformEventsErrorCode,
    message: string,
    public readonly options?: { retryable?: boolean },
  ) {
    super(message);
    this.name = 'PlatformEventsDomainError';
  }
}

/** 类型守卫：捕获 PlatformEventsDomainError（路由层错误映射用）。 */
export function isPlatformEventsDomainError(err: unknown): err is PlatformEventsDomainError {
  return err instanceof PlatformEventsDomainError;
}

/**
 * Sequelize 唯一约束冲突检测（幂等兜底用；本模块只读路径无写操作，
 * 此工具为未来配置写路径 / 活动创建扩展预留，首版不抛错路径命中）。
 * 检测 `UniqueConstraintError`（Sequelize 6 抽象）或
 * MySQL `ER_DUP_ENTRY`（errno 1062，驱动层直接抛出时兜底）。
 */
export function isDuplicateKeyError(err: unknown): boolean {
  if (err instanceof UniqueConstraintError) return true;
  const anyErr = err as { code?: string; errno?: number; sqlMessage?: string };
  if (anyErr.code === 'ER_DUP_ENTRY' || anyErr.errno === 1062) return true;
  return false;
}
