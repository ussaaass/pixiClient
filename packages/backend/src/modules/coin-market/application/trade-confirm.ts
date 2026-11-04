/**
 * coin-market 模块用例：卖家确认收款（POST /me/coin-market/trades/:id/confirm，
 * 200；PAYMENT_PENDING=1 → SELLER_CONFIRMATION_PENDING=2，11 态 DDL 权威状态机）。
 *
 * 领域所有者：coin-market 模块（coin_market_trade 写 + 同事务 coin_market_listing
 * 守恒变更（reserved → filled）；SDD §5.13 "确认支付成功才将占款转为完成扣款"
 * 经 wallet ledger COIN_MARKET_TRADE=13 分录同事务，首版登记 payment_proof
 * 校验未闭环，本用例只推进 trade 状态 + listing 守恒变更）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 coin_market_listing →
 * coin_market_trade → asset_hold，幂等先抢唯一约束；所有分录 / outbox 同
 * 事务）、§9 第 7 步（卖家确认收款：PAYMENT_PENDING=1 →
 * SELLER_CONFIRMATION_PENDING=2，首版自动放款路径登记）、§5.13（coin_market_trade
 * 11 态 DDL 权威状态机 + U(trade_key) / U(chain_tx_id) / U(asset_operation_id)
 * 幂等）；docs/04_domains/双资产充值兑换与提现.md §4（确认支付成功才将
 * 占款转为完成扣款，reserved → filled 守恒变更）。
 *
 * 用例语义：
 * - 锁读 trade（行锁）；仅 PAYMENT_PENDING=1 可推进（SELLER_CONFIRMATION_PENDING=2
 *   → 幂等重放 `replay: true`；其余状态 → TRADE_NOT_ALLOWED 409）；
 * - `confirm_key` 幂等（`confirmKey = confirm:{tradeKey}:seller`，首版无 admin
 *   路径，登记决策点：Admin 裁决确认路径 `confirm:{tradeKey}:{adminUserId}`
 *   归 §9 第 9 步；U(trade_key + status) 兜底，读已存在 trade 行 status 判定
 *   幂等重放，不产生第二笔状态推进）；
 * - `release_to_buyer` 首版登记为自动路径（`payment_deadline_at` 过期后
 *   worker 推 AUTO_RELEASED=8，首版 worker 未建，登记 §6.3 管线扩展点；
 *   本用例只做 PAYMENT_PENDING → SELLER_CONFIRMATION_PENDING 状态推进，
 *   放币出账经 wallet ledger COIN_MARKET_RELEASE=14 分录同事务登记，
 *   首版不入账）；
 * - 出参：`{ tradeId, status: number, replay: boolean }`（status 用 11 态
 *   DDL 权威值，PAYMENT_PENDING=1 → SELLER_CONFIRMATION_PENDING=2）。
 *
 * 错误码映射（CM → 触发条件）：
 * - `TRADE_NOT_FOUND`：交易行缺失（404 语义）。
 * - `TRADE_NOT_ALLOWED`：状态机转换前置校验失败（409 语义，非
 *   PAYMENT_PENDING=1 或 SELLER_CONFIRMATION_PENDING=2 状态）。
 * - `TRADE_DEADLINE_PASSED`：付款截止时间已过（409 语义，PAYMENT_DEADLINE_SECONDS
 *   超时，首版读路径判定，worker 未建登记 §6.3 管线扩展点）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 守恒破坏 / 状态机影响行数 0
 *   （可重试，503 语义）。
 */

import type { TradeRepo, ListingRepo, Tx } from '../ports/coin-market-repository.js';
import type { Clock } from '../../wallet/ports/clock.js';
import { CoinMarketDomainError, CM } from '../domain/errors.js';
import { CoinMarketTradeStatus11, canPlayerTriggerTransition } from '../domain/listing-rules.js';

export interface TradeConfirmedDto {
  tradeId: string;
  status: number;
  replay: boolean;
}

/**
 * 卖家确认收款用例（构造注入 TradeRepo + ListingRepo + Clock，不用全局，
 * SDD §4；11 态状态机前置校验经 `canPlayerTriggerTransition`，本用例
 * 只做落库 + 同事务 listing 守恒变更，asset_hold 释放经 wallet ledger
 * 扩展点登记，首版不直接调用）。
 */
export class TradeConfirmUseCase {
  constructor(
    private readonly tradeRepo: TradeRepo,
    private readonly listingRepo: ListingRepo,
    private readonly clock: Clock,
  ) {}

