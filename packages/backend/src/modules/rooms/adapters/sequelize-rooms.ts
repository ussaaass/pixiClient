/**
 * rooms 仓储适配器（Sequelize 实现各 Repo 端口；models/game.ts 7 model
 * 的唯一写入点，行锁/幂等/状态机转换全在此层）。
 *
 * 领域所有者：rooms 模块（models/game.ts 为其唯一 model 定义；
 * asset_hold 经 wallet 模块 AssetLedger 端口操作，不直接查表）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 room → round → round_player →
 * settlement，asset_account.id 升序 SELECT ... FOR UPDATE；幂等先抢
 * 唯一约束；所有分录/outbox 同事务）、§3.2 实体归属矩阵（game owns
 * room / room_membership / round / round_player / round_event /
 * settlement / game_entry，models/game.ts）、§9 第 4 步（房间与牌局）。
 *
 * 行锁与并发约定（与 wallet 适配器同款纪律）：
 * - `lockByPk` 经 Sequelize `lock: 'FOR UPDATE'`（InnoDB 行锁；字符串
 *   字面量写法，与 wallet `sequelize-wallet-ledger.ts` 同款）；
 * - 不可变表 round_event 只 create，model hooks 拦截 update/destroy
 *   （_shared.ts A.12 第 5 条）；
 * - 唯一约束幂等兜底：`U(room_key)` / `U(round_key)` / `U(round_id,
 *   submission_key)` / `U(round_id)` / `U(entry_key)` / `U(event_key)`
 *   命中 → 返回既有行（不产生第二笔，验收红线）；
 * - 状态机转换由用例层经 `domain/round-rules.ts` 纯函数校验，
 *   本层只做 UPDATE 落库（影响行数 0 = 状态已变 → 抛 FENCING_CONFLICT 或
 *   STORAGE_UNAVAILABLE，由用例层捕获映射）。
 *
 * 错误码映射（rooms domain/errors.ts R 表）：
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 行缺失 / 状态机转换影响行数 0
 *   （可重试）。
 * - `FENCING_CONFLICT`：fencing_token 校验失败（旧进程写入被拒；
 *   use case 校验 owner/token，本层 mutation 使用 expected-token/status
 *   条件更新并检查 affected rows，接管与旧 owner 写入竞争时 fail closed）。
 *
 * 结构约定（每表一类，不混类）：
 * 各 Repo 接口各有 `create` / `lockByPk` 等同名方法，一个类无法实现两个
 * 签名，故拆为 5 个独立类（`SequelizeRoomRepo` / `SequelizeRoundRepo` /
 * `SequelizeGameEntryRepo` / `SequelizeRoundEventRepo` /
 * `SequelizeSettlementRepo`），各实现自己的接口；共享 `txOf` 辅助函数
 * 保留在文件顶部，各 Repo 类都调。装配层（assembly.ts）按角色独立构造，
 * 与 payments 模块 `PaymentsSharedDeps` 同款模式。
 * 注：Sequelize 6 的 BIGINT 列在严格模式（string 属性接口）下 create/update
 * 入参经 `as never` 桥接（wallet 适配器同款写法，_shared.ts 第 8 条）。
 */

import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import type {
  RoomModel,
  RoomMembershipModel,
  RoundModel,
  RoundPlayerModel,
  RoundEventModel,
  SettlementModel,
  GameEntryModel,
} from '../../../infrastructure/database/models/game.js';
import {
  RoomStatus,
  MembershipStatus,
  RoundStatus,
  RoundPlayerStatus,
  RoundEventType,
  SettlementStatus,
  EntryStatus,
  RecordStatus,
} from '../../../infrastructure/database/models/game.js';
import type { RoomRepo, RoundRepo, GameEntryRepo, RoundEventRepo, SettlementRepo, Tx } from '../ports/rooms-repository.js';
import { RoomDomainError, R, isDuplicateKeyError } from '../domain/errors.js';

/** 取事务（Sequelize Transaction 鸭子类型；与 wallet 适配器同款约定）。
 * 返回 `Transaction | null`（exactOptionalPropertyTypes 下 undefined 不可赋给
 * null 槽，统一 null 化）。 */
