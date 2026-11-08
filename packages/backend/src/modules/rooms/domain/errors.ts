/**
 * rooms 模块领域错误（携带稳定业务错误码，由 HTTP 边界映射 envelope）。
 *
 * 领域所有者：rooms 模块（全部 application 用例抛出，adapters/HTTP 边界消费）。
 * 对应 SDD 章节：后端实施 SDD §9 第 4 步（房间与牌局）；与 wallet 模块
 * domain/errors.ts 同款纪律（每个用例文件维护自己的错误码映射表，
 * 本文件只提供领域抛错工具，共享错误码见 `@gameing/contracts/common/api-errors`）。
 *
 * 错误码表（R，contracts 登记）：
 * - ROOM_NOT_FOUND：room 不存在或已 CLOSED（room.status = CLOSED=4）。
 * - ROOM_FULL：房间座位已满（room_membership 有效入座数 ≥ room.capacity）。
 * - ROOM_CLOSED：房间已关闭，不可再入座/开局（room.status = CLOSED=4）。
 * - ROUND_NOT_FOUND：round 不存在（room 下无对应 round_key）。
 * - ROUND_NOT_ACTIVE：round 状态不允许当前操作（非 ACTIVE=2 时提交/结算，
 *   非 SETTLING=3 时结算触发）。
 * - ROUND_ALREADY_SETTLED：round 已 SETTLED=4，settlement 唯一行已存在
 *   （U(round_id) 命中，幂等重放语义，非错误）。
 * - GAME_ENTRY_NOT_FOUND：game_entry 不存在或已失效（status ∉ QUEUED/SEATED）。
 * - GAME_ENTRY_EXPIRED：game_entry 过期（expires_at < now，状态仍 QUEUED/SEATED）。
 * - WALLET_INSUFFICIENT：玩家可用金币余额 < 占款额（wagerCoins + maxLossHoldCoins）。
 * - FENCING_CONFLICT：并发写者持有旧 fencing_token，被拒绝（room/round 栅栏）。
 * - STORAGE_UNAVAILABLE：Sequelize 故障 / 行缺失 / 乐观 version 冲突（可重试）。
 * - ROUND_PLAYER_NOT_FOUND：round_player 不存在（round 下无对应用户参与人行）。
 * - INVALID_SUBMISSION：出牌数据 schema 校验失败（arrangement 格式非法）。
 * - ROUND_IN_PROGRESS：room 已有 ACTIVE/SETTLING round（开局命令重复触发）。
 */

import { RoomErrorCode } from '@gameing/contracts/common/api-errors';

export const R = RoomErrorCode;
export type RoomErrorCode = (typeof R)[keyof typeof R];

/** 携带 RoomErrorCode 的领域错误（HTTP 边界 `code` 字段直接取 `error.code`）。 */
export class RoomDomainError extends Error {
  /** 稳定业务错误码（RoomErrorCode 或通用码字符串）。 */
  readonly code: string;
  /** 是否可重试（默认 false；STORAGE_UNAVAILABLE 乐观冲突可重试）。 */
  readonly retryable: boolean;

  constructor(code: string, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = 'RoomDomainError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/** 判断是否为 rooms 领域错误（用例/装配层捕获分支用）。 */
export function isRoomDomainError(err: unknown): err is RoomDomainError {
  return err instanceof RoomDomainError;
}

/**
 * Sequelize 唯一约束冲突检测（ER_DUP_ENTRY）。
 * 与 wallet 模块 domain/errors.ts `isDuplicateKeyError` 同款语义，
 * rooms 模块独立维护（不跨模块 import 内部工具，保持模块内聚）。
 */
export function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { name?: string; parent?: { code?: string; errno?: number } } | null;
  if (e === null || e === undefined) return false;
  if (typeof e.name === 'string' && e.name === 'SequelizeUniqueConstraintError') return true;
  const code = e.parent?.code;
  const errno = e.parent?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}
