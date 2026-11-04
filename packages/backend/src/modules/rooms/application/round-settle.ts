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
 * - fencing token 校验（旧 token → FENCING_CONFLICT 拒绝）；
 * - 调 ShisanshuiAdapterPort.settle（本地包纯函数，确定性，无 IO；
 *   输入 4 个 PlayerArrangement + ScoringConfig，输出 RoundSettlement）；
 * - settlement input hash 计算（sha256(rules_snapshot + entries JSON)，
 *   round.settlement_input_hash BINARY(32) 不可变结算意图摘要）；
 * - settlement PREPARED=1 行创建（U(round_id) 唯一约束幂等兜底，
 *   命中 → 返回既有 settlement，不重复发币——验收红线"结算一次"）；
 * - asset_operation TRANSFER=1 三分录（每玩家 COI ±water / 系统 COI ∓Σwater，
 *   内部转账守恒；占款释放：asset_hold RELEASED=4，frozen_delta -maxLossHoldCoins）；
 * - settlement COMMITTED=2 + round SETTLED=4 + round_player SETTLED=3
 *   + round_event SETTLE=4 + outbox(topic 'game.round.settled')，同事务；
 * - 锁顺序：round → round_player → settlement → asset_account.id 升序（SDD §4）。
 *
 * 结算分录（TRANSFER=1 三分录，extra JSON 标记 roundId）：
 * 对每个玩家（water = 净输赢，正 = 赢 / 负 = 输）：
 * - 玩家 COI：delta = water（有符号），frozen_delta = -maxLossHoldCoins（释放占款）；
 * - 系统 COI：delta = -water（玩家赢 → 系统付；玩家输 → 系统收，
 *   系统账户为资产归宿，双资产文档 §2）；
 * - asset_hold：RELEASED=4，remaining → 0（经 AssetLedger.releaseHold）。
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
 * - `FENCING_CONFLICT`：携带的 fencing_token 与 round 当前值不一致。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 账户未开户 / 乐观 version 冲突（可重试）。
 * - 成功 → RoundSettlementDto（200；重放 = 200 语义，不重复发币，登记决策点）。
 */

