/**
 * 入座用例：POST /rooms/:roomId/join。
 *
 * 领域所有者：rooms 模块（room / room_membership / game_entry 写入；
 * round_player 若已有 round 则同步创建，round 模块不跨模块写）。
 * 对应 SDD 章节：后端实施 SDD §5.4（rooms/:roomId/join，契约已有 handler
 * 新实现）、§9 第 4 步（game_entry claim 幂等重放 + room_membership
 * SEATED=1 + U(user, active_marker) 防重复入座）；双资产文档 §2（入座
 * 不涉及资产分录，占款在开局 round-start 阶段完成）。
 *
 * 用例语义：
 * - room 存在且 WAITING=1 / ACTIVE=2（CLOSED=4 → ROOM_CLOSED）；
 * - 未满员（room_membership 有效入座数 < room.capacity，否则 ROOM_FULL）；
 * - game_entry claim（QUEUED=1 → SEATED=2 + room_id 回填；
 *   幂等重放：已 SEATED 同 room → 静默返回既有行；
 *   无有效 entry → GAME_ENTRY_NOT_FOUND）；
 * - room_membership SEATED=1（U(user, active_marker) 防重复；
 *   命中既有 SEATED 行 → 幂等返回既有 membership，不产生第二入座）；
 * - round_player（若 room 已有 ACTIVE round → 同步创建 round_player
 *   ACTIVE=1 行，asset_hold 占款由 round-start 用例统一完成，
 *   本用例只登记参与人行，不占款——决策点登记：入座时不占款，
 *   开局时统一占款，符合 SDD §9 第 4 步 "开局→提交→结算" 验收路径）；
 * - 锁顺序：room → room_membership → game_entry → round_player（SDD §4）。
 *
 * 错误码映射（R → 触发条件）：
 * - `ROOM_NOT_FOUND`：room 不存在（roomId 无对应行）。
 * - `ROOM_CLOSED`：room.status = CLOSED=4（不可再入座）。
 * - `ROOM_FULL`：有效入座数 ≥ room.capacity。
 * - `GAME_ENTRY_NOT_FOUND`：用户无有效 game_entry（status ∉ QUEUED/SEATED）。
 * - `GAME_ENTRY_EXPIRED`：game_entry.expires_at < now（资格过期）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 行缺失（可重试）。
 * - 成功 → JoinRoomResultDto（200；幂等重放 = 200 语义，重复入座返回
 *   既有 membership 不产生第二行，登记决策点）。
 */

import type { GameEntryModel } from '../../../infrastructure/database/models/game.js';
import { RoomStatus, EntryStatus } from '../../../infrastructure/database/models/game.js';
import { RoomDomainError, R } from '../domain/errors.js';
import type { RoomRepo, GameEntryRepo, RoundRepo, Tx } from '../ports/rooms-repository.js';
import type { Clock } from '../../wallet/ports/clock.js';

/** 入座结果（wire DTO；金额/ID 十进制字符串）。 */
export interface JoinRoomResultDto {
  roomId: string;
  seatNo: number;
  membershipId: string;
  /** 若 room 已有 ACTIVE round，同步创建的 round_player 行 id；否则 null。 */
  roundPlayerId: string | null;
  /** 幂等重放标志（true = 命中既有 membership，非新入座）。 */
  replay: boolean;
}

function assertGameEntrySnapshot(entry: GameEntryModel, userId: string, roomId: string, replay: boolean): void {
  if (
    typeof entry.id !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(entry.id) ||
    entry.userId !== userId ||
    (replay && (entry.status !== EntryStatus.SEATED || entry.roomId !== roomId)) ||
    (!replay && entry.status === EntryStatus.SEATED && entry.roomId !== roomId)
  ) {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'game entry snapshot is inconsistent');
  }
}

function assertValidEntryExpiry(expiresAt: string | Date): Date {
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime())) {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'game entry expiry snapshot is invalid');
  }
  return expiry;
}

function assertMembershipSnapshot(
  membership: { id: string; roomId: string; userId: string; seatNo: number },
  roomId: string,
  userId: string,
  capacity: number,
): void {
  if (
    membership.roomId !== roomId ||
    membership.userId !== userId ||
    typeof membership.id !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(membership.id) ||
    !Number.isInteger(membership.seatNo) ||
    membership.seatNo < 1 ||
    membership.seatNo > capacity
  ) {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'room membership snapshot is inconsistent');
  }
}

export class RoomJoinUseCase {
  constructor(
    private readonly roomRepo: RoomRepo,
    private readonly gameEntryRepo: GameEntryRepo,
    private readonly roundRepo: RoundRepo,
    private readonly clock: Clock,
  ) {}