function txOf(tx?: Tx): Transaction | null {
  return (tx?.transaction as Transaction | undefined) ?? null;
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null || left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function isValidSubmittedRoundPlayer(
  row: RoundPlayerModel,
  input: { roundId: string; userId: string; submissionKey: string; submissionHash: Uint8Array; submissionType: number },
): boolean {
  return (
    row.id !== null &&
    /^[1-9][0-9]{0,19}$/.test(row.id) &&
    row.roundId === input.roundId &&
    row.userId === input.userId &&
    row.status === RoundPlayerStatus.SUBMITTED &&
    row.submissionKey === input.submissionKey &&
    row.submissionType === input.submissionType &&
    bytesEqual(row.submissionHash, input.submissionHash) &&
    row.submittedAt instanceof Date &&
    Number.isFinite(Date.prototype.getTime.call(row.submittedAt))
  );
}

/** 共享 7 model 类（构造注入，不用全局，SDD §4）。 */
type GameModels = {
  RoomModel: typeof RoomModel;
  RoomMembershipModel: typeof RoomMembershipModel;
  RoundModel: typeof RoundModel;
  RoundPlayerModel: typeof RoundPlayerModel;
  RoundEventModel: typeof RoundEventModel;
  SettlementModel: typeof SettlementModel;
  GameEntryModel: typeof GameEntryModel;
};

/**
 * room + room_membership 仓储（RoomRepo；Sequelize 实现）。
 */
export class SequelizeRoomRepo implements RoomRepo {
  constructor(private readonly models: GameModels) {}

  async createRoom(input: {
    gameId: string;
    gameTierId: string;
    roomKey: string;
    roomType: number;
    capacity: number;
    rulesSnapshot: Record<string, unknown>;
    ownerKey: string;
    tx: Tx;
  }): Promise<{ inserted: boolean; room: RoomModel }> {
    const txq = txOf(input.tx);
    try {
      const room = await this.models.RoomModel.create(
        {
          gameId: input.gameId,
          gameTierId: input.gameTierId,
          roomKey: input.roomKey,
          roomType: input.roomType,
          capacity: input.capacity,
          rulesSnapshot: input.rulesSnapshot,
          ownerKey: input.ownerKey,
          status: RoomStatus.WAITING,
          version: '1',
          fencingToken: '1',
          checkpointVersion: '0',
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, room };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(room_key) 幂等命中 → 返回既有行（不产生第二房）。
        const existing = await this.models.RoomModel.findOne({
          where: { roomKey: input.roomKey },
          transaction: txq,
        });
        if (existing === null) {
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'room_key conflict without row', { retryable: true });
        }
        return { inserted: false, room: existing };
      }
      throw err;
    }
  }

  async lockRoom(roomId: string, tx: Tx): Promise<RoomModel | null> {
    const txq = txOf(tx);
    return this.models.RoomModel.findByPk(roomId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
  }

  async listRoomsByUser(userId: string, tx?: Tx): Promise<RoomModel[]> {
    // GET /me/rooms：经 room_membership 联查（有效入座 = active_marker=1）。
    // 首版简化：直接联表查（生产可加 Redis 缓存，决策点登记）。
    const txq = txOf(tx);
    const memberships = await this.models.RoomMembershipModel.findAll({
      where: { userId, status: MembershipStatus.SEATED },
      transaction: txq,
    });
    if (memberships.length === 0) return [];
    const roomIds = memberships.map((m) => m.roomId);
    return this.models.RoomModel.findAll({
      where: { id: roomIds, status: { [Op.in]: [RoomStatus.WAITING, RoomStatus.ACTIVE, RoomStatus.RECOVERING] } },
      transaction: txq,
    });
  }

  async findSeatedMembership(roomId: string, userId: string, tx: Tx): Promise<RoomMembershipModel | null> {
    return this.models.RoomMembershipModel.findOne({
      where: { roomId, userId, status: MembershipStatus.SEATED },
      transaction: txOf(tx),
    });
  }

  async joinRoom(input: {
    roomId: string;
    userId: string;
    seatNo: number;
    tx: Tx;
  }): Promise<{ inserted: boolean; membership: RoomMembershipModel }> {
    const txq = txOf(input.tx);
    try {
      const membership = await this.models.RoomMembershipModel.create(
        {
          roomId: input.roomId,
          userId: input.userId,
          seatNo: input.seatNo,
          status: MembershipStatus.SEATED,
          joinedAt: new Date(),
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, membership };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(user, active_marker) 幂等命中 → 返回既有行（不产生第二入座）。
        const existing = await this.models.RoomMembershipModel.findOne({
          where: { roomId: input.roomId, userId: input.userId, status: MembershipStatus.SEATED },
          transaction: txq,
        });
        if (existing === null) {
          // U(user, active_marker) 全局唯一：用户可能在其他房间有有效入座。
          // 此处 U 约束是 user+active_marker 而非 room+user（models/game.ts 注释），
          // 跨房重复入座被拒 = 业务语义正确，映射 ROOM_FULL 由用例层前置读兜底。
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'join duplicate key without seated row', { retryable: true });
        }
        return { inserted: false, membership: existing };
      }
      throw err;
    }
  }

  async seatedCount(roomId: string, tx: Tx): Promise<number> {
    const txq = txOf(tx);
    return this.models.RoomMembershipModel.count({
      where: { roomId, status: MembershipStatus.SEATED },
      transaction: txq,
    });
  }

  async listSeated(roomId: string, tx: Tx): Promise<RoomMembershipModel[]> {
    const txq = txOf(tx);
    return this.models.RoomMembershipModel.findAll({
      where: { roomId, status: MembershipStatus.SEATED },
      order: [['seat_no', 'ASC']],
      transaction: txq,
    } as never);
  }

  async leaveRoom(roomId: string, userId: string, tx: Tx): Promise<RoomMembershipModel> {
    const txq = txOf(tx);
    const [rows] = await this.models.RoomMembershipModel.update(
      { status: MembershipStatus.LEFT, leftAt: new Date() } as never,
      {
        where: { roomId, userId, status: MembershipStatus.SEATED },
        transaction: txq,
      } as never,
    );
    if (rows === 0) {
      // 已 LEFT（幂等重放）→ 返回既有行。
      const existing = await this.models.RoomMembershipModel.findOne({
        where: { roomId, userId },
        transaction: txq,
      });
      if (existing === null) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'leave without membership row', { retryable: true });
      }
      return existing;
    }
    return (await this.models.RoomMembershipModel.findOne({
      where: { roomId, userId },
      transaction: txq,
    }))!;
  }

  async closeRoom(roomId: string, tx: Tx): Promise<RoomModel> {
    const txq = txOf(tx);
    await this.models.RoomModel.update(
      { status: RoomStatus.CLOSED, closedAt: new Date() } as never,
      { where: { id: roomId }, transaction: txq } as never,
    );
    return (await this.models.RoomModel.findByPk(roomId, { transaction: txq }))!;
  }

  async markRoomActive(roomId: string, newFencingToken: bigint, tx: Tx): Promise<void> {
    const txq = txOf(tx);
    await this.models.RoomModel.update(
      { status: RoomStatus.ACTIVE, fencingToken: newFencingToken.toString() } as never,
      { where: { id: roomId }, transaction: txq } as never,
    );
  }

  async claimRoomRecovery(input: { roomId: string; expectedFencingToken: string; newFencingToken: string; tx: Tx }): Promise<void> {
    const txq = txOf(input.tx);
    const [rows] = await this.models.RoomModel.update(
      { status: RoomStatus.RECOVERING, fencingToken: input.newFencingToken } as never,
      {
        where: { id: input.roomId, status: RoomStatus.ACTIVE, fencingToken: input.expectedFencingToken },
        transaction: txq,
      } as never,
    );
    if (rows !== 1) throw new RoomDomainError(R.FENCING_CONFLICT, 'room recovery compare-and-swap failed');
  }
}

