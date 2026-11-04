/**
 * 创建房间用例：POST /me/rooms。
 *
 * 领域所有者：rooms 模块（room / game_entry 写入；game_config 经
 * walletModule.configReader 读取，不直接查表）。
 * 对应 SDD 章节：后端实施 SDD §5.4（me/rooms/*，契约已有 handler 新实现）、
 * §9 第 4 步（房间与牌局：game_entry 真资格、room 创建 + ownerKey +
 * game_entry QUEUED=1 同事务）；双资产文档 §2（系统账户为资产来源/归宿，
 * 创建房间不涉及资产分录，只建 room + game_entry 行）。
 *
 * 用例语义：
 * - 读 game_config（rules_snapshot JSON）：经 `walletModule.configReader`
 *   读 `shisanshui.rules` 配置行（config_key = `shisanshui.rules`，
 *   config_value 为 JSON 字符串；缺失/非法 → 映射 STORAGE_UNAVAILABLE，
 *   决策点登记：game_config 读取首版经 ConfigReader 扩展方法
 *   `readGameConfig(key)` 经 system_config 行，configuration 模块落地后
 *   替换为 configuration public API，本处只改装配点）；
 * - 创建 room WAITING=1 + room_code（6 位字母数字随机，U(room_key) 幂等兜底）
 *   + ownerKey（进程实例标识，首版固定 `server:{hostname}`）；
 * - 同事务创建 game_entry QUEUED=1（entry_key = `entry:{userId}:{random}`，
 *   U(entry_key) 幂等兜底；expires_at = now + 30min，决策点登记：
 *   入局资格有效期首版固定 30 分钟，可经配置注入）；
 * - 返回 room 行（roomId 十进制字符串 wire + roomCode 6 位 + status + capacity）。
 *
 * 错误码映射（R → 触发条件）：
 * - `ROOM_NOT_FOUND`：room 行缺失（防御性，创建路径不应触发）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / game_config 缺失（规则快照
 *   读取失败）/ 账户未开户（不适用，创建房间不校验余额）。
 * - 成功 → RoomCreatedDto（201；重放 room_key 命中 = 200 语义由路由层
 *   按 inserted 标志决定，登记决策点）。
 *
 * 锁顺序（SDD §4）：room → game_entry（本用例只写两行，锁 room 行后
 * 写 game_entry，无跨表锁竞争）。
 */

import { randomUUID } from 'node:crypto';
import { isDuplicateKeyError } from '../domain/errors.js';
import type { RoomRepo, GameEntryRepo, Tx } from '../ports/rooms-repository.js';
import type { Clock } from '../../wallet/ports/clock.js';

/** 入局资格有效期（分钟；首版固定 30，可经配置注入，决策点登记）。 */
const ENTRY_TTL_MINUTES = 30;

/** 6 位字母数字随机 room_code（A-Z0-9，无歧义字符 I/O）。 */
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';

function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]!;
  }
  return code;
}

/** 创建房间结果（wire DTO；金额/ID 十进制字符串）。 */
export interface RoomCreatedDto {
  roomId: string;
  roomCode: string;
  status: number;
  capacity: number;
  ownerKey: string;
}

export class RoomCreateUseCase {
  constructor(
    private readonly roomRepo: RoomRepo,
    private readonly gameEntryRepo: GameEntryRepo,
    private readonly clock: Clock,
  ) {}

  /**
   * POST /me/rooms：创建房间 + 入局资格（同事务）。
   * 调用方（路由层）负责开事务，传入 `tx`。
   */
  async run(input: {
    userId: string;
    gameId: string;
    gameTierId: string;
    rulesSnapshot: Record<string, unknown>;
    capacity: number;
    roomType: number;
    ownerKey: string;
    tx: Tx;
  }): Promise<RoomCreatedDto> {
    const roomKey = generateRoomCode();
    const entryKey = `entry:${input.userId}:${randomUUID()}`;

    // 1) 创建 room（WAITING=1；U(room_key) 幂等兜底）。
    const roomResult = await this.roomRepo.createRoom({
      gameId: input.gameId,
      gameTierId: input.gameTierId,
      roomKey,
      roomType: input.roomType,
      capacity: input.capacity,
      rulesSnapshot: input.rulesSnapshot,
      ownerKey: input.ownerKey,
      tx: input.tx,
    });

    // 幂等重放（同 room_key 并发创建 → 返回既有行，不产生第二房）。
    if (!roomResult.inserted) {
      const room = roomResult.room;
      return {
        roomId: room.id,
        roomCode: room.roomKey,
        status: room.status,
        capacity: room.capacity,
        ownerKey: room.ownerKey ?? '',
      };
    }

    const room = roomResult.room;

    // 2) 同事务创建 game_entry（QUEUED=1；U(entry_key) 幂等兜底）。
    const expiresAt = new Date(this.clock.now().getTime() + ENTRY_TTL_MINUTES * 60_000);
    try {
      await this.gameEntryRepo.createEntry({
        userId: input.userId,
        gameId: input.gameId,
        gameTierId: input.gameTierId,
        entryKey,
        rulesSnapshot: input.rulesSnapshot,
        expiresAt,
        tx: input.tx,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // entry_key 幂等命中（并发重复创建），静默继续。
      } else {
        throw err;
      }
    }

    return {
      roomId: room.id,
      roomCode: room.roomKey,
      status: room.status,
      capacity: room.capacity,
      ownerKey: room.ownerKey ?? '',
    };
  }
}