  /**
   * POST /rooms/:roomId/join：入座 + 入局资格认领（同事务）。
   * 调用方（路由层）负责开事务，传入 `tx`。
   */
  async run(input: { userId: string; roomId: string; tx: Tx }): Promise<JoinRoomResultDto> {
    const { userId, roomId, tx } = input;

    // 1) 锁读 room（行锁；fencing 校验前置）。
    const room = await this.roomRepo.lockRoom(roomId, tx);
    if (room === null) {
      throw new RoomDomainError(R.ROOM_NOT_FOUND, 'room not found');
    }
    if (room.status === RoomStatus.CLOSED) {
      throw new RoomDomainError(R.ROOM_CLOSED, 'room is closed');
    }
    // WAITING=1 / ACTIVE=2 可入座；RECOVERING=3 拒绝（恢复中不可新入座）。
    if (room.status !== RoomStatus.WAITING && room.status !== RoomStatus.ACTIVE) {
      throw new RoomDomainError(R.ROOM_CLOSED, 'room not in joinable state');
    }
    if (!Number.isInteger(room.capacity) || room.capacity < 1) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'room capacity snapshot is invalid');
    }

    // 2) 入座尝试先查既有有效 membership。并发重试可能发生在房间已满后；
    // 精确重复仍应返回原座位，不可被满员检查误报 ROOM_FULL。
    const existingMembership = await this.roomRepo.findSeatedMembership(roomId, userId, tx);
    if (existingMembership !== null) {
      assertMembershipSnapshot(existingMembership, roomId, userId, room.capacity);
      const entry = await this.findActiveEntry(userId, tx);
      if (entry === null) {
        throw new RoomDomainError(R.GAME_ENTRY_NOT_FOUND, 'seated membership has no matching active entry');
      }
      assertGameEntrySnapshot(entry, userId, roomId, true);
      if (entry.status !== EntryStatus.SEATED || entry.roomId !== roomId) {
        throw new RoomDomainError(R.GAME_ENTRY_NOT_FOUND, 'seated membership has no matching active entry');
      }
      const now = this.clock.now();
      if (assertValidEntryExpiry(entry.expiresAt).getTime() <= now.getTime()) {
        throw new RoomDomainError(R.GAME_ENTRY_EXPIRED, 'game entry expired');
      }
      return {
        roomId,
        seatNo: existingMembership.seatNo,
        membershipId: existingMembership.id,
        roundPlayerId: null,
        replay: true,
      };
    }

    // 3) 满员判定（有效入座数 < capacity；active_marker = 1 的行数）。
    const seated = await this.roomRepo.seatedCount(roomId, tx);
    if (!Number.isInteger(room.capacity) || room.capacity < 1 || !Number.isInteger(seated) || seated < 0 || seated > room.capacity) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'room capacity or seated count snapshot is invalid');
    }
    if (seated >= room.capacity) {
      throw new RoomDomainError(R.ROOM_FULL, 'room is full');
    }

    // 4) 入座（U(user, active_marker) 防重复；命中既有 SEATED → 幂等重放）。
    const joinResult = await this.roomRepo.joinRoom({
      roomId,
      userId,
      seatNo: seated + 1, // 首个空座位号（简化；正式座位分配策略见决策点登记）
      tx,
    });

    const replay = !joinResult.inserted;
    const membership = joinResult.membership;
    assertMembershipSnapshot(membership, roomId, userId, room.capacity);
    if (membership.seatNo !== seated + 1) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'joined membership seat does not match allocated seat');
    }

    // 4) game_entry claim（QUEUED → SEATED + room_id 回填；幂等重放）。
    const entry = await this.findActiveEntry(userId, tx);
    if (entry === null) {
      throw new RoomDomainError(R.GAME_ENTRY_NOT_FOUND, 'no active game entry');
    }
    assertGameEntrySnapshot(entry, userId, roomId, false);
    const now = this.clock.now();
    if (assertValidEntryExpiry(entry.expiresAt).getTime() <= now.getTime()) {
      throw new RoomDomainError(R.GAME_ENTRY_EXPIRED, 'game entry expired');
    }
    if (entry.status === EntryStatus.QUEUED) {
      // 条件更新结果必须明确成功；未成功表示状态/归属并发变化，不可回报成功入座。
      const claim = await this.gameEntryRepo.claimEntry({ entryId: entry.id, roomId, tx });
      if (!claim.claimed) {
        throw new RoomDomainError(R.GAME_ENTRY_NOT_FOUND, 'game entry claim lost to another room or status change');
      }
      if (claim.entry === null) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'claimed game entry row is missing');
      }
      assertGameEntrySnapshot(claim.entry, userId, roomId, false);
      if (claim.entry.status !== EntryStatus.SEATED || claim.entry.roomId !== roomId) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'claimed game entry did not persist requested room');
      }
      if (assertValidEntryExpiry(claim.entry.expiresAt).getTime() <= now.getTime()) {
        throw new RoomDomainError(R.GAME_ENTRY_EXPIRED, 'game entry expired during claim');
      }
    } else if (entry.status !== EntryStatus.SEATED) {
      // FINISHED / CANCELLED / EXPIRED 不可再入座。
      throw new RoomDomainError(R.GAME_ENTRY_NOT_FOUND, 'game entry not in joinable state');
    }

    // 5) round_player（若 room 已有 ACTIVE round → 同步创建参与人行，
    // 不占款——占款在 round-start 用例统一完成）。
    // 首版简化：入座时不查 ACTIVE round（round-start 用例统一为在场
    // 玩家创建 round_player，避免跨用例竞态）；roundPlayerId = null。
    const roundPlayerId: string | null = null;
    void roundPlayerId; // 占位：首版入座不同步创建 round_player，开局时统一创建。

    return {
      roomId,
      seatNo: membership.seatNo,
      membershipId: membership.id,
      roundPlayerId,
      replay,
    };
  }

  /** 查用户当前有效 game_entry（status IN QUEUED/SEATED，未过期）。 */
  private async findActiveEntry(userId: string, tx: Tx): Promise<GameEntryModel | null> {
    const entries = await this.gameEntryRepo.listEntriesByUser(userId, tx);
    // 一个用户全平台最多一个有效准入（U(user, active_marker) 约束）。
    return entries.find((e: GameEntryModel) => e.status === EntryStatus.QUEUED || e.status === EntryStatus.SEATED) ?? null;
  }
}
