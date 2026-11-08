/**
 * coin-market 模块用例入口（application 层 re-export；供 assembly.ts 装配
 * 与测试直接导入，不直接 import adapters，SDD §4）。
 *
 * 领域所有者：coin-market 模块（读 coin_market_listing + 写 coin_market_trade
 * + 同事务 listing 守恒变更（reserved ↔ available / filled）；asset_hold
 * 释放经 walletModule.ledger，不直接查表；SDD §5.13 "不新增报表持久化表"，
 * 成交列表纯读投影 + 读路径超时推进登记）。
 * 对应 SDD 章节：后端实施 SDD §4（构造注入 ports，不用全局）、§9 第 7 步
 * （金币集市挂牌 / 成交 / 确认 / 取消 / 列表）、§5.13（coin_market_trade
 * 11 态 DDL 权威状态机 + U(trade_key) / U(chain_tx_id) 幂等）。
 */

// ---------------------------------------------------------------------------
// 挂牌创建（POST /me/coin-market/listings，201 新创建 / 200 幂等重放）
// ---------------------------------------------------------------------------
export { ListingCreateUseCase, type ListingCreateInput, type ListingCreatedDto } from './listing-create.js';

// ---------------------------------------------------------------------------
// 集市页 + 报价（GET /me/coin-market/listings + GET /me/coin-market/price-quote，
// 只读，无副作用；referenceCentsPer1000Coins 首版纯读集市内最低报价）
// ---------------------------------------------------------------------------
export { ListingPageUseCase, type ListingPageDto, type ListingItemDto, type PriceQuoteDto, LISTING_PAGE_LIMIT } from './listing-page.js';

// ---------------------------------------------------------------------------
// 挂牌取消（POST /me/coin-market/listings/:id/cancel，200 幂等重放；
// ACTIVE=1 → CANCELLED=4 + 释放占款 asset_hold，同事务）
// ---------------------------------------------------------------------------
export { ListingCancelUseCase, type ListingCancelledDto } from './listing-cancel.js';

// ---------------------------------------------------------------------------
// 成交创建 + 卖家确认 + 买家放币（POST /me/coin-market/trades +
// POST /me/coin-market/trades/:id/confirm + POST /me/coin-market/trades/:id/release）
// ---------------------------------------------------------------------------
export {
  TradeUseCase,
  type TradeCreateInput,
  type TradeCreatedDto,
  type TradeConfirmedDto,
  type TradeReleasedDto,
} from './trade-create.js';
export { TradeConfirmUseCase } from './trade-confirm.js';
export { CoinMarketExpiryScanUseCase } from './coin-market-expiry-scan.js';

// ---------------------------------------------------------------------------
// 成交列表 + 详情 + 过期 / 取消（GET /me/coin-market/trades +
// GET /me/coin-market/trades/:id + POST /me/coin-market/trades/:id/cancel，
// 读路径超时推进 PAYMENT_EXPIRED=9 登记 §6.3 worker 未建）
// ---------------------------------------------------------------------------
export {
  TradeListUseCase,
  type TradePageDto,
  type TradeItemDto,
  type TradeDetailDto,
  type TradeCancelledDto,
  TRADE_PAGE_LIMIT,
} from './trade-list.js';
