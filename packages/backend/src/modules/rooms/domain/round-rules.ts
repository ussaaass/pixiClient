/**
 * rooms 模块纯函数（fencing token 校验、round 状态机转换表、提交幂等键生成、
 * settlement input hash 计算、结算金额 wire 转换）。
 *
 * 领域所有者：rooms 模块（纯函数，无 IO；fencing/状态机/幂等键/哈希/金额转换
 * 全部在此层，用例层调用）。
 * 对应 SDD 章节：后端实施 SDD §9 第 4 步（房间与牌局：round 状态机、fencing
 * token、submission_key 幂等、settlement input hash 守恒）、§4（锁顺序与
 * fencing 约定）；任务硬约定（fencing token CHAR(36) UUID 每次状态变更 bump；
 * round 状态机 PREPARING→ACTIVE→SETTLING→SETTLED/CANCELLED/RECOVERING；
 * submission_key 幂等；settlement input hash = sha256(rules_snapshot+entries JSON)；
 * RoundSettlement.players[].water number → BigInt wire 转换）。
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// fencing token 校验
// ---------------------------------------------------------------------------

/**
 * 校验 fencing token 是否合法（round 写操作须与 room.fencing_token 一致，
 * 每次状态变更 bump；并发写者持旧 token → FENCING_CONFLICT 拒绝）。
 *
 * @param expected 当前 room/round 行的 fencing_token（十进制字符串 wire，>=1）。
 * @param provided 写操作携带的 fencing_token。
 * @returns true = 一致；false = 旧 token（FENCING_CONFLICT）。
 */
export function isValidFencingToken(expected: string, provided: string): boolean {
  return BigInt(expected) === BigInt(provided);
}

/**
 * bump fencing token（每次状态变更 +1，十进制字符串 wire；CHECK >=1 由迁移保证，
 * 此处从 1n 起步）。
 */
export function bumpFencingToken(current: string): string {
  return (BigInt(current) + 1n).toString();
}

// ---------------------------------------------------------------------------
// round 状态机转换表（PREPARING=1 → ACTIVE=2 → SETTLING=3 → SETTLED=4 /
// CANCELLED=5 / RECOVERING=6）
// ---------------------------------------------------------------------------

/** RoundStatus 取值（与 models/game.ts `RoundStatus` 常量一致，本地引用避免循环依赖）。 */
export const ROUND_STATUS = {
  PREPARING: 1,
  ACTIVE: 2,
  SETTLING: 3,
  SETTLED: 4,
  CANCELLED: 5,
  RECOVERING: 6,
} as const;

export type RoundStatusValue = (typeof ROUND_STATUS)[keyof typeof ROUND_STATUS];

/**
 * round 状态机转换表（合法转换；不在表内 → 拒绝）。
 * 键 = 当前状态，值 = 允许转换到的目标状态集合。
 *
 * - PREPARING(1) → ACTIVE(2)：开局（占款完成、round_player 全部 ACTIVE）。
 * - ACTIVE(2)   → SETTLING(3)：全部玩家提交完成。
 * - ACTIVE(2)   → CANCELLED(5)：取消（释放占款，round_player → ABORTED）。
 * - SETTLING(3) → SETTLED(4)：结算完成（settlement COMMITTED、分录已入账）。
 * - SETTLING(3) → CANCELLED(5)：结算前取消（罕见；释放占款）。
 * - SETTLED(4)  / CANCELLED(5)：终态，无出边。
 * - RECOVERING(6)：断线恢复中间态（客户端重连经 snapshot 补拉；
 *   重放走原 handler 版本，不重掷；恢复完成后回 ACTIVE 或 SETTLED，
 *   本表登记 RECOVERING → ACTIVE / RECOVERING → SETTLED 供恢复 handler 使用，
 *   首版由 round-start 重放命令幂等返回既有 round，不显式走 RECOVERING 转换）。
 */
export const ROUND_TRANSITIONS: Readonly<Record<RoundStatusValue, readonly RoundStatusValue[]>> = {
  [ROUND_STATUS.PREPARING]: [ROUND_STATUS.ACTIVE, ROUND_STATUS.CANCELLED],
  [ROUND_STATUS.ACTIVE]: [ROUND_STATUS.SETTLING, ROUND_STATUS.CANCELLED, ROUND_STATUS.RECOVERING],
  [ROUND_STATUS.SETTLING]: [ROUND_STATUS.SETTLED, ROUND_STATUS.CANCELLED],
  [ROUND_STATUS.SETTLED]: [],
  [ROUND_STATUS.CANCELLED]: [],
  [ROUND_STATUS.RECOVERING]: [ROUND_STATUS.ACTIVE, ROUND_STATUS.SETTLED],
};

/**
 * 校验 round 状态转换是否合法（状态机硬门禁；非法 → 用例映射
 * ROUND_NOT_ACTIVE / ROUND_IN_PROGRESS 等）。
 */
export function canRoundTransition(from: number, to: number): boolean {
  const targets = ROUND_TRANSITIONS[from as RoundStatusValue];
  if (targets === undefined) return false;
  return (targets as readonly number[]).includes(to);
}

// ---------------------------------------------------------------------------
// round_player 状态机转换表（ACTIVE=1 → SUBMITTED=2 → SETTLED=3 / ABORTED=4）
// ---------------------------------------------------------------------------