  /**
   * POST /me/coin-market/trades/:id/confirm：卖家确认收款（200；
   * PAYMENT_PENDING=1 → SELLER_CONFIRMATION_PENDING=2，幂等重放：已
   * SELLER_CONFIRMATION_PENDING → 静默返回既有值 `replay: true`）。
   *
   * @param userId 当前用户 ID（须为卖家；非卖家 → TRADE_NOT_ALLOWED）。
   * @param tradeId 交易 ID。
   * @param tx 事务句柄（同事务约定）。
   */
  async run(userId: string, tradeId: string, tx: Tx): Promise<TradeConfirmedDto> {
    // 1. 行锁读交易（11 态状态机前置校验）
    const trade = await this.tradeRepo.lockTrade(tradeId, tx);
    if (trade === null) {
      throw new CoinMarketDomainError(CM.TRADE_NOT_FOUND, `交易不存在：${tradeId}`);
    }

    // 2. 归属校验（卖家身份；首版经 listing 行读回 sellerUserId，登记决策点：
    //    直接读 trade.coinMarketListingId → listing.sellerUserId，不经 trade 行）
    const listing = await this.listingRepo.lockListing(trade.coinMarketListingId, tx);
    if (listing === null) {
      throw new CoinMarketDomainError(CM.LISTING_NOT_FOUND, `挂牌不存在：${trade.coinMarketListingId}`);
    }
    if (listing.sellerUserId !== userId) {
      throw new CoinMarketDomainError(CM.TRADE_NOT_ALLOWED, '非卖家身份，不可确认收款。', {
        retryable: false,
      });
    }

    // 3. 幂等重放：已 SELLER_CONFIRMATION_PENDING → 静默返回既有值（不产生第二笔）
    if (trade.status === CoinMarketTradeStatus11.SELLER_CONFIRMATION_PENDING) {
      return {
        tradeId,
        status: trade.status,
        replay: true,
      };
    }

    // 4. 付款截止判定（PAYMENT_PENDING=1 且 payment_deadline_at < now →
    //    读路径超时推进 PAYMENT_EXPIRED=9；首版 worker 未建，登记 §6.3 管线
    //    扩展点，本用例在确认端点读路径判定旧态，不触发 expireTrade）
    if (trade.status === CoinMarketTradeStatus11.PAYMENT_PENDING) {
      const now = await this.clock.now();
      const deadline =
        typeof trade.paymentDeadlineAt === 'string' ? new Date(trade.paymentDeadlineAt).getTime() : trade.paymentDeadlineAt.getTime();
      if (deadline < now.getTime()) {
        // 付款截止已过 → 读路径判定旧态（不触发 expireTrade，登记决策点：
        // Lead 确认确认端点是否应自动推进 PAYMENT_EXPIRED=9）
        throw new CoinMarketDomainError(CM.TRADE_DEADLINE_PASSED, '付款截止时间已过，交易不可确认。', {
          retryable: false,
        });
      }
    }

    // 5. 状态机前置校验（PAYMENT_PENDING=1 → SELLER_CONFIRMATION_PENDING=2）
    if (!canPlayerTriggerTransition(trade.status, CoinMarketTradeStatus11.SELLER_CONFIRMATION_PENDING)) {
      throw new CoinMarketDomainError(
        CM.TRADE_NOT_ALLOWED,
        `交易状态机转换非法（status=${trade.status} → 2，仅 PAYMENT_PENDING=1 可确认）。`,
        { retryable: false },
      );
    }

    // 6. 同事务推进 trade 状态 + listing 守恒变更（reserved → filled）
    const now = await this.clock.now();
    const result = await this.tradeRepo.confirmPayment({
      tradeId,
      confirmedAt: now,
      tx,
    });
    if (result === null) {
      // 影响行数 0 = 并发推进 → 读回既有值（幂等兜底）
      const re = await this.tradeRepo.lockTrade(tradeId, tx);
      if (re !== null && re.status === CoinMarketTradeStatus11.SELLER_CONFIRMATION_PENDING) {
        return {
          tradeId,
          status: re.status,
          replay: true,
        };
      }
      throw new CoinMarketDomainError(CM.STORAGE_UNAVAILABLE, '交易确认状态机转换失败（影响行数 0），请重试。', { retryable: true });
    }
    return {
      tradeId,
      status: result.status,
      replay: false,
    };
  }
}
