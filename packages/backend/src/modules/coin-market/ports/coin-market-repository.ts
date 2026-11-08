/**
 * coin-market 模块仓储端口（coin_market_listing + coin_market_trade 2 表；
 * models/coin-market.ts 为 model 定义；11 态 DDL 权威状态机）。
 *
 * 领域所有者：coin-market 模块（adapters/sequelize-coin-market.ts 各 Repo 类
 * 实现各端口；asset_hold 经 wallet 模块 AssetLedger 端口操作，不直接查表）。
 * 对应 SDD 章节：后端实施 SDD §4（构造注入 ports，用例 / 适配器经端口落库；
 * 锁顺序 coin_market_listing → coin_market_trade → asset_hold，幂等先抢
 * 唯一约束；所有分录 / outbox 同事务）、§9 第 7 步（金币集市：挂牌 / 成交 /
 * 确认 / 取消）、§5.13（coin_market_listing 守恒 CHECK + coin_market_trade
 * 11 态状态机）；数据库设计 SDD §5.13（U(listing_key) / U(asset_hold_id) /
 * U(trade_key) / U(chain_tx_id) / U(asset_operation_id) 幂等）。
 *
 * 约定（与 rooms / social / referral 模块 ports 同款纪律）：
 * - 方法名经实体前缀区分（createListing / lockListing / listActiveListings /
 *   cancelListing / createTrade / lockTrade / confirmPayment / expireTrade /
 *   releaseToBuyer / cancelTrade，各表 CRUD 语义独立，无重名冲突）；
 * - `Tx` 复用 wallet 模块 `Tx`（Sequelize 事务句柄鸭子类型），用例内所有
 *   写操作共享同一事务（回滚即整事务回滚）；
 * - 幂等兜底：`U(listing_key)`（coin_market_listing）/ `U(trade_key)` +
 *   `U(chain_tx_id)`（coin_market_trade）命中 → 返回既有行
 *   （`inserted: false`，不产生第二行，验收红线"成交幂等"）；
 * - 守恒 CHECK：`listed = available + reserved + filled + cancelled`
 *   （全部非负，listed > 0），经 `domain/listing-rules.ts` `isValidListingInvariant`
 *   前置校验，本层只做 UPDATE 落库（DB CHECK 兜底，迁移 0016）。
 *
 * 状态机（11 态 DDL 权威，models/coin-market.ts CoinMarketTradeStatus）：
 * 首版覆盖 PAYMENT_PENDING=1 → SELLER_CONFIRMATION_PENDING=2 →
 * {RELEASED=7 / AUTO_RELEASED=8 / PAYMENT_EXPIRED=9 / CANCELLED=11 /
 * RESOLVED_RETURN=10}；DISPUTE 路径（3/4/5/6）首版只读不写（Admin 裁决
 * 端点归 §9 第 9 步），本端口声明全部转换方法，用例层经
 * `domain/listing-rules.ts` `canPlayerTriggerTransition` 前置校验。
 */

import type { CoinMarketListingModel, CoinMarketTradeModel } from '../../../infrastructure/database/models/coin-market.js';
import type { Tx } from '../../wallet/ports/wallet-repository.js';

export type { Tx };

// ---------------------------------------------------------------------------
// ListingRepo（coin_market_listing）
// 方法名：createListing / lockListing / listActiveListings / cancelListing
// ---------------------------------------------------------------------------

export interface ListingRepo {
  /**
   * 创建挂牌行（coin_market_listing ACTIVE=1，U(listing_key) 幂等兜底：
   * 命中 → 返回既有行 `inserted: false`；assetHoldId 经 walletModule.ledger
   * createHold 同事务取得，hold_type=COIN_MARKET_LISTING=5，U(asset_hold_id)
   * 唯一）。
   * @param input.listedCoins / availableCoins 初始均为 listedCoins（reserved /
   *   filled / cancelled 全 0），守恒成立。
   */
  createListing(input: {
    sellerUserId: string;
    listingKey: string;
    assetHoldId: string;
    listedCoins: string;
    priceCentsPer1000Coins: string;
    receiveMethod: number;
    receiveSnapshot: Record<string, unknown> | null;
    platformPaymentOptIn: number;
    tx: Tx;
  }): Promise<{ inserted: boolean; listing: CoinMarketListingModel }>;

