/**
 * coin-market 模块用例：成交创建 + 卖家确认 + 买家放币（POST /me/coin-market/trades
 * + POST /me/coin-market/trades/:id/confirm + POST /me/coin-market/trades/:id/release，
 * 首版玩家侧路径；11 态 DDL 权威状态机）。
 *
 * 领域所有者：coin-market 模块（coin_market_trade 写 + 同事务 coin_market_listing
 * 守恒变更（reserved ↔ available / filled）；asset_hold 释放经 walletModule.ledger，
 * 不直接查表；SDD §5.13 "所有分录 / outbox 同事务"）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 coin_market_listing → coin_market_trade
 * → asset_hold，幂等先抢唯一约束）、§9 第 7 步（金币集市集市成交 / 确认 / 放币）、
 * §5.13（coin_market_trade 11 态状态机 DDL 权威 + U(trade_key) / U(chain_tx_id) /
 * U(asset_operation_id) 幂等）；docs/04_domains/双资产充值兑换与提现.md §4
 * （成交出账，seller 确认收款后 reserved → filled，buyer 放币经
 * wallet ledger 扩展点登记）。
 *
 * 用例语义：
 * - `create`：买家对挂牌一笔部分成交（锁读 listing availableCoins + 预占
 *   reserved += coins + trade PAYMENT_PENDING=1 + payment_deadline_at = now +
 *   PAYMENT_DEADLINE_SECONDS，U(trade_key) 幂等兜底——命中 → 返回既有
 *   trade 行 `isNew: false`，不产生第二笔，验收红线"成交幂等"）；
 * - `confirmPayment`：卖家确认收款（PAYMENT_PENDING=1 → SELLER_CONFIRMATION_PENDING=2，
 *   同事务 listing reserved → filled 守恒变更；首版登记 payment_proof 校验
 *   未闭环——"确认支付成功才将占款转为完成扣款"经 wallet ledger
 *   COIN_MARKET_TRADE=13 分录同事务，本用例只推进 trade 状态 + listing
 *   守恒变更，出账 / 放币经 wallet ledger 扩展点登记）；
 * - `releaseToBuyer`：买家确认放币（SELLER_CONFIRMATION_PENDING=2 → RELEASED=7，
 *   幂等重放：已 RELEASED → 静默返回既有值 200；首版登记放币出账经
 *   wallet ledger COIN_MARKET_RELEASE=14 分录同事务，worker 未建，
 *   登记 §6.3 管线扩展点）。
 *
 * 错误码映射（CM → 触发条件）：
 * - `LISTING_NOT_FOUND` / `TRADE_NOT_FOUND`：行缺失（404 语义）。
 * - `COINS_INSUFFICIENT`：预占金币数量超过挂牌可成交量（400 语义）。
 * - `TRADE_NOT_ALLOWED`：状态机转换前置校验失败（409 语义）。
 * - `IDEMPOTENCY_KEY_REUSED`：U(trade_key) 命中但内容不同（409 语义）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 守恒破坏 / 状态机影响行数 0
 *   （可重试，503 语义）。
 *
 * 金额 BigInt 全链路：`coins` / `grossCents` / `sellerNetCents` BigInt，
 * wire 十进制字符串（row-mapper 完成跨层格式化，本用例出入参已是字符串
 * 业务单位，SDD §2 第 2 条）。
 */

import type { TradeRepo, ListingRepo, Tx } from '../ports/coin-market-repository.js';
import type { AssetLedger, EntryIntent } from '../../wallet/ports/wallet-repository.js';
import { WalletEntryType, WalletOperationType } from '../../wallet/ports/wallet-repository.js';
import { AccountType, AssetType, HoldType } from '../../../infrastructure/database/models/wallet.js';
import { requestHashOf } from '../../wallet/domain/ledger-rules.js';
import type { Clock } from '../../wallet/ports/clock.js';
import { CoinMarketDomainError, CM } from '../domain/errors.js';
import { priceQuote, PAYMENT_DEADLINE_SECONDS, CoinMarketTradeStatus11 } from '../domain/listing-rules.js';

