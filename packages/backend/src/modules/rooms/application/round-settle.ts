/**
 * 结算触发 + 结果读取用例：GET /rounds/:roundId/settlement。
 *
 * 领域所有者：rooms 模块（round / settlement / round_player / round_event
 * 写入；asset_operation / asset_entry / asset_hold 经 wallet 模块
 * AssetLedger 端口操作，不直接查表）。
 * 对应 SDD 章节：后端实施 SDD §5.4（rounds/:roundId/settlement，契约
 * 已有 handler 新实现）、§9 第 4 步（结算一次、settlement 唯一入账、
 * 断线恢复重放验收红线）；双资产文档 §2（结算时玩家金币扣除走
 * AssetLedger TRANSFER=1，系统账户为来源/归宿；内部转账守恒）。
 *
 * 用例语义：
 * - round SETTLING=3 校验（非 SETTLING → ROUND_NOT_ACTIVE；
 *   SETTLED=4 → 幂等返回既有 settlement，不重复发币，验收红线）；
 * - 已结算结果的读取仍先校验玩家成员；触发结算要求客户端携带当前 fencing token，旧/缺失令牌拒绝；
 * - 调 ShisanshuiAdapterPort.settle（本地包纯函数，确定性，无 IO；
 *   输入 4 个 PlayerArrangement + ScoringConfig，输出 RoundSettlement）；
 * - settlement input hash 计算（sha256(rules_snapshot + entries JSON)，
 *   round.settlement_input_hash BINARY(32) 不可变结算意图摘要）；
 * - settlement PREPARED=1 行创建（U(round_id) 唯一约束幂等兜底，
 *   命中 → 返回既有 settlement，不重复发币——验收红线"结算一次"）；
 * - asset_operation TRANSFER=1 三分录（每玩家 COI ±water / 系统 COI ∓Σwater，
 *   内部转账守恒；占款释放：asset_hold RELEASED=4，frozen_delta -maxLossHoldCoins）；
 * - 结算同事务消费每名玩家 round_player.wagerCoins 的有效流水（不足时扣至 0）；
 * - settlement COMMITTED=2 + round SETTLED=4 + round_player SETTLED=3
 *   + round_event SETTLE=4 + outbox(topic 'game.round.settled')，同事务；
 * - 锁顺序：round → round_player → settlement → asset_account.id 升序（SDD §4）。
 *
 * 结算分录（TRANSFER=1 三分录，extra JSON 标记 roundId）：
 * 对每个玩家（water = 净输赢，正 = 赢 / 负 = 输）：
 * - 玩家 COI：delta = water（有符号），frozen_delta = -maxLossHoldCoins（释放占款）；
 * - 系统 COI：delta = -water（玩家赢 → 系统付；玩家输 → 系统收，
 *   系统账户为资产归宿，双资产文档 §2）；
 * - asset_hold：RELEASED=4，remaining → 0（经 AssetLedger.releaseHold）；
 * - turnover_state：remaining_coins = max(0, remaining_coins - wagerCoins)，锁行更新。
 * 守恒：玩家侧 Σwater = 0（内部转账零和，系统侧 Σ(-water) = 0），
 * 系统金币发行余额可为负（AGENTS.md 硬约束），不破坏玩家侧守恒。
 * 注：任务硬约定 "结算扣款/发币走 AssetLedger.postEntries（OPERATION_TYPE
 * TRANSFER=1，extra JSON 标记 roundId，注释登记 GAME_HOLD operation type
 * 未注册）"——本处按此约定，operationType = WalletOperationType.TRANSFER=1，
 * extra JSON 标记 { roundId, roundKey, settle: true }。
 *
 * 错误码映射（R → 触发条件）：
 * - `ROUND_NOT_FOUND`：round 不存在。
 * - `ROUND_NOT_ACTIVE`：round.status ≠ SETTLING=3（PREPARING/ACTIVE 拒绝结算；
 *   CANCELLED/RECOVERING 拒绝）。
 * - `ROUND_ALREADY_SETTLED`：round.status = SETTLED=4，settlement U(round_id)
 *   命中 → 幂等返回既有结果（非错误，HTTP 200 重放语义，验收红线"结算一次"）。
 * - `FENCING_CONFLICT`：缺少 fencing_token，或其与 round 当前值不一致。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 账户未开户 / 乐观 version 冲突（可重试）。
 * - 成功 → RoundSettlementDto（200；重放 = 200 语义，不重复发币，登记决策点）。
 */