export const ROUND_PLAYER_STATUS = {
  ACTIVE: 1,
  SUBMITTED: 2,
  SETTLED: 3,
  ABORTED: 4,
} as const;

export type RoundPlayerStatusValue = (typeof ROUND_PLAYER_STATUS)[keyof typeof ROUND_PLAYER_STATUS];

/**
 * round_player 状态机转换表。
 * - ACTIVE(1) → SUBMITTED(2)：玩家出牌提交。
 * - SUBMITTED(2) → SETTLED(3)：结算完成。
 * - ACTIVE(1) / SUBMITTED(2) → ABORTED(4)：取消（释放占款）。
 * - SETTLED(3) / ABORTED(4)：终态，无出边。
 */
export const ROUND_PLAYER_TRANSITIONS: Readonly<Record<RoundPlayerStatusValue, readonly RoundPlayerStatusValue[]>> = {
  [ROUND_PLAYER_STATUS.ACTIVE]: [ROUND_PLAYER_STATUS.SUBMITTED, ROUND_PLAYER_STATUS.ABORTED],
  [ROUND_PLAYER_STATUS.SUBMITTED]: [ROUND_PLAYER_STATUS.SETTLED, ROUND_PLAYER_STATUS.ABORTED],
  [ROUND_PLAYER_STATUS.SETTLED]: [],
  [ROUND_PLAYER_STATUS.ABORTED]: [],
};

export function canRoundPlayerTransition(from: number, to: number): boolean {
  const targets = ROUND_PLAYER_TRANSITIONS[from as RoundPlayerStatusValue];
  if (targets === undefined) return false;
  return (targets as readonly number[]).includes(to);
}

// ---------------------------------------------------------------------------
// 提交幂等键生成
// ---------------------------------------------------------------------------

/**
 * 生成提交幂等键（`sub:{roundKey}:{userId}:{attempt}`，CHAR(36) 语义
 * 但本格式为可读复合键，round_player.submission_key U(round_id, submission_key)
 * 防重复提交；重放返回原结果）。
 *
 * @param roundKey round.round_key（CHAR(36) 全局业务编号）。
 * @param userId 玩家 user.id（十进制字符串 wire）。
 * @param attempt 客户端幂等尝试号（首次 = 1；重试同 attempt 命中 U 约束静默重放；
 *   不同 attempt = 新提交意图，由用例层做业务门禁）。
 */
export function submissionKeyOf(roundKey: string, userId: string, attempt: number): string {
  return `sub:${roundKey}:${userId}:${attempt}`;
}

// ---------------------------------------------------------------------------
// settlement input hash 计算
// ---------------------------------------------------------------------------

/**
 * 计算 settlement input hash（SHA-256；入参为规范化 JSON 字符串，
 * round.settlement_input_hash BINARY(32) 不可变结算意图摘要，
 * 防结算前篡改）。
 *
 * @param rulesSnapshot round.rules_snapshot（handler 提供的完整规则快照）。
 * @param entries 全部玩家的提交快照数组（round_player.submission_snapshot
 *   按 seat_no 升序排列；顺序稳定保证哈希确定性）。
 */
export function settlementInputHashOf(rulesSnapshot: Record<string, unknown>, entries: Record<string, unknown>[]): Uint8Array {
  const normalized = JSON.stringify({ rulesSnapshot, entries });
  return createHash('sha256').update(normalized).digest();
}

/**
 * 计算 result hash（SHA-256；结算结果摘要，settlement.result_hash BINARY(32)）。
 * 入参为结算结果对象（含 players[].water 等），JSON 稳定序列化后取摘要。
 */
export function resultHashOf(result: unknown): Uint8Array {
  const normalized = JSON.stringify(result);
  return createHash('sha256').update(normalized).digest();
}

// ---------------------------------------------------------------------------
// 结算金额 wire 转换（RoundSettlement.players[].water number → BigInt）
// ---------------------------------------------------------------------------

/**
 * 结算金额 wire 转换：`@gameing/shisanshui-rules` 的 `RoundSettlement.players[].water`
 * 为 number（JS 整数，金币枚数），结算前转 BigInt 做账本分录（SDD §2 第 2 条
 * "金额全链路 BigInt 计算，wire 十进制字符串"；本函数完成 number → BigInt 跨层转换，
 * 注册扩展点：rules 包 output 为 number 而非 BigInt，backend 在此边界做转换）。
 *
 * 正值 = 玩家赢（COI +water）；负值 = 玩家输（COI -|water|）；零 = 平局。
 * 系统账户为来源/归宿（双资产文档 §2）：玩家侧净额 = 0 时系统侧 = 0（内部转账守恒）。
 */
export function waterToBigInt(water: number): bigint {
  // water 为 JS 整数（shisanshui-rules 输出），安全范围内直接 BigInt。
  // 超安全范围（|water| > 2^53）→ 抛错（业务上限远小于此，防御性校验）。
  if (!Number.isSafeInteger(water)) {
    throw new RangeError(`settlement water must be a safe integer, received ${water}`);
  }
  return BigInt(water);
}

/** 有符号 BigInt → 十进制字符串 wire（负数带 `-` 前缀；零 = `0`）。 */
export function bigIntToWire(value: bigint): string {
  return value.toString();
}