/**
 * round + round_player 仓储（RoundRepo；Sequelize 实现）。
 */
export class SequelizeRoundRepo implements RoundRepo {
  constructor(
    private readonly models: GameModels,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createRound(input: {
    roomId: string;
    roundNo: bigint;
    roundKey: string;
    fencingToken: string;
    handlerVersion: string;
    rulesSnapshot: Record<string, unknown>;
    rulesHash: Uint8Array;
    tx: Tx;
  }): Promise<{ inserted: boolean; round: RoundModel }> {
    const txq = txOf(input.tx);
    try {
      const round = await this.models.RoundModel.create(
        {
          roomId: input.roomId,
          roundNo: input.roundNo.toString(),
          roundKey: input.roundKey,
          fencingToken: input.fencingToken,
          handlerVersion: input.handlerVersion,
          rulesSnapshot: input.rulesSnapshot,
          rulesHash: input.rulesHash,
          status: RoundStatus.PREPARING,
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, round };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(round_key) 幂等命中 → 返回既有行（不产生第二局，round.start 命令重放）。
        const existing = await this.models.RoundModel.findOne({
          where: { roundKey: input.roundKey },
          transaction: txq,
        });
        if (existing === null) {
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round_key conflict without row', { retryable: true });
        }
        return { inserted: false, round: existing };
      }
      throw err;
    }
  }

  async findRoundRoomId(roundId: string, tx: Tx): Promise<{ roomId: string } | null> {
    const txq = txOf(tx);
    const round = await this.models.RoundModel.findByPk(roundId, {
      attributes: ['roomId'],
      transaction: txq,
    } as never);
    return round === null ? null : { roomId: round.roomId };
  }

  async lockRound(roundId: string, tx: Tx): Promise<RoundModel | null> {
    const txq = txOf(tx);
    return this.models.RoundModel.findByPk(roundId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
  }

  async findRoundByRoundKey(roundKey: string, tx?: Tx): Promise<RoundModel | null> {
    const txq = txOf(tx);
    return this.models.RoundModel.findOne({ where: { roundKey }, transaction: txq });
  }

  async findActiveRoundByRoom(roomId: string, tx: Tx): Promise<RoundModel | null> {
    const txq = txOf(tx);
    return this.models.RoundModel.findOne({
      where: {
        roomId,
        status: { [Op.in]: [RoundStatus.PREPARING, RoundStatus.ACTIVE, RoundStatus.SETTLING] },
      },
      order: [['round_no', 'DESC']],
      transaction: txq,
    } as never);
  }

  async maxRoundNoByRoom(roomId: string, tx: Tx): Promise<bigint> {
    const txq = txOf(tx);
    const row = await this.models.RoundModel.max('roundNo' as never, { where: { roomId }, transaction: txq } as never);
    return row === null ? 0n : BigInt(row as string);
  }

  async createRoundPlayer(input: {
    roundId: string;
    userId: string;
    roomMembershipId: string | null;
    seatNo: number;
    assetHoldId: string;
    wagerCoins: string;
    maxLossHoldCoins: string;
    fencingToken: string;
    tx: Tx;
  }): Promise<{ inserted: boolean; roundPlayer: RoundPlayerModel }> {
    const txq = txOf(input.tx);
    try {
      const rp = await this.models.RoundPlayerModel.create(
        {
          roundId: input.roundId,
          userId: input.userId,
          roomMembershipId: input.roomMembershipId,
          seatNo: input.seatNo,
          assetHoldId: input.assetHoldId,
          wagerCoins: input.wagerCoins,
          maxLossHoldCoins: input.maxLossHoldCoins,
          status: RoundPlayerStatus.ACTIVE,
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, roundPlayer: rp };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(round, user) 幂等命中 → 返回既有行。
        const existing = await this.models.RoundPlayerModel.findOne({
          where: { roundId: input.roundId, userId: input.userId },
          transaction: txq,
        });
        if (existing === null) {
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round_player duplicate without row', { retryable: true });
        }
        return { inserted: false, roundPlayer: existing };
      }
      throw err;
    }
  }

  async submitRound(input: {
    roundId: string;
    userId: string;
    submissionKey: string;
    submissionSnapshot: Record<string, unknown>;
    submissionHash: Uint8Array;
    submissionType: number;
    tx: Tx;
  }): Promise<{ inserted: boolean; roundPlayer: RoundPlayerModel }> {
    const txq = txOf(input.tx);
    // 先读既有 round_player（ACTIVE=1），UPDATE 推进到 SUBMITTED=2。
    const existing = await this.models.RoundPlayerModel.findOne({
      where: { roundId: input.roundId, userId: input.userId },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (existing === null) {
      // round_player 行不存在（未开局即提交）→ ROUND_PLAYER_NOT_FOUND。
      throw new RoomDomainError(R.ROUND_PLAYER_NOT_FOUND, 'round_player row not found');
    }

    // 幂等重放只能接受相同键、相同内容；同键异内容不得静默沿用旧结果。
    if (existing.status === RoundPlayerStatus.SUBMITTED) {
      if (existing.submissionKey === input.submissionKey && bytesEqual(existing.submissionHash, input.submissionHash)) {
        if (!isValidSubmittedRoundPlayer(existing, input)) {
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round_player replay snapshot is malformed', { retryable: true });
        }
        return { inserted: false, roundPlayer: existing };
      }
      throw new RoomDomainError(R.ROUND_NOT_ACTIVE, 'round player already submitted with a different request');
    }

    const [rows] = await this.models.RoundPlayerModel.update(
      {
        status: RoundPlayerStatus.SUBMITTED,
        submissionKey: input.submissionKey,
        submissionSnapshot: input.submissionSnapshot,
        submissionHash: input.submissionHash,
        submissionType: input.submissionType,
        submittedAt: this.now(),
      } as never,
      {
        where: { id: existing.id, status: RoundPlayerStatus.ACTIVE },
        transaction: txq,
      } as never,
    );
    if (rows !== 1) {
      if (rows !== 0) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round_player submit update affected an unexpected row count', {
          retryable: true,
        });
      }
      // 状态已非 ACTIVE（SUBMITTED/SETTLED/ABORTED）→ 幂等或非法转换。
      // 行已推进为 SUBMITTED 时，仅相同 submission key 与摘要视为安全重放。
      const reloaded = await this.models.RoundPlayerModel.findOne({
        where: { id: existing.id },
        transaction: txq,
      });
      if (
        reloaded !== null &&
        reloaded.status === RoundPlayerStatus.SUBMITTED &&
        reloaded.submissionKey === input.submissionKey &&
        bytesEqual(reloaded.submissionHash, input.submissionHash)
      ) {
        if (!isValidSubmittedRoundPlayer(reloaded, input)) {
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round_player replay snapshot is malformed', { retryable: true });
        }
        return { inserted: false, roundPlayer: reloaded };
      }
      if (reloaded !== null && reloaded.status === RoundPlayerStatus.SUBMITTED) {
        throw new RoomDomainError(R.ROUND_NOT_ACTIVE, 'round player already submitted with a different request');
      }
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round_player submit state transition failed', { retryable: true });
    }

    const updated = await this.models.RoundPlayerModel.findOne({ where: { id: existing.id }, transaction: txq });
    if (
      updated === null ||
      updated.roundId !== input.roundId ||
      updated.userId !== input.userId ||
      updated.status !== RoundPlayerStatus.SUBMITTED ||
      updated.submissionKey !== input.submissionKey ||
      updated.submissionType !== input.submissionType ||
      !bytesEqual(updated.submissionHash, input.submissionHash) ||
      updated.submittedAt === null
    ) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round_player row mismatch after submit', { retryable: true });
    }
    return { inserted: true, roundPlayer: updated };
  }

