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
import type { Clock } from '../../wallet/ports/clock.js';
import { CoinMarketDomainError, CM } from '../domain/errors.js';
import { priceQuote, PAYMENT_DEADLINE_SECONDS } from '../domain/listing-rules.js';

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
    private readonly clock: Clock,
  ) {}

  /**
   * POST /me/coin-market/trades：成交创建（201 新创建 / 200 幂等重放）。
   */
  async create(input: TradeCreateInput): Promise<TradeCreatedDto> {
    const { buyerUserId, tradeKey, coins, paymentMethod, tx } = input;

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
      sellerNetCents: priceQuoteResult.sellerNetCents,
      paymentMethod,
      tx,
    });

    const trade = result.trade;
    const deadlineAt =
      trade.paymentDeadlineAt !== null
        ? toIso(trade.paymentDeadlineAt)
        : new Date(Date.now() + PAYMENT_DEADLINE_SECONDS * 1000).toISOString();

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
