/**
 * 开局用例：POST /rooms/:roomId/rounds。
 *
 * 领域所有者：rooms 模块（round / round_player / asset_hold 写入；
 * asset_hold 经 wallet 模块 AssetLedger 端口操作，不直接查表）。
 * 对应 SDD 章节：后端实施 SDD §5.4（rooms/:roomId/rounds，契约已有 handler
 * 新实现）、§9 第 4 步（开局 → 提交 → 结算验收路径：round PREPARING=1 +
 * 逐玩家占款 + round_player ACTIVE=1）；双资产文档 §2（系统账户为资产
 * 来源/归宿，占款走 AssetLedger，extra JSON 标记 roundId）。
 *
 * 用例语义：
 * - room WAITING=1 → ACTIVE=2（fencing token 校验，旧 token → FENCING_CONFLICT）；
 * - round 创建（PREPARING=1 + round_key CHAR(36) + U(round_key) 幂等兜底，
 *   round.start 命令重放 = 幂等返回既有 round，不产生第二局）；
 * - 逐玩家占款（asset_hold，HoldType.GAME=1；wagerCoins 为服务器依据冻结
 *   game/tier stake policy 计算的有效流水金额，maxLossHoldCoins 为独立最大亏损冻结；
 *   登记扩展点：GAME_HOLD operation type 未注册，首版复用 TRANSFER=1 +
 *   extra JSON 标记 roundId）；
 * - round_player ACTIVE=1（asset_hold_id + wagerCoins + playerStateCiphertext）；
 * - round_event START=1（fencing_token 当前值，不可变 append）；
 * - 锁顺序：room → round → round_player → asset_account.id 升序（SDD §4）。
 *
 * 占款分录（WITHDRAWAL_HOLD=6 三分录，extra 标记 roundId）：
 * - 玩家 COI 账户：delta = 0，frozen_delta = +maxLossHoldCoins（占款进冻结）；
 * - 玩家 COI 账户 hold 分录：asset_hold 行 OPEN=1，hold_key = `hold:{roundKey}:{userId}`；
 * - asset_operation.extra = { roundId, roundKey, holdKey, amount: maxLossHoldCoins }。
 * 注：任务硬约定 "GAME_HOLD operation type 未注册，首版用 TRANSFER=1 +
 * extra JSON 标记 roundId"——本处按 AssetLedger.claimOperation 接口语义，
 * operationType 传 WalletOperationType.WITHDRAWAL_HOLD=6（占款专用类型，
 * 模型 AssetOperationType 已登记 6=WITHDRAWAL_HOLD），extra JSON 标记 roundId。
 * 登记决策点：若 Lead 确认 TRANSFER=1 而非 WITHDRAWAL_HOLD=6，改一行即可。
 *
 * 错误码映射（R → 触发条件）：
 * - `ROOM_NOT_FOUND`：room 不存在。
 * - `ROOM_CLOSED`：room.status = CLOSED=4。
 * - `ROUND_IN_PROGRESS`：room 已有 ACTIVE/SETTLING round（并发开局，U(round_no) 兜底）。
 * - `FENCING_CONFLICT`：携带的 fencing_token 与 room 当前值不一致（旧进程写入被拒）。
 * - `WALLET_INSUFFICIENT`：玩家可用金币余额 < maxLossHoldCoins（占款额，AGENTS.md 硬约束）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 账户未开户 / 乐观 version 冲突（可重试）。
 * - 成功 → RoundStartResultDto（201；重放 round_key 命中 = 200 语义由路由层
 *   按 inserted 标志决定，登记决策点）。
 */