  /**
   * 结算写入（创建 settlement PREPARED=1 行；round/round_player 状态推进
   * 由用例层经 markRoundSettled / markRoundPlayerSettled 同事务完成，
   * 此处保持 RoundRepo 接口完整）。
   * 唯一性：settlement U(round_id) 命中 → 幂等返回既有行（验收红线）。
   */
  async settleRound(input: {
    roundId: string;
    settlementInputHash: Uint8Array;
    resultHash: Uint8Array;
    resultSnapshot: Record<string, unknown>;
    assetOperationId: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; settlement: SettlementModel }> {
    const txq = txOf(input.tx);
    try {
      const settlement: SettlementModel = await this.models.SettlementModel.create(
        {
          roundId: input.roundId,
          assetOperationId: input.assetOperationId,
          inputHash: input.settlementInputHash,
          resultHash: input.resultHash,
          resultSnapshot: input.resultSnapshot,
          status: SettlementStatus.PREPARED,
        } as never,
        { transaction: txq } as never,
      );
      if (
        settlement.roundId !== input.roundId ||
        settlement.status !== SettlementStatus.PREPARED ||
        !bytesEqual(settlement.inputHash, input.settlementInputHash) ||
        !bytesEqual(settlement.resultHash, input.resultHash)
      ) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement row mismatch after insert', { retryable: true });
      }
      return { inserted: true, settlement };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(round_id) 命中 = 幂等重放（验收红线"结算一次"，不产生第二笔）。
        const existing = await this.models.SettlementModel.findOne({
          where: { roundId: input.roundId },
          transaction: txq,
        });
        if (existing === null) {
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement U(round_id) conflict without row', { retryable: true });
        }
        if (
          existing.roundId !== input.roundId ||
          existing.status !== SettlementStatus.PREPARED ||
          !(existing.inputHash instanceof Uint8Array) ||
          !(existing.resultHash instanceof Uint8Array)
        ) {
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement row mismatch after unique conflict', { retryable: true });
        }
        return { inserted: false, settlement: existing };
      }
      throw err;
    }
  }

  async markRoundActive(roundId: string, tx: Tx): Promise<void> {
    const txq = txOf(tx);
    const [affectedRows] = await this.models.RoundModel.update(
      { status: RoundStatus.ACTIVE, playingStartedAt: new Date() } as never,
      { where: { id: roundId, status: RoundStatus.PREPARING }, transaction: txq } as never,
    );
    if (affectedRows !== 1) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round PREPARING to ACTIVE transition did not affect exactly one row', {
        retryable: true,
      });
    }
  }

  async markRoundSettling(roundId: string, tx: Tx): Promise<void> {
    const txq = txOf(tx);
    const [affectedRows] = await this.models.RoundModel.update(
      { status: RoundStatus.SETTLING } as never,
      { where: { id: roundId, status: RoundStatus.ACTIVE }, transaction: txq } as never,
    );
    if (affectedRows !== 1) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round ACTIVE to SETTLING transition did not affect exactly one row', {
        retryable: true,
      });
    }
  }

  async markRoundSettled(roundId: string, tx: Tx): Promise<void> {
    const txq = txOf(tx);
    const [affectedRows] = await this.models.RoundModel.update(
      { status: RoundStatus.SETTLED, settledAt: new Date() } as never,
      { where: { id: roundId, status: RoundStatus.SETTLING }, transaction: txq } as never,
    );
    if (affectedRows !== 1) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round SETTLING to SETTLED transition did not affect exactly one row', {
        retryable: true,
      });
    }
  }

  async markRoundPlayerSettled(roundPlayerId: string, netCoinDelta: string, tx: Tx): Promise<void> {
    const txq = txOf(tx);
    if (typeof netCoinDelta !== 'string' || !/^(0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(netCoinDelta)) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round_player settlement delta must be a canonical integer string');
    }
    const [affectedRows] = await this.models.RoundPlayerModel.update(
      { status: RoundPlayerStatus.SETTLED, netCoinDelta } as never,
      { where: { id: roundPlayerId, status: RoundPlayerStatus.SUBMITTED }, transaction: txq } as never,
    );
    if (affectedRows !== 1) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round_player SUBMITTED to SETTLED transition did not affect exactly one row', {
        retryable: true,
      });
    }
  }

  async cancelRound(input: { roundId: string; fencingToken: string; tx: Tx }): Promise<void> {
    const txq = txOf(input.tx);
    await this.models.RoundModel.update(
      { status: RoundStatus.CANCELLED } as never,
      { where: { id: input.roundId }, transaction: txq } as never,
    );
    await this.models.RoundPlayerModel.update(
      { status: RoundPlayerStatus.ABORTED } as never,
      {
        where: { roundId: input.roundId, status: { [Op.in]: [RoundPlayerStatus.ACTIVE, RoundPlayerStatus.SUBMITTED] } },
        transaction: txq,
      } as never,
    );
    // round_event CANCEL=6（不可变 append；fencing_token 当前值）。
    await this.models.RoundEventModel.create(
      {
        roundId: input.roundId,
        roundPlayerId: null,
        seq: '999',
        eventKey: `ev:cancel:${input.fencingToken}`,
        eventType: RoundEventType.CANCEL,
        fencingToken: input.fencingToken,
        payloadCiphertext: new Uint8Array(0),
        status: RecordStatus.RECORDED,
      } as never,
      { transaction: txq } as never,
    );
  }

  async recoverRound(input: { roundId: string; expectedFencingToken: string; newFencingToken: string; tx: Tx }): Promise<void> {
    const txq = txOf(input.tx);
    const [rows] = await this.models.RoundModel.update(
      { status: RoundStatus.RECOVERING, fencingToken: input.newFencingToken } as never,
      {
        where: { id: input.roundId, status: RoundStatus.ACTIVE, fencingToken: input.expectedFencingToken },
        transaction: txq,
      } as never,
    );
    if (rows !== 1) throw new RoomDomainError(R.FENCING_CONFLICT, 'round recovery compare-and-swap failed');
  }

  async listRoundPlayers(roundId: string, tx?: Tx): Promise<RoundPlayerModel[]> {
    const txq = txOf(tx);
    return this.models.RoundPlayerModel.findAll({
      where: { roundId },
      order: [['seat_no', 'ASC']],
      transaction: txq,
    } as never);
  }
}