import type { RoundModel, RoundPlayerModel, SettlementModel } from '../../../infrastructure/database/models/game.js';
import { HoldType } from '../../../infrastructure/database/models/wallet.js';
import { RoundPlayerStatus, RoundStatus, RoundEventType, SettlementStatus } from '../../../infrastructure/database/models/game.js';
import { RoomDomainError, R } from '../domain/errors.js';
import { settlementInputHashOf, resultHashOf, waterToBigInt } from '../domain/round-rules.js';
import type { RoundRepo, RoundEventRepo, SettlementRepo, Tx } from '../ports/rooms-repository.js';
import type { ShisanshuiAdapterPort } from '../ports/shisanshui-adapter.js';
import { validateArrangement } from '@gameing/shisanshui-rules';
import type { PlayerArrangement, ScoringConfig, RoundSettlement } from '@gameing/shisanshui-rules';
import type { EntryIntent, AssetLedger, SystemIdentityPort } from '../../wallet/ports/wallet-repository.js';
import { WalletOperationType, WalletEntryType } from '../../wallet/ports/wallet-repository.js';
import type { OutboxPort } from '../../wallet/ports/outbox-port.js';
import type { Clock } from '../../wallet/ports/clock.js';
import { requestHashOf, assertConservation } from '../../wallet/domain/ledger-rules.js';

/** 结算结果（wire DTO；金额/ID 十进制字符串）。 */
export interface RoundSettlementDto {
  roundId: string;
  settlementId: string;
  /** 各玩家净输赢（金币枚数，十进制字符串 wire；正 = 赢 / 负 = 输）。 */
  players: Array<{
    userId: string;
    water: string;
    foul: boolean;
  }>;
  /** 幂等重放标志（true = 命中既有 settlement，未重复发币）。 */
  replay: boolean;
}

type SettlementRoundPlayer = Pick<
  RoundPlayerModel,
  'id' | 'status' | 'roundId' | 'userId' | 'submissionSnapshot' | 'wagerCoins' | 'maxLossHoldCoins' | 'assetHoldId'
> & { roomMembershipId?: string | null };

function isByteHash(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === 32 && value.length === 32;
}

function bytesMatch(left: unknown, right: Uint8Array): boolean {
  return isByteHash(left) && left.every((byte, index) => byte === right[index]);
}

function assertSettlementWriteResult(
  value: unknown,
  expected: { roundId: string; inputHash: Uint8Array; resultHash: Uint8Array; resultSnapshot: Record<string, unknown> },
): SettlementModel {
  try {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
    const envelope = Object.getOwnPropertyDescriptors(value);
    const insertedDescriptor = envelope.inserted;
    const settlementDescriptor = envelope.settlement;
    if (
      Reflect.ownKeys(envelope).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(envelope, 'inserted') ||
      !Object.prototype.hasOwnProperty.call(envelope, 'settlement') ||
      insertedDescriptor === undefined ||
      !('value' in insertedDescriptor) ||
      insertedDescriptor.value !== true ||
      settlementDescriptor === undefined ||
      !('value' in settlementDescriptor)
    )
      throw new Error();
    const row = envelope.settlement!.value;
    if (row === null || typeof row !== 'object') throw new Error();
    const rowProto = Object.getPrototypeOf(row);
    const isPlainRow = rowProto === Object.prototype || rowProto === null;
    const modelReader = (row as { getDataValue?: (key: string) => unknown }).getDataValue;
    if (!isPlainRow && typeof modelReader !== 'function') throw new Error();
    const readField = (key: string): unknown => {
      if (isPlainRow) {
        const descriptor = Object.getOwnPropertyDescriptor(row, key);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new Error();
        return descriptor.value;
      }
      return modelReader!.call(row, key);
    };
    if (isPlainRow) {
      const allowedKeys = ['id', 'roundId', 'status', 'inputHash', 'resultHash', 'resultSnapshot'];
      const ownKeys = Reflect.ownKeys(row);
      if (ownKeys.length !== allowedKeys.length || ownKeys.some((key) => !allowedKeys.includes(String(key)))) throw new Error();
    }
    const id = readField('id');
    const rowRoundId = readField('roundId');
    const status = readField('status');
    const storedInputHash = readField('inputHash');
    const storedResultHash = readField('resultHash');
    const snapshot = readField('resultSnapshot');
    if (
      typeof id !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(id) ||
      rowRoundId !== expected.roundId ||
      status !== SettlementStatus.PREPARED ||
      !bytesMatch(storedInputHash, expected.inputHash) ||
      !bytesMatch(storedResultHash, expected.resultHash) ||
      !bytesMatch(resultHashOf(snapshot), expected.resultHash)
    )
      throw new Error();
    return row as SettlementModel;
  } catch {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement row returned by repository does not match the write intent');
  }
}