import { randomUUID } from 'node:crypto';
import { HoldType } from '../../../infrastructure/database/models/wallet.js';
import { RoomStatus, RoundStatus, RoundEventType } from '../../../infrastructure/database/models/game.js';
import type { RoomMembershipModel } from '../../../infrastructure/database/models/game.js';
import { RoomDomainError, R } from '../domain/errors.js';
import type { RoomRepo, RoundRepo, RoundEventRepo, Tx } from '../ports/rooms-repository.js';
import type { AssetLedger, SystemIdentityPort, EntryIntent } from '../../wallet/ports/wallet-repository.js';
import { WalletOperationType, WalletEntryType } from '../../wallet/ports/wallet-repository.js';
import type { OutboxPort } from '../../wallet/ports/outbox-port.js';
import type { Clock } from '../../wallet/ports/clock.js';
import { requestHashOf, assertConservation } from '../../wallet/domain/ledger-rules.js';
import { parseShisanshuiStakeConfig, resolveShisanshuiStake } from '../domain/stake-config.js';

/** 开局结果（wire DTO；金额/ID 十进制字符串）。 */
export interface RoundStartResultDto {
  roundId: string;
  roundKey: string;
  status: number;
  /** 幂等重放标志（true = 命中既有 round，非新开局）。 */
  replay: boolean;
}

function assertRoundSnapshot(round: { id: string; roundKey: string; status: number; fencingToken: string }): void {
  if (
    typeof round.id !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(round.id) ||
    typeof round.roundKey !== 'string' ||
    round.roundKey.length === 0 ||
    !Object.values(RoundStatus).includes(round.status as (typeof RoundStatus)[keyof typeof RoundStatus]) ||
    typeof round.fencingToken !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(round.fencingToken)
  ) {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'persisted round snapshot is malformed');
  }
}

export class RoundStartUseCase {
  constructor(
    private readonly roomRepo: RoomRepo,
    private readonly roundRepo: RoundRepo,
    private readonly roundEventRepo: RoundEventRepo,
    private readonly ledger: AssetLedger,
    private readonly clock: Clock,
    private readonly systemIdentity: SystemIdentityPort,
    private readonly outbox: OutboxPort,
  ) {}