/**
 * game_entry 仓储（GameEntryRepo；Sequelize 实现）。
 */
export class SequelizeGameEntryRepo implements GameEntryRepo {
  constructor(private readonly models: GameModels) {}

  async createEntry(input: {
    userId: string;
    gameId: string;
    gameTierId: string;
    entryKey: string;
    rulesSnapshot: Record<string, unknown>;
    expiresAt: Date;
    tx: Tx;
  }): Promise<{ inserted: boolean; entry: GameEntryModel }> {
    const txq = txOf(input.tx);
    try {
      const entry = await this.models.GameEntryModel.create(
        {
          userId: input.userId,
          gameId: input.gameId,
          gameTierId: input.gameTierId,
          entryKey: input.entryKey,
          rulesSnapshot: input.rulesSnapshot,
          expiresAt: input.expiresAt,
          status: EntryStatus.QUEUED,
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, entry };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(entry_key) 幂等命中 → 返回既有行。
        const existing = await this.models.GameEntryModel.findOne({
          where: { entryKey: input.entryKey },
          transaction: txq,
        });
        if (existing === null) {
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'entry_key conflict without row', { retryable: true });
        }
        return { inserted: false, entry: existing };
      }
      throw err;
    }
  }

  async claimEntry(input: { entryId: string; roomId: string; tx: Tx }): Promise<{ claimed: boolean; entry: GameEntryModel | null }> {
    const txq = txOf(input.tx);
    const [affectedRows] = await this.models.GameEntryModel.update(
      { status: EntryStatus.SEATED, roomId: input.roomId } as never,
      { where: { id: input.entryId, status: EntryStatus.QUEUED }, transaction: txq } as never,
    );
    const entry = await this.models.GameEntryModel.findByPk(input.entryId, { transaction: txq });
    return { claimed: affectedRows === 1, entry };
  }

  async lockEntry(entryId: string, tx: Tx): Promise<GameEntryModel | null> {
    const txq = txOf(tx);
    return this.models.GameEntryModel.findByPk(entryId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
  }

  async finishEntry(entryId: string, tx: Tx): Promise<GameEntryModel> {
    const txq = txOf(tx);
    await this.models.GameEntryModel.update(
      { status: EntryStatus.FINISHED } as never,
      { where: { id: entryId, status: EntryStatus.SEATED }, transaction: txq } as never,
    );
    return (await this.models.GameEntryModel.findByPk(entryId, { transaction: txq }))!;
  }

  async expireEntry(entryId: string, tx: Tx): Promise<GameEntryModel> {
    const txq = txOf(tx);
    await this.models.GameEntryModel.update(
      { status: EntryStatus.EXPIRED } as never,
      { where: { id: entryId, status: { [Op.in]: [EntryStatus.QUEUED, EntryStatus.SEATED] } }, transaction: txq } as never,
    );
    return (await this.models.GameEntryModel.findByPk(entryId, { transaction: txq }))!;
  }

  async listEntriesByUser(userId: string, tx?: Tx): Promise<GameEntryModel[]> {
    const txq = txOf(tx);
    return this.models.GameEntryModel.findAll({
      where: { userId, status: { [Op.in]: [EntryStatus.QUEUED, EntryStatus.SEATED] } },
      transaction: txq,
    } as never);
  }
}

