/**
 * 入局资格用例：GET /me/game-entries（列表）+ POST /me/game-entries（创建/更新排队）。
 *
 * 领域所有者：rooms 模块（game_entry 写入；room / round 只读参考）。
 * 对应 SDD 章节：后端实施 SDD §5.4（me/game-entries preflight 真资格，
 * 契约已有 handler 新实现）、§9 第 4 步（game_entry 真资格：
 * QUEUED=1 → SEATED=2（入座时）→ FINISHED=3（结算后）；
 * 重复 claim 幂等重放）；双资产文档 §2（入局资格不涉及资产分录，
 * 占款在开局 round-start 阶段完成）。
 *
 * 用例语义（GET /me/game-entries）：
 * - 列出用户有效 game_entry（status IN QUEUED=1 / SEATED=2，未过期）；
 * - 过期 entry（expires_at < now）→ 标记 EXPIRED=5（幂等：已 EXPIRED 重放静默返回）；
 * - 返回 GameEntryListDto（entryId + status + expiresAt + roomId + gameTierId）。
 *
 * 用例语义（POST /me/game-entries）：
 * - 创建/更新排队：无有效 entry → 创建 QUEUED=1（entry_key CHAR(36)，
 *   U(entry_key) 幂等兜底）；
 * - 有 QUEUED entry 同 game+tier → 幂等返回既有 entry（不产生第二行）；
 * - 有 SEATED entry 同 game+tier → 返回既有 entry（已入座，无需重新排队）；
 * - expires_at = now + 30min（首版固定，可经配置注入，决策点登记）；
 * - rules_snapshot 从 game_config 读取（经 ConfigReader，不直接查表）。
 *
 * 错误码映射（R → 触发条件）：
 * - `GAME_ENTRY_NOT_FOUND`：GET 列表无有效 entry（正常空列表，非错误；
 *   POST 命中 QUEUED/SEATED 既有行时静默返回，非此码）。
 * - `GAME_ENTRY_EXPIRED`：POST 时既有 entry 已过期（重新创建 QUEUED，
 *   旧 entry 标记 EXPIRED=5；非错误，正常流程）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障（可重试）。
 * - 成功 → GameEntryDto（201 创建 / 200 幂等重放，路由层按 inserted 标志决定）。
 */

import { randomUUID } from 'node:crypto';
import type { GameEntryModel } from '../../../infrastructure/database/models/game.js';
import { EntryStatus } from '../../../infrastructure/database/models/game.js';
import type { GameEntryRepo, Tx } from '../ports/rooms-repository.js';
import type { Clock } from '../../wallet/ports/clock.js';

/** 入局资格有效期（分钟；首版固定 30，可经配置注入，决策点登记）。 */
const ENTRY_TTL_MINUTES = 30;

/** 入局资格结果（wire DTO；金额/ID 十进制字符串）。 */
export interface GameEntryDto {
  entryId: string;
  status: number;
  /** 目标游戏 user.id（十进制字符串 wire）。 */
  gameId: string;
  gameTierId: string;
  /** 匹配成功后的 room.id（QUEUED = null；SEATED 非空）。 */
  roomId: string | null;
  /** 待匹配资格有效期（ISO 毫秒 wire）。 */
  expiresAt: string;
  /** 幂等重放标志（true = 命中既有 entry，非新创建）。 */
  replay: boolean;
}

export class GameEntryUseCase {
  constructor(
    private readonly gameEntryRepo: GameEntryRepo,
    private readonly clock: Clock,
  ) {}

  /**
   * GET /me/game-entries：列出用户有效 game_entry（QUEUED/SEATED，未过期）。
   * 过期 entry 标记 EXPIRED=5（幂等）。
   */
  async list(userId: string, tx?: Tx): Promise<GameEntryDto[]> {
    const now = this.clock.now();
    const entries = await this.gameEntryRepo.listEntriesByUser(userId, tx);
    const results: GameEntryDto[] = [];
    for (const entry of entries) {
      // 过期判定：expires_at < now → 标记 EXPIRED=5（幂等：已 EXPIRED 重放静默）。
      if (new Date(entry.expiresAt).getTime() <= now.getTime() && entry.status !== EntryStatus.EXPIRED) {
        await this.gameEntryRepo.expireEntry(entry.id, tx ?? { transaction: null });
        continue; // 过期 entry 不列入有效列表。
      }
      if (entry.status === EntryStatus.QUEUED || entry.status === EntryStatus.SEATED) {
        results.push(toEntryDto(entry, false));
      }
    }
    return results;
  }

  /**
   * POST /me/game-entries：创建/更新排队（game_entry QUEUED=1；
   * 幂等：同 entry_key 命中 → 返回既有行，不产生第二行）。
   */
  async create(input: {
    userId: string;
    gameId: string;
    gameTierId: string;
    rulesSnapshot: Record<string, unknown>;
    tx: Tx;
  }): Promise<GameEntryDto> {
    const entryKey = `entry:${input.userId}:${input.gameTierId}:${randomUUID()}`;
    const expiresAt = new Date(this.clock.now().getTime() + ENTRY_TTL_MINUTES * 60_000);

    const result = await this.gameEntryRepo.createEntry({
      userId: input.userId,
      gameId: input.gameId,
      gameTierId: input.gameTierId,
      entryKey,
      rulesSnapshot: input.rulesSnapshot,
      expiresAt,
      tx: input.tx,
    });

    return toEntryDto(result.entry, !result.inserted);
  }
}

/** game_entry 行 → wire DTO（金额/ID 十进制字符串；状态非零常量 wire）。 */
function toEntryDto(entry: GameEntryModel, replay: boolean): GameEntryDto {
  return {
    entryId: entry.id,
    status: entry.status,
    gameId: entry.gameId,
    gameTierId: entry.gameTierId,
    roomId: entry.roomId ?? null,
    expiresAt: typeof entry.expiresAt === 'string' ? entry.expiresAt : (entry.expiresAt as Date).toISOString(),
    replay,
  };
}