/** 成交创建入参（路由层经 contracts CoinMarketTradeCreateRequestDto 校验后传入）。 */
export interface TradeCreateInput {
  buyerUserId: string;
  listingId: string;
  tradeKey: string;
  coins: string;
  paymentMethod: number;
  tx: Tx;
}

export interface TradeCreatedDto {
  tradeId: string;
  tradeKey: string;
  coins: string;
  grossCents: string;
  sellerNetCents: string;
  status: number;
  paymentDeadlineAt: string;
  isNew: boolean;
}

export interface TradeConfirmedDto {
  tradeId: string;
  status: number;
  confirmedAt: string;
  inserted: boolean;
}

export interface TradeReleasedDto {
  tradeId: string;
  status: number;
  releasedAt: string;
  inserted: boolean;
}

export interface TradeReleaseInput {
  tradeId: string;
  actorUserId: string;
  tx: Tx;
}

/**
 * 成交流程用例（构造注入 TradeRepo + ListingRepo + Clock，不用全局，
 * SDD §4；11 态状态机前置校验经 `canPlayerTriggerTransition`，本用例只做
 * 落库 + 同事务 listing 守恒变更，asset_hold 释放经 wallet ledger
 * 扩展点登记，首版不直接调用）。
 */
export class TradeUseCase {
  constructor(
    private readonly tradeRepo: TradeRepo,
    private readonly listingRepo: ListingRepo,
    private readonly ledger: AssetLedger,
    private readonly clock: Clock,
  ) {}