/**
 * round_event 仓储（RoundEventRepo；不可变 append-only）。
 */
export class SequelizeRoundEventRepo implements RoundEventRepo {
  constructor(private readonly models: GameModels) {}

  async appendRoundEvent(input: {
    roundId: string;
    roundPlayerId: string | null;
    seq: string;
    eventKey: string;
    eventType: number;
    fencingToken: string;
    payloadCiphertext: Uint8Array;
    tx: Tx;
  }): Promise<{ inserted: boolean; event: RoundEventModel }> {
    const txq = txOf(input.tx);
    try {
      const event = await this.models.RoundEventModel.create(
        {
          roundId: input.roundId,
          roundPlayerId: input.roundPlayerId,
          seq: input.seq,
          eventKey: input.eventKey,
          eventType: input.eventType,
          fencingToken: input.fencingToken,
          payloadCiphertext: input.payloadCiphertext,
          status: RecordStatus.RECORDED,
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, event };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(event_key) 幂等命中 → 静默返回既有行（不可变表 append-only 语义）。
        const existing = await this.models.RoundEventModel.findOne({
          where: { eventKey: input.eventKey },
          transaction: txq,
        });
        if (existing === null) {
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'event_key conflict without row', { retryable: true });
        }
        return { inserted: false, event: existing };
      }
      throw err;
    }
  }

  async listRoundEventsAfterSeq(roundId: string, afterSeq: string, limit: number, tx?: Tx): Promise<RoundEventModel[]> {
    const txq = txOf(tx);
    const after = afterSeq === '' ? 0n : BigInt(afterSeq);
    return this.models.RoundEventModel.findAll({
      where: { roundId, seq: { [Op.gt]: after.toString() } },
      order: [['seq', 'ASC']],
      limit,
      transaction: txq,
    } as never);
  }
}