import type { SettlementModel } from '../../../infrastructure/database/models/game.js';
import { RoundStatus, RoundEventType } from '../../../infrastructure/database/models/game.js';
import { RoomDomainError, R } from '../domain/errors.js';
import { settlementInputHashOf, resultHashOf, waterToBigInt } from '../domain/round-rules.js';
import type { RoundRepo, RoundEventRepo, SettlementRepo, Tx } from '../ports/rooms-repository.js';
import type { ShisanshuiAdapterPort } from '../ports/shisanshui-adapter.js';
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
    roundId: string;
    fencingToken: string;
    /** 各玩家出牌安排（handler 从 round_player.submission_snapshot 读取，
     *  由路由层组装后传入；首版由用例内部读 round_player 行组装）。 */
    tx: Tx;
  }): Promise<RoundSettlementDto> {
    const { roundId, fencingToken, tx } = input;

    // 1) 锁读 round（行锁；fencing 校验前置）。
    const round = await this.roundRepo.lockRound(roundId, tx);
    if (round === null) {
      throw new RoomDomainError(R.ROUND_NOT_FOUND, 'round not found');
    }
    // 幂等重放：已 SETTLED=4 → 返回既有 settlement（不重复发币，验收红线）。
    if (round.status === RoundStatus.SETTLED) {
      const existing = await this.settlementRepo.findSettlementByRoundId(roundId, tx);
      if (existing === null) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settled round without settlement row');
      }
      return this.toDto(existing, true);
    }
    // 非 SETTLING=3 拒绝结算（PREPARING/ACTIVE/CANCELLED/RECOVERING 均不可结算）。
    if (round.status !== RoundStatus.SETTLING) {
      throw new RoomDomainError(R.ROUND_NOT_ACTIVE, 'round not in settleable state');
    }
    // fencing token 校验（旧 token → FENCING_CONFLICT 拒绝）。
    if (round.fencingToken !== fencingToken) {
      throw new RoomDomainError(R.FENCING_CONFLICT, 'fencing token mismatch');
    }

    // 2) 读 round_player 全量（按 seat_no 升序；组装 PlayerArrangement 输入）。
    const roundPlayers = await this.roundRepo.listRoundPlayers(roundId, tx);
    if (roundPlayers.length !== 4) {
      // 十三张经典 v1 须 4 玩家（shisanshui-rules settleRound 硬校验）。
      // 房间未满员时开局不会触发（round-start 用例校验），此处防御性兜底。
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round requires 4 players for settlement');
    }

    // 3) 组装 PlayerArrangement[]（playerId = user.id 十进制字符串；
    //    heldCards / arrangement 从 submission_snapshot JSON 读取）。
    const playerArrangements: PlayerArrangement[] = roundPlayers.map((rp) => {
      const snapshot = rp.submissionSnapshot as Record<string, unknown> | null;
      const arrangement = (snapshot?.arrangement as Record<string, unknown> | undefined) ?? {};
      // 首版占位：heldCards 从 playerStateCiphertext 解密（加密层待闭环，决策点登记）；
      // 此处从 submission_snapshot 读取（明文快照，handler 写入时同步登记）。
      const heldCards = (snapshot?.heldCards as number[] | undefined) ?? [];
      return {
        playerId: rp.userId,
        heldCards,
        arrangement: {
          front: (arrangement.front as number[] | undefined) ?? [],
          middle: (arrangement.middle as number[] | undefined) ?? [],
          back: (arrangement.back as number[] | undefined) ?? [],
        },
      } as PlayerArrangement;
    });

    // 4) 读 ScoringConfig（从 round.rules_snapshot JSON 解析；首版固定 CLASSIC_V1）。
    // 注：ScoringConfig 类型来自 @gameing/shisanshui-rules，
    // rules_snapshot 由 room-create 用例从 game_config 写入（JSON 字符串），
    // 此处直接透传（决策点登记：正式配置解析需经 configuration 模块 parser）。
    const scoringConfig = round.rulesSnapshot as unknown as ScoringConfig;

    // 5) 调 ShisanshuiAdapterPort.settle（纯函数，确定性，无 IO）。
    const settlement: RoundSettlement = this.shisanshui.settle(playerArrangements, scoringConfig);

    // 6) settlement input hash（sha256(rules_snapshot + entries JSON)）。
    const entries = roundPlayers.map((rp) => (rp.submissionSnapshot as Record<string, unknown> | null) ?? {});
    const inputHash = settlementInputHashOf(round.rulesSnapshot, entries);
    const resultHash = resultHashOf(settlement);

    // 7) 创建 settlement PREPARED=1 行（U(round_id) 唯一约束幂等兜底；
    //    命中 → 幂等返回既有行，不重复发币——验收红线）。
    const settleResult = await this.roundRepo.settleRound({
      roundId,
      settlementInputHash: inputHash,
      resultHash,
      resultSnapshot: settlement as unknown as Record<string, unknown>,
      assetOperationId: null, // 占位：结算操作 id 在 claimOperation 后回填（同事务）
      tx,
    });

    if (!settleResult.inserted) {
      // 幂等重放：settlement U(round_id) 命中，返回既有结果（不重复发币）。
      const existing = await this.settlementRepo.findSettlementByRoundId(roundId, tx);
      if (existing === null) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'settlement row missing on replay');
      }
      return this.toDto(existing, true);
    }

    const settlementRow = settleResult.settlement;

    // 8) 资产分录（asset_operation TRANSFER=1 + 逐玩家 COI ±water /
    //    系统 COI ∓Σwater + 占款释放，同事务）。
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
    await this.ledger.lockAccountsByIds(lockIds, tx);

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

  /** settlement 行 → wire DTO（金额/ID 十进制字符串；幂等重放 = 同一结果）。 */
  private toDto(settlement: SettlementModel, replay: boolean): RoundSettlementDto {
    const snapshot = settlement.resultSnapshot as Record<string, unknown>;
    const playersRaw = (snapshot.players as Array<{ playerId: string; water: number; foul: boolean }> | undefined) ?? [];
    return {
      roundId: settlement.roundId,
      settlementId: settlement.id,
      players: playersRaw.map((p) => ({
        userId: p.playerId,
        water: waterToBigInt(p.water).toString(),
        foul: p.foul,
      })),
      replay,
    };
  }
}