  /**
   * POST /me/coin-market/trades：成交创建（201 新创建 / 200 幂等重放）。
   */
  async releaseToBuyer(input: TradeReleaseInput): Promise<TradeReleasedDto> {
    const transaction = input.tx.transaction as { finished?: string | undefined } | null | undefined;
    if (transaction == null || transaction.finished != null) {
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '成交放币资金处理必须在活动事务中运行。', { retryable: true });
    }
    const tradeRef = await this.tradeRepo.getTrade(input.tradeId, input.tx);
    if (tradeRef === null) throw new CoinMarketDomainError(CM.TRADE_NOT_FOUND, `交易不存在：${input.tradeId}`);
    const listing = await this.listingRepo.lockListing(tradeRef.coinMarketListingId, input.tx);
    if (listing === null) throw new CoinMarketDomainError(CM.LISTING_NOT_FOUND, `挂牌不存在：${tradeRef.coinMarketListingId}`);
    const trade = await this.tradeRepo.lockTrade(input.tradeId, input.tx);
    if (trade === null) throw new CoinMarketDomainError(CM.TRADE_NOT_FOUND, `交易不存在：${input.tradeId}`);
    if (trade.status === CoinMarketTradeStatus11.RELEASED || trade.status === CoinMarketTradeStatus11.AUTO_RELEASED) {
      if (input.actorUserId !== trade.buyerUserId) {
        throw new CoinMarketDomainError(CM.TRADE_NOT_ALLOWED, '只有买家可确认放币。', { retryable: false });
      }
      const replay = await this.ledger.claimOperation({
        operationKey: `coin-market:trade:${trade.id}:release`,
        operationType: WalletOperationType.COIN_MARKET_TRADE,
        requestHash: requestHashOf({
          tradeId: trade.id,
          listingId: listing.id,
          buyerUserId: trade.buyerUserId,
          sellerUserId: listing.sellerUserId,
          coins: trade.coins,
        }),
        initiatedByUserId: input.actorUserId,
        extra: { tradeId: trade.id, outcome: 'RELEASED' },
        reason: 'coin-market release replay',
        tx: input.tx,
      });
      if (replay.inserted) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '放币状态缺少原账务操作。', { retryable: true });
      const snapshot = await this.ledger.getOperationResultSnapshot(replay.operation.id, input.tx);
      if (snapshot === null) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '放币幂等操作缺少结果快照。', { retryable: true });
      const result = snapshot as unknown as TradeReleasedDto;
      if (result.tradeId !== trade.id || result.status !== trade.status || typeof result.releasedAt !== 'string') {
        throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '放币幂等快照与终态交易不一致。', { retryable: true });
      }
      return { ...result, inserted: false };
    }
    if (trade.status !== CoinMarketTradeStatus11.SELLER_CONFIRMATION_PENDING) {
      throw new CoinMarketDomainError(CM.TRADE_NOT_ALLOWED, `交易状态不可放币（status=${trade.status}）。`, { retryable: false });
    }
    if (String(input.actorUserId) !== String(trade.buyerUserId)) {
      throw new CoinMarketDomainError(CM.TRADE_NOT_ALLOWED, '只有买家可确认放币。', { retryable: false });
    }
    const sellerAccount = await this.ledger.readAccount(listing.sellerUserId, AssetType.COIN, AccountType.PLAYER, input.tx);
    if (sellerAccount === null) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '挂牌卖家金币账户缺失。');
    const buyerAccount = await this.ledger.readAccount(trade.buyerUserId, AssetType.COIN, AccountType.PLAYER, input.tx);
    if (sellerAccount === null || buyerAccount === null) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '交易双方金币账户缺失。');
    const amount = BigInt(trade.coins);
    const now = await this.clock.now();
    const claimed = await this.ledger.claimOperation({
      operationKey: `coin-market:trade:${trade.id}:release`,
      operationType: WalletOperationType.COIN_MARKET_TRADE,
      requestHash: requestHashOf({
        tradeId: trade.id,
        listingId: listing.id,
        buyerUserId: trade.buyerUserId,
        sellerUserId: listing.sellerUserId,
        coins: trade.coins,
      }),
      initiatedByUserId: input.actorUserId,
      extra: {
        tradeId: trade.id,
        listingId: listing.id,
        buyerUserId: trade.buyerUserId,
        sellerUserId: listing.sellerUserId,
        coins: trade.coins,
      },
      reason: 'coin-market confirmed payment; release coins to buyer',
      tx: input.tx,
    });
    if (!claimed.inserted) {
      const current = await this.tradeRepo.getTrade(trade.id, input.tx);
      if (current?.status !== CoinMarketTradeStatus11.RELEASED && current?.status !== CoinMarketTradeStatus11.AUTO_RELEASED) {
        throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '放币账务操作与交易状态不一致。', { retryable: true });
      }
      const snapshot = await this.ledger.getOperationResultSnapshot(claimed.operation.id, input.tx);
      if (snapshot === null) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '放币幂等操作缺少结果快照。', { retryable: true });
      return { ...(snapshot as unknown as TradeReleasedDto), inserted: false };
    }
    const intents: EntryIntent[] = [
      {
        accountId: sellerAccount.id,
        delta: -amount,
        frozenDelta: -amount,
        entryType: WalletEntryType.HOLD,
        assetHoldId: listing.assetHoldId,
        memo: `coin-market settlement to buyer ${trade.buyerUserId}: ${amount} coins`,
      },
      {
        accountId: buyerAccount.id,
        delta: amount,
        frozenDelta: 0n,
        entryType: WalletEntryType.INTERNAL,
        memo: `coin-market settlement from seller ${listing.sellerUserId}: ${amount} coins`,
      },
    ];
    const consumeResult = await this.ledger.consumeHoldAmount(
      { operationId: claimed.operation.id, holdId: listing.assetHoldId, amount, intents },
      input.tx,
    );
    if (consumeResult.hold.assetAccountId !== sellerAccount.id || consumeResult.hold.holdType !== HoldType.COIN_MARKET_LISTING) {
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '挂牌占款账户或类型与成交不一致。', { retryable: true });
    }
    const result = await this.tradeRepo.releaseToBuyer({ tradeId: trade.id, releasedAt: now, tx: input.tx });
    if (result === null) throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '放币状态转换失败。', { retryable: true });
    const dto = { tradeId: trade.id, status: result.status, releasedAt: toIso(now), inserted: true };
    await this.ledger.setCommitted(claimed.operation.id, now, { ...dto }, input.tx);
    return dto;
  }

  async create(input: TradeCreateInput): Promise<TradeCreatedDto> {
    const { buyerUserId, tradeKey, coins, paymentMethod, tx } = input;
    const transaction = tx.transaction as { finished?: string | undefined } | null | undefined;
    if (transaction == null || transaction.finished != null) {
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '成交创建必须在活动事务中运行。', { retryable: true });
    }
    const requestAt = await this.clock.now();

    // 1. 报价（BigInt 整除，向下取整；登记舍入决策点）
    const coinsB = BigInt(coins);
    if (coinsB <= 0n) {
      throw new CoinMarketDomainError(CM.COINS_INSUFFICIENT, '成交金币数量须为正整数。', {
        retryable: false,
      });
    }

    // 2. 读 listing 行取 sellerUserId + priceCentsPer1000Coins（报价经 listing
    //    行报价，不经 '1000' 兜底；登记决策点：首版报价经 listing 行读回）
    const listing = await this.listingRepo.lockListing(input.listingId, input.tx);
    if (listing === null) {
      throw new CoinMarketDomainError(CM.LISTING_NOT_FOUND, `挂牌不存在：${input.listingId}`);
    }
    const priceQuoteResult = priceQuote(input.coins, listing.priceCentsPer1000Coins);
    if (priceQuoteResult === null) {
      throw new CoinMarketDomainError(CM.AMOUNT_MISMATCH, '报价计算失败（入参非法）。', {
        retryable: false,
      });
    }

    // 3. 写交易行（U(trade_key) 幂等兜底 + 同事务 listing 预占）
    const result = await this.tradeRepo.createTrade({
      listingId: input.listingId,
      buyerUserId,
      sellerUserId: listing.sellerUserId,
      tradeKey,
      coins,
      grossCents: priceQuoteResult.grossCents,
      // DDL requires seller_net_cents = 0 for direct external payments; no platform
      // wallet settlement occurs on this mode, even though gross is quoted for display.
      sellerNetCents: paymentMethod === 2 ? priceQuoteResult.sellerNetCents : '0',
      paymentMethod,
      paymentDeadlineAt: new Date(requestAt.getTime() + PAYMENT_DEADLINE_SECONDS * 1000),
      tx,
    });

    const trade = result.trade;
    if (
      !result.isNew &&
      (String(trade.coinMarketListingId) !== String(input.listingId) ||
        String(trade.buyerUserId) !== String(buyerUserId) ||
        trade.coins !== coins ||
        trade.paymentMode !== paymentMethod ||
        trade.grossCents !== priceQuoteResult.grossCents ||
        trade.sellerNetCents !== (paymentMethod === 2 ? priceQuoteResult.sellerNetCents : '0'))
    ) {
      throw new CoinMarketDomainError(CM.IDEMPOTENCY_KEY_REUSED, '成交幂等键已被不同请求使用。', { retryable: false });
    }
    if (trade.paymentDeadlineAt === null) {
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '成交行缺少付款截止时间。', { retryable: true });
    }
    const deadlineAt = toIso(trade.paymentDeadlineAt);

    return {
      tradeId: trade.id,
      tradeKey,
      coins: trade.coins,
      grossCents: trade.grossCents,
      sellerNetCents: trade.sellerNetCents,
      status: trade.status,
      paymentDeadlineAt: deadlineAt,
      isNew: result.isNew,
    };
  }
}

function toIso(d: Date | string | null): string {
  if (d === null) return new Date().toISOString();
  return typeof d === 'string' ? d : d.toISOString();
}