/**
 * settlement 仓储（SettlementRepo；唯一性 U(round_id)）。
 */
export class SequelizeSettlementRepo implements SettlementRepo {
  constructor(private readonly models: GameModels) {}

  async createSettlement(input: {
    roundId: string;
    inputHash: Uint8Array;
    resultHash: Uint8Array;
    resultSnapshot: Record<string, unknown>;
    assetOperationId: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; settlement: SettlementModel }> {
    const txq = txOf(input.tx);
    try {
      const settlement = await this.models.SettlementModel.create(
        {
          roundId: input.roundId,
          assetOperationId: input.assetOperationId,
          inputHash: input.inputHash,
          resultHash: input.resultHash,
          resultSnapshot: input.resultSnapshot,
          status: SettlementStatus.PREPARED,
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, settlement };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(round_id) 命中 = 幂等重放（验收红线"结算一次"，不产生第二笔）。
        const existing = await this.models.SettlementModel.findOne({
          where: { roundId: input.roundId },
          transaction: txq,
        });
        if (existing === null) {
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement U(round_id) conflict without row', { retryable: true });
        }
        return { inserted: false, settlement: existing };
      }
      throw err;
    }
  }

  async commitSettlement(settlementId: string, completedAt: Date, tx: Tx): Promise<SettlementModel> {
    const txq = txOf(tx);
    const [affectedRows] = await this.models.SettlementModel.update(
      { status: SettlementStatus.COMMITTED, completedAt } as never,
      { where: { id: settlementId, status: SettlementStatus.PREPARED }, transaction: txq } as never,
    );
    if (affectedRows !== 1) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement PREPARED to COMMITTED transition did not affect exactly one row', {
        retryable: true,
      });
    }
    const settlement = await this.models.SettlementModel.findByPk(settlementId, { transaction: txq });
    if (settlement === null || settlement.status !== SettlementStatus.COMMITTED) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'committed settlement row missing or mismatched', { retryable: true });
    }
    return settlement;
  }

  async findSettlementByRoundId(roundId: string, tx?: Tx): Promise<SettlementModel | null> {
    const txq = txOf(tx);
    return this.models.SettlementModel.findOne({ where: { roundId }, transaction: txq });
  }
}