function normalizeRoundPlayers(value: unknown, requireCompleteRows: boolean): SettlementRoundPlayer[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (length === undefined || !('value' in length) || !Number.isSafeInteger(length.value) || length.value !== 4) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 5 || !keys.includes('length')) return null;
    for (let index = 0; index < 4; index += 1) if (!keys.includes(String(index))) return null;
    const rows: SettlementRoundPlayer[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < 4; index += 1) {
      const slot = Object.getOwnPropertyDescriptor(value, String(index));
      if (slot === undefined || !('value' in slot) || !slot.enumerable) return null;
      const row = slot.value;
      if (row === null || typeof row !== 'object') return null;
      const rowProto = Object.getPrototypeOf(row);
      const isPlainRow = rowProto === Object.prototype || rowProto === null;
      const reader = !isPlainRow ? (row as { getDataValue?: (key: string) => unknown }).getDataValue : undefined;
      if (!isPlainRow && typeof reader !== 'function') return null;
      const rowReader = (key: string): unknown => {
        if (isPlainRow) {
          const descriptor = Object.getOwnPropertyDescriptor(row, key);
          if (descriptor === undefined) return undefined;
          if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('invalid row field');
          return descriptor.value;
        }
        return reader!.call(row, key);
      };
      const completeKeys = ['id', 'roundId', 'userId', 'status', 'submissionSnapshot', 'wagerCoins', 'maxLossHoldCoins', 'assetHoldId'];
      const membershipKeys = ['userId', 'status'];
      const completeOptionalKeys = ['roomMembershipId', 'netCoinDelta'];
      const isCompleteRow = requireCompleteRows || Object.hasOwn(row, 'submissionSnapshot');
      const requiredKeys = isCompleteRow ? completeKeys : membershipKeys;
      const allowedOptionalKeys = isCompleteRow ? completeOptionalKeys : [];
      const values: Record<string, unknown> = {};
      const keysToRead = [...requiredKeys, ...allowedOptionalKeys];
      for (const key of keysToRead) {
        const rowValue = rowReader(key);
        if (rowValue === undefined && requiredKeys.includes(key)) return null;
        if (rowValue !== undefined) values[key] = rowValue;
      }
      if (isPlainRow) {
        const ownKeys = Reflect.ownKeys(row);
        const allowedKeys = [...requiredKeys, ...allowedOptionalKeys];
        if (
          ownKeys.length < requiredKeys.length || ownKeys.length > allowedKeys.length ||
          !requiredKeys.every((key) => ownKeys.includes(key)) || ownKeys.some((key) => !allowedKeys.includes(String(key)))
        ) return null;
      }
      const userId = values.userId;
      const status = values.status;
      if (
        typeof userId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(userId) || typeof status !== 'number' ||
        (requireCompleteRows ? !Object.values(RoundPlayerStatus).includes(status as never) : status !== RoundPlayerStatus.SETTLED) ||
        seen.has(userId)
      ) return null;
      const copy = Object.assign(Object.create(null), values) as Record<string, unknown>;
      rows.push(copy as unknown as SettlementRoundPlayer);
      seen.add(userId);
    }
    return rows;
  } catch {
    return null;
  }
}

export class RoundSettleUseCase {
  constructor(
    private readonly roundRepo: RoundRepo,
    private readonly roundEventRepo: RoundEventRepo,
    private readonly settlementRepo: SettlementRepo,
    private readonly shisanshui: ShisanshuiAdapterPort,
    private readonly ledger: AssetLedger,
    private readonly systemIdentity: SystemIdentityPort,
    private readonly clock: Clock,
    private readonly outbox: OutboxPort,
  ) {}

  /**
   * GET /rounds/:roundId/settlement：结算触发 + 结果读取（同事务）。
   * 幂等：settlement U(round_id) 命中 → 返回既有结果，不重复发币（验收红线）。
   */
  async run(input: {
    userId: string;
    roundId: string;
    /** Current round fencing token is required to trigger settlement; settled replays need no token. */
    fencingToken?: string;
    /** 各玩家出牌安排（handler 从 round_player.submission_snapshot 读取，
     *  由路由层组装后传入；首版由用例内部读 round_player 行组装）。 */
    tx: Tx;
  }): Promise<RoundSettlementDto> {
    const { userId, roundId, fencingToken, tx } = input;

    // 1) 锁读 round，再验证调用者是该局参与玩家；结算结果属于玩家私有数据。
    const round = await this.roundRepo.lockRound(roundId, tx);
    if (round === null) {
      throw new RoomDomainError(R.ROUND_NOT_FOUND, 'round not found');
    }
    const storedRoundPlayers: unknown = await this.roundRepo.listRoundPlayers(roundId, tx);
    const roundPlayers = normalizeRoundPlayers(storedRoundPlayers, round.status !== RoundStatus.SETTLED);
    if (roundPlayers === null) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round-player snapshot is malformed');
    }
    if (!roundPlayers.some((player) => player.userId === userId)) {
      throw new RoomDomainError(R.ROUND_PLAYER_NOT_FOUND, 'user is not a player in this round');
    }