  /**
   * POST /rooms/:roomId/rounds：开局（room WAITING→ACTIVE + round PREPARING=1
   * + 逐玩家占款 + round_player ACTIVE=1 + round_event START=1，同事务）。
   */
  async run(input: {
    userId: string;
    roomId: string;
    fencingToken: string;
    /** Client-selected water units, constrained by the frozen tier stake policy. */
    waterUnits: string;
    tx: Tx;
  }): Promise<RoundStartResultDto> {
    const { userId, roomId, fencingToken, waterUnits, tx } = input;
    if (
      typeof fencingToken !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(fencingToken) ||
      BigInt(fencingToken) > 18_446_744_073_709_551_615n
    ) {
      throw new RoomDomainError(R.INVALID_SUBMISSION, 'fencing token must be a canonical unsigned integer');
    }
    if (typeof waterUnits !== 'string' || !/^[1-9][0-9]{0,18}$/.test(waterUnits)) {
      throw new RoomDomainError(R.INVALID_SUBMISSION, 'water units must be a positive canonical integer');
    }

    // 1) 锁读 room（行锁）；WAITING 的 token 在状态迁移前校验，ACTIVE replay 用 round token 校验。
    const room = await this.roomRepo.lockRoom(roomId, tx);
    if (room === null) {
      throw new RoomDomainError(R.ROOM_NOT_FOUND, 'room not found');
    }
    if (room.status === RoomStatus.CLOSED) {
      throw new RoomDomainError(R.ROOM_CLOSED, 'room is closed');
    }
    // Only a seated room member may start a round; auth alone is not room ownership.
    const members = await this.roomRepo.listSeated(roomId, tx);
    if (!members.some((member) => member.userId === userId)) {
      throw new RoomDomainError(R.ROUND_PLAYER_NOT_FOUND, 'user is not seated in this room');
    }
    if (
      typeof room.fencingToken !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(room.fencingToken) ||
      BigInt(room.fencingToken) > 18_446_744_073_709_551_615n ||
      typeof room.rulesSnapshot !== 'object' ||
      room.rulesSnapshot === null ||
      Array.isArray(room.rulesSnapshot)
    ) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'room state snapshot is malformed');
    }
    if (
      !Number.isInteger(room.capacity) ||
      members.some(
        (member) =>
          typeof member.id !== 'string' ||
          !/^[1-9][0-9]{0,19}$/.test(member.id) ||
          typeof member.userId !== 'string' ||
          !/^[1-9][0-9]{0,19}$/.test(member.userId) ||
          !Number.isInteger(member.seatNo) ||
          member.seatNo < 1 ||
          member.seatNo > room.capacity,
      )
    ) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'room membership snapshot is malformed');
    }
    const uniqueMemberIds = new Set(members.map((member) => member.userId));
    const uniqueSeatNumbers = new Set(members.map((member) => member.seatNo));
    if (members.length !== uniqueMemberIds.size) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'room has duplicate seated memberships for a user');
    }
    if (members.length !== uniqueSeatNumbers.size) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'room has duplicate seated membership seat numbers');
    }
    if (members.length !== 4) {
      throw new RoomDomainError(R.ROUND_IN_PROGRESS, 'classic round requires exactly four seated players');
    }
    if (room.capacity !== 4) {
      throw new RoomDomainError(R.ROUND_IN_PROGRESS, 'classic room capacity must be four');
    }

    // Resolve the published tier policy and reject invalid selection before any state or financial side effects.
    const policy = parseShisanshuiStakeConfig(room.rulesSnapshot['shisanshui.stake']);
    const resolvedStake = resolveShisanshuiStake(policy, waterUnits);
    const wagerCoins = resolvedStake.wagerCoins.toString();
    const maxLossHoldCoins = resolvedStake.maxLossHoldCoins.toString();

    // 2) room WAITING=1 → ACTIVE=2（状态机硬门禁；ACTIVE 重放 = 幂等返回既有 round）。
    if (room.status === RoomStatus.WAITING) {
      if (room.fencingToken !== fencingToken) {
        throw new RoomDomainError(R.FENCING_CONFLICT, 'fencing token mismatch');
      }
      // 更新 room 状态 + bump fencing_token（每次状态变更 +1）。
      await this.roomRepo.markRoomActive(roomId, BigInt(room.fencingToken) + 1n, tx);
    } else if (room.status !== RoomStatus.ACTIVE) {
      throw new RoomDomainError(R.ROUND_IN_PROGRESS, 'room not in startable state');
    }

    // 3) 查 room 已有 ACTIVE round（幂等重放：命中 → 返回既有 round，不产生第二局）。
    const existing = await this.roundRepo.findActiveRoundByRoom(roomId, tx);
    if (existing !== null) {
      assertRoundSnapshot(existing);
      if (existing.fencingToken !== fencingToken) {
        throw new RoomDomainError(R.FENCING_CONFLICT, 'round fencing token mismatch');
      }
      if (existing.status !== RoundStatus.PREPARING && existing.status !== RoundStatus.ACTIVE) {
        throw new RoomDomainError(R.ROUND_IN_PROGRESS, 'existing round is not start-replayable');
      }
      await this.assertRoundPlayersMatchMemberships(existing.id, members, tx);
      return { roundId: existing.id, roundKey: existing.roundKey, status: existing.status, replay: true };
    }
    if (room.status === RoomStatus.ACTIVE) {
      throw new RoomDomainError(R.ROUND_IN_PROGRESS, 'active room has no active round');
    }

    // 4) 创建 round（PREPARING=1 + round_key + U(round_key) 幂等兜底）。
    const roundKey = randomUUID();
    const maxNo = await this.roundRepo.maxRoundNoByRoom(roomId, tx);
    if (typeof maxNo !== 'bigint' || maxNo < 0n || maxNo >= 18_446_744_073_709_551_615n) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'room round number sequence is malformed or exhausted');
    }
    const roundRulesSnapshot = {
      ...room.rulesSnapshot,
      appliedStake: {
        policyKey: 'shisanshui.stake',
        coinPerWater: policy.coinPerWater.toString(),
        waterUnits: resolvedStake.waterUnits.toString(),
        wagerCoins,
        maxLossHoldCoins,
      },
    };
    const createResult = await this.roundRepo.createRound({
      roomId,
      roundNo: maxNo + 1n,
      roundKey,
      fencingToken: room.fencingToken,
      handlerVersion: 'shisanshui-classic-v1',
      rulesSnapshot: roundRulesSnapshot,
      rulesHash: requestHashOf(roundRulesSnapshot),
      tx,
    });
    if (!createResult.inserted) {
      // round_key 幂等命中（并发重复开局），先核实既有参与者快照再返回。
      const r = createResult.round;
      assertRoundSnapshot(r);
      await this.assertRoundPlayersMatchMemberships(r.id, members, tx);
      return { roundId: r.id, roundKey: r.roundKey, status: r.status, replay: true };
    }
    const round = createResult.round;

    // 5) 先读取并按账户 id 数值升序锁定全部玩家账户，再从锁定后快照校验可用余额。
    // 避免并发转账/其他牌局先消费可用余额导致 stale read 通过占款门禁。
    const playerAccounts = new Map<string, { id: string; userId: string; assetType: number; accountType: number }>();
    for (const member of members) {
      const account = await this.ledger.readAccount(member.userId, 1 /* AssetType.COIN */, 1 /* AccountType.PLAYER */, tx);
      if (account === null) throw new RoomDomainError(R.WALLET_INSUFFICIENT, 'player asset account not provisioned');
      playerAccounts.set(member.userId, account);
    }
    const lockedAccounts = await this.ledger.lockAccountsByIds(
      [...playerAccounts.values()]
        .map((account) => account.id)
        .sort((a, b) => {
          const left = BigInt(a);
          const right = BigInt(b);
          return left < right ? -1 : left > right ? 1 : 0;
        }),
      tx,
    );
    if (lockedAccounts.length !== playerAccounts.size || lockedAccounts.some((account) => account == null)) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'failed to lock every player coin account');
    }
    const lockedById = new Map(lockedAccounts.map((account) => [account.id, account]));

    // 逐玩家占款（asset_hold + asset_operation + 玩家 COI 账户冻结分录，同事务）。
    for (const member of members) {
      const account = playerAccounts.get(member.userId)!;
      const lockedAccount = lockedById.get(account.id);
      if (
        lockedAccount === undefined ||
        lockedAccount.userId !== member.userId ||
        lockedAccount.assetType !== 1 ||
        lockedAccount.accountType !== 1
      ) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'locked player coin account does not match membership');
      }

      // 余额门禁：必须基于持锁后的 COI 快照，可用余额 ≥ maxLossHoldCoins。
      const available = BigInt(lockedAccount.amount) - BigInt(lockedAccount.frozenAmount);
      if (available < BigInt(maxLossHoldCoins)) {
        throw new RoomDomainError(R.WALLET_INSUFFICIENT, 'insufficient available balance for hold');
      }

      // 占款操作键（幂等：hold_key = `hold:{roundKey}:{userId}`，U(hold_key) 兜底）。
      const holdKey = `hold:${roundKey}:${member.userId}`;
      const opKey = `game_hold:${holdKey}`;
      const extra = {
        roundId: round.id,
        roundKey,
        holdKey,
        amount: maxLossHoldCoins,
        wagerCoins,
        // GAME_HOLD operation type 未注册（资产类型常量 1~14 无 GAME_HOLD），
        // 首版复用 WITHDRAWAL_HOLD=6（占款专用类型，models/wallet.ts 已登记），
        // extra JSON 标记 roundId 区分游戏占款与提现占款（登记决策点）。
      };
      const claimed = await this.ledger.claimOperation({
        operationKey: opKey,
        operationType: WalletOperationType.WITHDRAWAL_HOLD,
        requestHash: requestHashOf(extra),
        initiatedByUserId: member.userId,
        extra,
        reason: `game round hold (round ${roundKey}, user ${member.userId})`,
        tx,
      });
      if (!claimed.inserted) {
        // 占款操作幂等命中（并发重复开局），跳过分录，继续下一玩家。
        continue;
      }

      // 占款分录：玩家 COI 冻结 +maxLossHoldCoins（entry_type HOLD=3）。
      const intents: EntryIntent[] = [
        {
          accountId: lockedAccount.id,
          delta: 0n,
          frozenDelta: BigInt(maxLossHoldCoins),
          entryType: WalletEntryType.HOLD,
          memo: `game round hold: +${maxLossHoldCoins} coins frozen (round ${roundKey})`,
        },
      ];
      const posts = await this.ledger.postEntries(claimed.operation.id, intents, tx);
      assertConservation(posts, 0n);

      // 创建 asset_hold 行（OPEN=1；hold_key U 幂等兜底）。
      const holdResult = await this.ledger.createHold({
        assetOperationId: claimed.operation.id,
        assetAccountId: lockedAccount.id,
        holdKey,
        holdType: HoldType.GAME,
        amount: maxLossHoldCoins,
        tx,
      });

      // 创建 round_player（ACTIVE=1 + asset_hold_id + wagerCoins）。
      await this.roundRepo.createRoundPlayer({
        roundId: round.id,
        userId: member.userId,
        roomMembershipId: member.id,
        seatNo: member.seatNo,
        assetHoldId: holdResult.hold.id,
        wagerCoins,
        maxLossHoldCoins,
        fencingToken: round.fencingToken,
        tx,
      });

      // 快照回填 + outbox 同事务（§6.3 "所有分录/outbox 同事务"）。
      await this.ledger.setCommitted(claimed.operation.id, this.clock.now(), { holdKey, amount: maxLossHoldCoins }, tx);
    }

    // 6) round PREPARING=1 → ACTIVE=2（占款完成，局可交互）。
    await this.roundRepo.markRoundActive(round.id, tx);

    // 7) round_event START=1（不可变 append；fencing_token 当前值）。
    const startEventKey = `ev:start:${roundKey}`;
    await this.roundEventRepo.appendRoundEvent({
      roundId: round.id,
      roundPlayerId: null,
      seq: '1',
      eventKey: startEventKey,
      eventType: RoundEventType.START,
      fencingToken: round.fencingToken,
      payloadCiphertext: new Uint8Array(JSON.stringify({ roundKey, roomId }).length), // 首版占位密文（加密层待闭环，决策点登记）
      tx,
    });

    return { roundId: round.id, roundKey, status: RoundStatus.ACTIVE, replay: false };
  }

  private async assertRoundPlayersMatchMemberships(roundId: string, members: RoomMembershipModel[], tx: Tx): Promise<void> {
    const roundPlayers = await this.roundRepo.listRoundPlayers(roundId, tx);
    const expectedMemberships = new Map(members.map((member) => [member.userId, member.id]));
    const expectedSeatByUserId = new Map(members.map((member) => [member.userId, member.seatNo]));
    const roundPlayerSeats = roundPlayers.map((player) => player.seatNo);
    if (
      roundPlayers.length !== members.length ||
      new Set(roundPlayerSeats).size !== roundPlayerSeats.length ||
      roundPlayers.some(
        (player) =>
          player.roomMembershipId === null ||
          expectedMemberships.get(player.userId) !== player.roomMembershipId ||
          expectedSeatByUserId.get(player.userId) !== player.seatNo,
      )
    ) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'active round players do not match seated memberships');
    }
  }
}