  /** 按幂等 listing_key 行锁读取挂牌（操作已提交重放路径）。 */
  lockListingByKey(listingKey: string, tx: Tx): Promise<CoinMarketListingModel | null>;

  /** 行锁读挂牌行（成交 / 取消前置校验；status + 守恒经用例层校验）。 */
  lockListing(listingId: string, tx: Tx): Promise<CoinMarketListingModel | null>;

  /**
   * 列出全部活跃挂牌（status=ACTIVE=1 + availableCoins > 0，集市页；
   * 游标分页 `createdAt + id` 稳定游标，首版 50/页登记决策点；按
   * `priceCentsPer1000Coins ASC` 排序（价格低优先，登记决策点：Lead 确认
   * 排序策略））。
   * @param input.referenceCentsPer1000Coins 参考报价（首版取集市页内
   *   最低价，经本方法读回后计算，登记决策点：可经 configuration 注入
   *   市场基准价，首版纯读集市内最低报价）。
   */
  listActiveListings(input: {
    cursor: string | null;
    limit: number;
    tx: Tx;
  }): Promise<{ items: CoinMarketListingModel[]; nextCursor: string | null; referenceCentsPer1000Coins: string | null }>;

  /**
   * 取消挂牌（ACTIVE=1 → CANCELLED=4；cancelled_at 回填；同事务释放
   * asset_hold（经 walletModule.ledger releaseHold，本方法只推进 listing
   * 状态 + available → cancelled 守恒变更，hold 释放在用例层同事务调用）；
   * 幂等重放：已 CANCELLED → 静默返回既有值（不产生第二笔）；
   * 非 ACTIVE → 用例层前置校验抛 LISTING_NOT_CANCELLABLE）。
   * @returns 更新后的行（影响行数 0 → null，由用例层映射 STORAGE_UNAVAILABLE）。
   */
  cancelListing(input: { listingId: string; cancelledAt: Date; tx: Tx }): Promise<CoinMarketListingModel | null>;
}

// ---------------------------------------------------------------------------
// TradeRepo（coin_market_trade）
// 方法名：createTrade / lockTrade / confirmPayment / expireTrade /
//         releaseToBuyer / cancelTrade
// ---------------------------------------------------------------------------

export interface TradeRepo {
  /**
   * 创建交易行（coin_market_trade PAYMENT_PENDING=1，U(trade_key) 幂等兜底：
   * 命中 → 返回既有行 `inserted: false`；payment_deadline_at = now +
   * 权威 SDD 已确认的 48 小时期限由用例计算并传入；同事务锁读
   * listing availableCoins 预占（reserved += coins，available -= coins，
   * 守恒经 `isValidListingInvariant` 前置校验 + DB CHECK 兜底）。
   * @param input.coins 预占金币数量（string wire，BigInt 全链路）；
   *   须 ≤ listing.availableCoins（用例层前置校验，超过 → COINS_INSUFFICIENT）。
   */
  createTrade(input: {
    listingId: string;
    buyerUserId: string;
    sellerUserId: string;
    tradeKey: string;
    coins: string;
    grossCents: string;
    sellerNetCents: string;
    paymentMethod: number;
    paymentDeadlineAt: Date;
    tx: Tx;
  }): Promise<{
    inserted: boolean;
    trade: CoinMarketTradeModel;
    /** 是否为新创建（false = U(trade_key) 命中重放，不产生第二笔）。 */
    isNew: boolean;
  }>;

  /** 读取交易引用用于按统一顺序锁 listing → trade；不取得行锁。 */
  getTrade(tradeId: string, tx: Tx): Promise<CoinMarketTradeModel | null>;

  /** 行锁读交易行（listing 已锁后调用，确保统一 listing → trade 顺序）。 */
  lockTrade(tradeId: string, tx: Tx): Promise<CoinMarketTradeModel | null>;