    // 幂等重放：已 SETTLED=4 → 返回既有 settlement（不重复发币，验收红线）。
    if (round.status === RoundStatus.SETTLED) {
      this.assertAuthoritativeSettledSnapshots(roundPlayers);
      const existing = await this.settlementRepo.findSettlementByRoundId(roundId, tx);
      if (existing === null) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settled round without settlement row');
      }
      const replayInputHash = this.computeSettlementInputHash(round, roundPlayers);
      return this.toVerifiedReplayDto(existing, roundId, roundPlayers, true, replayInputHash);
    }
    // 非 SETTLING=3 拒绝结算（PREPARING/ACTIVE/CANCELLED/RECOVERING 均不可结算）。
    if (round.status !== RoundStatus.SETTLING) {
      throw new RoomDomainError(R.ROUND_NOT_ACTIVE, 'round not in settleable state');
    }
    if (
      typeof round.fencingToken !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(round.fencingToken) ||
      BigInt(round.fencingToken) > 18_446_744_073_709_551_615n
    ) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settling round fencing token snapshot is malformed');
    }
    // 触发结算必须持有当前 fencing token；缺失与过期 token 均 fail closed。
    if (
      typeof fencingToken !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(fencingToken) ||
      BigInt(fencingToken) > 18_446_744_073_709_551_615n ||
      round.fencingToken !== fencingToken
    ) {
      throw new RoomDomainError(R.FENCING_CONFLICT, 'fencing token missing or mismatched');
    }
    // roundPlayers 已在成员校验时全量读取（按 seat_no 升序；组装 PlayerArrangement 输入）。
    const roundPlayerIds = roundPlayers.map((player) => player.userId);
    if (
      roundPlayers.length !== 4 ||
      new Set(roundPlayerIds).size !== roundPlayerIds.length ||
      roundPlayers.some(
        (player) =>
          (player.status !== RoundPlayerStatus.SUBMITTED && player.status !== RoundPlayerStatus.SETTLED) ||
          typeof player.wagerCoins !== 'string' ||
          !/^[1-9][0-9]{0,18}$/.test(player.wagerCoins) ||
          typeof player.maxLossHoldCoins !== 'string' ||
          !/^[1-9][0-9]{0,19}$/.test(player.maxLossHoldCoins) ||
          typeof player.assetHoldId !== 'string' ||
          !/^[1-9][0-9]{0,19}$/.test(player.assetHoldId),
      )
    ) {
      // 十三张经典 v1 须 4 玩家（shisanshui-rules settleRound 硬校验）。
      // 房间未满员时开局不会触发（round-start 用例校验），此处防御性兜底。
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round requires 4 players for settlement');
    }

    // 3) 结算只接受可复核的权威手牌与玩家提交。缺失手牌不得降级为空牌/客户端出牌。
    const playerArrangements: PlayerArrangement[] = roundPlayers.map((rp) => {
      const snapshot = rp.submissionSnapshot;
      if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round player submission snapshot is missing or malformed');
      }
      const snapshotFields = Object.getOwnPropertyDescriptors(snapshot);
      const readSnapshotField = (key: 'heldCards' | 'arrangement'): unknown => {
        const descriptor = snapshotFields[key];
        if (descriptor === undefined || !('value' in descriptor)) {
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, `submission snapshot ${key} is missing or accessor-based`);
        }
        return descriptor.value;
      };
      const heldCards = readSnapshotField('heldCards');
      const arrangement = readSnapshotField('arrangement');
      if (
        !Array.isArray(heldCards) ||
        heldCards.length !== 13 ||
        Reflect.ownKeys(heldCards).length !== 14 ||
        Array.from({ length: 13 }, (_, index) => Object.getOwnPropertyDescriptor(heldCards, String(index))).some(
          (descriptor) => descriptor === undefined || !('value' in descriptor),
        ) ||
        heldCards.some((card) => typeof card !== 'number' || !Number.isInteger(card) || card < 0 || card >= 52) ||
        new Set(heldCards).size !== 13 ||
        arrangement === null ||
        typeof arrangement !== 'object' ||
        Array.isArray(arrangement)
      ) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'authoritative hand or arrangement snapshot is invalid');
      }
      const candidate = arrangement as Record<string, unknown>;
      const arrangementKeys = Reflect.ownKeys(candidate);
      const pileNames = ['front', 'middle', 'back'] as const;
      if (
        arrangementKeys.length !== pileNames.length ||
        arrangementKeys.some((key) => typeof key !== 'string' || !pileNames.includes(key as (typeof pileNames)[number]))
      ) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'player arrangement snapshot has unexpected properties');
      }
      const readPile = (pile: (typeof pileNames)[number], expectedLength: number): number[] => {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, pile);
        if (descriptor === undefined || !('value' in descriptor) || !Array.isArray(descriptor.value)) {
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'player arrangement pile is missing or not an array');
        }
        const values: number[] = [];
        for (let index = 0; index < expectedLength; index += 1) {
          const cardDescriptor = Object.getOwnPropertyDescriptor(descriptor.value, String(index));
          const card = cardDescriptor && 'value' in cardDescriptor ? cardDescriptor.value : undefined;
          if (typeof card !== 'number' || !Number.isInteger(card)) {
            throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'player arrangement pile contains an invalid card');
          }
          values.push(card);
        }
        if (descriptor.value.length !== expectedLength || Reflect.ownKeys(descriptor.value).length !== expectedLength + 1) {
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'player arrangement pile has invalid shape');
        }
        return values;
      };
      const front = readPile('front', 3);
      const middle = readPile('middle', 5);
      const back = readPile('back', 5);
      const validated = validateArrangement(heldCards, { front, middle, back });
      if (!validated.valid) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, `player hand/arrangement snapshot failed validation: ${validated.reason}`);
      }
      return { playerId: rp.userId, heldCards, arrangement: { front, middle, back } };
    });
    const allHeldCards = playerArrangements.flatMap((player) => player.heldCards);
    if (new Set(allHeldCards).size !== allHeldCards.length) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'authoritative hands contain duplicate cards across round players');
    }

    // 4) 读 ScoringConfig（从 round.rules_snapshot JSON 解析；首版固定 CLASSIC_V1）。
    // 注：ScoringConfig 类型来自 @gameing/shisanshui-rules，
    // rules_snapshot 由 room-create 用例从 game_config 写入（JSON 字符串），
    // 此处直接透传（决策点登记：正式配置解析需经 configuration 模块 parser）。
    const scoringConfig = round.rulesSnapshot as unknown as ScoringConfig;

    // 5) 调 ShisanshuiAdapterPort.settle（纯函数，确定性，无 IO）。
    const settlement: RoundSettlement = this.shisanshui.settle(playerArrangements, scoringConfig);
    const expectedPlayerIds = roundPlayers.map((player) => player.userId).sort();
    const resultPlayerIds = settlement.players.map((player) => player.playerId).sort();
    if (
      new Set(expectedPlayerIds).size !== expectedPlayerIds.length ||
      resultPlayerIds.length !== expectedPlayerIds.length ||
      new Set(resultPlayerIds).size !== resultPlayerIds.length ||
      resultPlayerIds.some((playerId, index) => playerId !== expectedPlayerIds[index])
    ) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement engine result players do not match round players');
    }
    const totalWater = settlement.players.reduce((sum, player) => sum + waterToBigInt(player.water), 0n);
    if (totalWater !== 0n) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement player water must conserve to zero');
    }
    for (const roundPlayer of roundPlayers) {
      const playerResult = settlement.players.find((player) => player.playerId === roundPlayer.userId)!;
      if (waterToBigInt(playerResult.water) < -BigInt(roundPlayer.maxLossHoldCoins)) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement loss exceeds player max-loss hold');
      }
    }

    // 6) settlement input hash（sha256(rules_snapshot + entries JSON）。
    const inputHash = this.computeSettlementInputHash(round, roundPlayers);
    const resultHash = resultHashOf(settlement);

    // 7) 先锁定并验证完整账户快照，验证成功后再创建 PREPARED settlement。
    const systemCoinAccount = await this.ledger.readAccount(
      this.systemIdentity.systemUserId,
      1 /* AssetType.COIN */,
      2 /* AccountType.SYSTEM */,
      tx,
    );
    if (systemCoinAccount === null) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'system coin account not provisioned');
    }

    // 收集玩家 COI 账户 + 系统 COI 账户，按 asset_account.id 数值升序锁（§4 锁顺序）。
    const playerAccounts = new Map<string, string>(); // userId → account.id
    for (const rp of roundPlayers) {
      const acct = await this.ledger.readAccount(rp.userId, 1, 1, tx);
      if (acct === null) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, `player ${rp.userId} asset account not provisioned`);
      }
      playerAccounts.set(rp.userId, acct.id);
    }
    const lockIds = [...playerAccounts.values(), systemCoinAccount.id]
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    const lockedAccounts = await this.ledger.lockAccountsByIds(lockIds, tx);
    if (lockedAccounts.length !== lockIds.length || lockedAccounts.some((account) => account == null)) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'failed to lock all settlement accounts');
    }
    const lockedById = new Map(lockedAccounts.map((account) => [account.id, account]));
    for (const [userId, accountId] of playerAccounts) {
      const account = lockedById.get(accountId);
      if (account === undefined || account.userId !== userId || account.assetType !== 1 || account.accountType !== 1) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, `locked player coin account mismatch: ${userId}`);
      }
    }
    const lockedSystem = lockedById.get(systemCoinAccount.id);
    if (
      lockedSystem === undefined ||
      lockedSystem.userId !== this.systemIdentity.systemUserId ||
      lockedSystem.assetType !== 1 ||
      lockedSystem.accountType !== 2
    ) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'locked system coin account mismatch');
    }

    // 8) 创建 settlement PREPARED 行（唯一键冲突安全返回既有结果；到此账户快照已验证）。
    const settleResult = await this.roundRepo.settleRound({
      roundId,
      settlementInputHash: inputHash,
      resultHash,
      resultSnapshot: settlement as unknown as Record<string, unknown>,
      assetOperationId: null,
      tx,
    });
    if (
      settleResult === null ||
      typeof settleResult !== 'object' ||
      Object.getPrototypeOf(settleResult) !== Object.prototype ||
      Reflect.ownKeys(settleResult).length !== 2 ||
      (settleResult.inserted !== true && settleResult.inserted !== false)
    ) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement repository returned a malformed result');
    }
    if (!settleResult.inserted) {
      const returnedRow = assertSettlementWriteResult(
        { inserted: true, settlement: settleResult.settlement },
        {
          roundId,
          inputHash,
          resultHash,
          resultSnapshot: settlement as unknown as Record<string, unknown>,
        },
      );
      const existing = await this.settlementRepo.findSettlementByRoundId(roundId, tx);
      if (
        existing === null ||
        existing.id !== returnedRow.id ||
        existing.roundId !== roundId ||
        existing.status !== SettlementStatus.PREPARED ||
        !bytesMatch(existing.inputHash, inputHash) ||
        !bytesMatch(existing.resultHash, resultHash) ||
        !bytesMatch(resultHashOf(existing.resultSnapshot), resultHash)
      ) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement replay row does not match the current settlement intent');
      }
      return this.toVerifiedReplayDto(existing, roundId, roundPlayers);
    }
    const settlementRow = assertSettlementWriteResult(settleResult, {
      roundId,
      inputHash,
      resultHash,
      resultSnapshot: settlement as unknown as Record<string, unknown>,
    });

    // 9) 资产分录（asset_operation TRANSFER=1 + 逐玩家 COI ±water / 系统 COI ∓Σwater + 占款释放）。
    // 结算操作键（幂等：`settle:{roundKey}`，U(operation_key) 兜底）。
    const opKey = `settle:${round.roundKey}`;
    const extra = {
      roundId,
      roundKey: round.roundKey,
      settle: true,
      // GAME_HOLD operation type 未注册（资产类型常量 1~14 无 GAME_HOLD），
      // 首版复用 TRANSFER=1 + extra JSON 标记 roundId（登记决策点）。
    };
    const claimed = await this.ledger.claimOperation({
      operationKey: opKey,
      operationType: WalletOperationType.TRANSFER,
      requestHash: requestHashOf(extra),
      initiatedByUserId: null, // 系统结算，无发起玩家
      extra,
      reason: `game round settlement (round ${round.roundKey})`,
      tx,
    });

    if (!claimed.inserted) {
      // 结算操作幂等命中（并发重复结算触发），跳过分录（不重复发币）。
      // 直接推进 settlement COMMITTED + round SETTLED（状态机兜底）。
      await this.settlementRepo.commitSettlement(settlementRow.id, this.clock.now(), tx);
      await this.roundRepo.markRoundSettled(roundId, tx);
      return this.toDto(settlementRow, true);
    }

    const operationId = claimed.operation.id;

    // 先验证每个 round_player 的 GAME hold 账户归属、类型及完整余额；所有校验成功前不写账。
    for (const rp of roundPlayers) {
      const hold = await this.ledger.readHoldForOperation(
        rp.assetHoldId,
        {
          accountId: playerAccounts.get(rp.userId)!,
          holdType: HoldType.GAME,
          amount: BigInt(rp.maxLossHoldCoins),
        },
        tx,
      );
      if (
        hold === null ||
        hold.assetOperationId === null ||
        hold.holdKey !== `hold:${round.roundKey}:${rp.userId}` ||
        hold.amount !== rp.maxLossHoldCoins
      ) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, `round player ${rp.userId} has an invalid game hold`);
      }
    }

    // 逐玩家分录 + 占款释放（内部转账守恒：玩家侧 Σwater = 0，系统侧 Σ(-water) = 0）。
    const intents: EntryIntent[] = [];
    for (const rp of roundPlayers) {
      const playerSettle = settlement.players.find((p: { playerId: string; water: number; foul: boolean }) => p.playerId === rp.userId);
      const water = waterToBigInt(playerSettle?.water ?? 0); // number → BigInt（wire 转换扩展点）
      const acctId = playerAccounts.get(rp.userId)!;
      const maxLossHold = BigInt(rp.maxLossHoldCoins);

      // 玩家 COI：delta = water（正 = 赢 +water / 负 = 输 -|water|），
      //           frozen_delta = -maxLossHold（释放占款，frozen 回零）。
      intents.push({
        accountId: acctId,
        delta: water,
        frozenDelta: -maxLossHold,
        entryType: WalletEntryType.INTERNAL,
        memo: `game settlement: user ${rp.userId} water ${water.toString()} (round ${round.roundKey})`,
      });

      // 释放占款（asset_hold RELEASED=4；幂等：已 RELEASED 静默返回）。
      await this.ledger.releaseHold(rp.assetHoldId, tx);

      // 回填 round_player net_coin_delta + 状态 SETTLED=3。
      await this.roundRepo.markRoundPlayerSettled(rp.id, water.toString(), tx);
      await this.ledger.consumeTurnover(rp.userId, BigInt(rp.wagerCoins), tx);
    }

    // 系统 COI：delta = -Σwater（玩家赢 → 系统付 / 玩家输 → 系统收；
    // 系统账户为资产归宿，双资产文档 §2；内部转账守恒：Σ(玩家 water) = 0
    // 时系统侧 = 0，不破坏守恒）。
    const totalPlayerWater: bigint = settlement.players.reduce(
      (sum: bigint, p: { playerId: string; water: number }) => sum + waterToBigInt(p.water),
      0n,
    );
    intents.push({
      accountId: systemCoinAccount.id,
      delta: -totalPlayerWater,
      frozenDelta: 0n,
      entryType: WalletEntryType.INTERNAL,
      memo: `game settlement: system side -Σwater ${(-totalPlayerWater).toString()} (round ${round.roundKey})`,
    });

    const posts = await this.ledger.postEntries(operationId, intents, tx);
    // 守恒校验：内部转账玩家侧 + 系统侧净额 = 0（系统金币发行余额可为负，
    // 玩家资产不可透支；守恒边界分开核对，双资产文档 §2）。
    assertConservation(posts, 0n);

    // 快照回填 + outbox 同事务（§6.3 "所有分录/outbox 同事务"）。
    const committedAt = this.clock.now();
    await this.ledger.setCommitted(
      operationId,
      committedAt,
      {
        roundId,
        roundKey: round.roundKey,
        water: settlement.players.map((p: { playerId: string; water: number; foul: boolean }) => ({
          playerId: p.playerId,
          water: waterToBigInt(p.water).toString(),
        })),
      },
      tx,
    );

    // 9) settlement COMMITTED=2 + round SETTLED=4 + round_event SETTLE=4（同事务）。
    await this.settlementRepo.commitSettlement(settlementRow.id, committedAt, tx);
    await this.roundRepo.markRoundSettled(roundId, tx);
    await this.roundEventRepo.appendRoundEvent({
      roundId,
      roundPlayerId: null,
      seq: '3',
      eventKey: `ev:settle:${round.roundKey}`,
      eventType: RoundEventType.SETTLE,
      fencingToken: round.fencingToken,
      payloadCiphertext: resultHash, // 首版占位：用结算哈希代替密文（加密层待闭环，决策点登记）
      tx,
    });

    // 10) outbox 事件（topic 'game.round.settled'；worker 落地后投递 /room/:roomId）。
    await this.outbox.append({
      topic: 'game.round.settled',
      assetOperationId: operationId,
      payload: {
        roundId,
        roundKey: round.roundKey,
        settlementId: settlementRow.id,
        operationId,
      },
    });

    return this.toDto(settlementRow, false);
  }

  private computeSettlementInputHash(
    round: Pick<RoundModel, 'rulesSnapshot'>,
    roundPlayers: Array<{ submissionSnapshot?: Record<string, unknown> | null }>,
  ): Uint8Array {
    const entries = roundPlayers.map((player) => player.submissionSnapshot ?? {});
    return settlementInputHashOf(round.rulesSnapshot, entries);
  }

  private assertAuthoritativeSettledSnapshots(roundPlayers: SettlementRoundPlayer[]): void {
    const allHeldCards: number[] = [];
    for (const player of roundPlayers) {
      const snapshot = player.submissionSnapshot;
      if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settled round-player submission snapshot is malformed');
      }
      const fields = Object.getOwnPropertyDescriptors(snapshot);
      const heldCardsDescriptor = fields.heldCards;
      const arrangementDescriptor = fields.arrangement;
      if (
        !heldCardsDescriptor || !('value' in heldCardsDescriptor) ||
        !arrangementDescriptor || !('value' in arrangementDescriptor) ||
        !Array.isArray(heldCardsDescriptor.value) || heldCardsDescriptor.value.length !== 13 ||
        Reflect.ownKeys(heldCardsDescriptor.value).length !== 14 ||
        heldCardsDescriptor.value.some((card) => typeof card !== 'number' || !Number.isInteger(card) || card < 0 || card >= 52) ||
        new Set(heldCardsDescriptor.value).size !== 13
      ) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settled authoritative hand snapshot is invalid');
      }
      const arrangement = arrangementDescriptor.value;
      if (arrangement === null || typeof arrangement !== 'object' || Array.isArray(arrangement)) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settled arrangement snapshot is invalid');
      }
      const candidate = arrangement as Record<string, unknown>;
      if (Reflect.ownKeys(candidate).length !== 3 || !['front', 'middle', 'back'].every((key) => Object.hasOwn(candidate, key))) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settled arrangement snapshot has invalid shape');
      }
      const readPile = (key: 'front' | 'middle' | 'back', length: number): number[] => {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor || !('value' in descriptor) || !Array.isArray(descriptor.value) || descriptor.value.length !== length || Reflect.ownKeys(descriptor.value).length !== length + 1) {
          throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settled arrangement pile is invalid');
        }
        const cards: number[] = [];
        for (let i = 0; i < length; i += 1) {
          const cardDescriptor = Object.getOwnPropertyDescriptor(descriptor.value, String(i));
          if (!cardDescriptor || !('value' in cardDescriptor) || typeof cardDescriptor.value !== 'number' || !Number.isInteger(cardDescriptor.value)) {
            throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settled arrangement card is invalid');
          }
          cards.push(cardDescriptor.value);
        }
        return cards;
      };
      const validation = validateArrangement(heldCardsDescriptor.value, {
        front: readPile('front', 3),
        middle: readPile('middle', 5),
        back: readPile('back', 5),
      });
      if (!validation.valid) throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settled hand arrangement failed validation');
      allHeldCards.push(...heldCardsDescriptor.value);
    }
    if (new Set(allHeldCards).size !== allHeldCards.length) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settled authoritative hands contain duplicate cards');
    }
  }

  private toVerifiedReplayDto(
    settlement: SettlementModel,
    roundId: string,
    roundPlayers: Array<{ userId: string; status: number }>,
    settledRound = false,
    expectedInputHash?: Uint8Array,
  ): RoundSettlementDto {
    if (
      settlement.roundId !== roundId ||
      (settledRound && settlement.status !== SettlementStatus.COMMITTED) ||
      !isByteHash(settlement.resultHash) ||
      !isByteHash(settlement.inputHash) ||
      (expectedInputHash !== undefined && !bytesMatch(settlement.inputHash, expectedInputHash)) ||
      !bytesMatch(resultHashOf(settlement.resultSnapshot), settlement.resultHash)
    ) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement row belongs to a different round or has an invalid hash binding');
    }
    const result = this.toDto(settlement, true);
    const expectedPlayerIds = roundPlayers.map((player) => player.userId).sort();
    const resultPlayerIds = result.players.map((player) => player.userId).sort();
    if (
      expectedPlayerIds.length !== 4 ||
      roundPlayers.some((player) =>
        settledRound
          ? player.status !== RoundPlayerStatus.SETTLED
          : player.status !== RoundPlayerStatus.SETTLED && player.status !== RoundPlayerStatus.SUBMITTED,
      ) ||
      new Set(expectedPlayerIds).size !== expectedPlayerIds.length ||
      resultPlayerIds.length !== expectedPlayerIds.length ||
      new Set(resultPlayerIds).size !== resultPlayerIds.length ||
      resultPlayerIds.some((playerId, index) => playerId !== expectedPlayerIds[index])
    ) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement result players do not match round players');
    }
    if (result.players.reduce((sum, player) => sum + BigInt(player.water), 0n) !== 0n) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'persisted settlement player water does not conserve to zero');
    }
    return result;
  }

  /** settlement 行 → wire DTO（金额/ID 十进制字符串；幂等重放 = 同一结果）。 */
  private toDto(settlement: SettlementModel, replay: boolean): RoundSettlementDto {
    const snapshot: unknown = settlement.resultSnapshot;
    if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray((snapshot as Record<string, unknown>).players)) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement result snapshot is malformed');
    }
    const playersRaw: unknown[] = (snapshot as { players: unknown[] }).players;
    if (playersRaw.length === 0 || playersRaw.length > 4) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement result snapshot has invalid player count');
    }
    const players = playersRaw.map((player) => {
      if (
        player === null ||
        typeof player !== 'object' ||
        !('playerId' in player) ||
        typeof player.playerId !== 'string' ||
        !/^[1-9][0-9]{0,19}$/.test(player.playerId) ||
        !('water' in player) ||
        typeof player.water !== 'number' ||
        !Number.isSafeInteger(player.water) ||
        !('foul' in player) ||
        typeof player.foul !== 'boolean'
      ) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement result player is malformed');
      }
      return {
        userId: player.playerId,
        water: waterToBigInt(player.water).toString(),
        foul: player.foul,
      };
    });
    return { roundId: settlement.roundId, settlementId: settlement.id, players, replay };
  }
}