  /**
   * 卖家确认收款（PAYMENT_PENDING=1 → SELLER_CONFIRMATION_PENDING=2；
   * 首版登记 payment_proof 校验未闭环——SDD §5.13 "确认支付成功才将占款
   * 转为完成扣款"，经 wallet ledger COIN_MARKET_TRADE=13 分录同事务，
   * 本方法只推进 trade 状态 + listing reserved → filled 守恒变更；
   * 放币出账（buyer 获得 coins）经 wallet ledger 扩展点登记，首版不入账）。
   * @returns 更新后的行（影响行数 0 → null，由用例层映射 TRADE_NOT_ALLOWED）。
   */
  confirmPayment(input: { tradeId: string; confirmedAt: Date; tx: Tx }): Promise<CoinMarketTradeModel | null>;

  /**
   * 付款超时推进（PAYMENT_PENDING=1 → PAYMENT_EXPIRED=9；同事务释放
   * listing reserved（reserved -= coins，available += coins，守恒变更）+
   * 释放 asset_hold（经 walletModule.ledger releaseHold，用例层同事务调用）；
   * 到期处理由读路径或有界 PAYMENT_EXPIRED worker 调用；不再由列表轮询逻辑单独驱动。
   * payment_deadline_at < now 触发本方法（登记决策点：Lead 确认首版
   * worker vs 读路径触发超时推进）。
   * @returns 更新后的行（影响行数 0 → null，由用例层映射 TRADE_DEADLINE_PASSED）。
   */
  expireTrade(input: { tradeId: string; expiredAt: Date; tx: Tx }): Promise<CoinMarketTradeModel | null>;

  /**
   * 买家确认放币（SELLER_CONFIRMATION_PENDING=2 → RELEASED=7；
   * 同事务 listing reserved → filled 守恒变更 + wallet ledger 放币
   * 扩展点登记（首版不入账，经 wallet ledger COIN_MARKET_RELEASE=14
   * 分录同事务，worker 未建，登记决策点）；幂等重放：已 RELEASED →
   * 静默返回既有值（不产生第二笔））。
   * @returns 更新后的行（影响行数 0 → null，由用例层映射 TRADE_NOT_ALLOWED）。
   */
  releaseToBuyer(input: { tradeId: string; releasedAt: Date; tx: Tx }): Promise<CoinMarketTradeModel | null>;

  /**
   * 列出买家成交列表（按 buyerUserId + status + createdAt 游标分页 50/页；
   * 读路径只读投影，超时推进在 getTrade 详情端点触发，本方法纯读）。
   * @param input.buyerUserId 买家用户 ID（user.id）。
   * @param input.cursor 稳定游标 `{createdAt ISO}~{id}`；null 读首页。
   * @returns 成交列表 + nextCursor（null 表示无更多页）。
   */
  listByBuyer(input: {
    buyerUserId: string;
    cursor: string | null;
    limit: number;
    tx: Tx;
  }): Promise<{ items: CoinMarketTradeModel[]; nextCursor: string | null }>;

  /** Bounded, deterministic due-trade selection; MySQL adapter uses FOR UPDATE SKIP LOCKED. */
  listDuePaymentPendingTradeIds(input: { dueAt: Date; limit: number; tx: Tx }): Promise<string[]>;

  /**
   * 卖家取消（PAYMENT_PENDING=1 → CANCELLED=11；同事务释放
   * listing reserved（reserved -= coins，available += coins，守恒变更）+
   * 释放 asset_hold（经 walletModule.ledger releaseHold，用例层同事务调用）；
   * 幂等重放：已 CANCELLED → 静默返回既有值（不产生第二笔）；
   * 非 PAYMENT_PENDING → 用例层前置校验抛 TRADE_NOT_ALLOWED）。
   * @returns 更新后的行（影响行数 0 → null，由用例层映射 TRADE_NOT_ALLOWED）。
   */
  cancelTrade(input: { tradeId: string; cancelledAt: Date; tx: Tx }): Promise<CoinMarketTradeModel | null>;
}
