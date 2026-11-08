/**
 * coin-market 模块跨模块唯一入口（SDD §1 public.ts 约定：模块内聚，
 * 对外仅 public.ts）。
 *
 * 领域所有者：coin-market 模块（models/coin-market.ts 为其唯一 model 定义；
 * 读 coin_market_listing + 写 coin_market_trade + 同事务 listing 守恒
 * 变更（reserved ↔ available / filled）；asset_hold 释放经 walletModule.ledger，
 * 不直接查表；SDD §5.13 "不新增报表持久化表"，成交列表纯读投影 +
 * 读路径超时推进登记）。
 * 对应 SDD 章节：后端实施 SDD §1（"modules/…/public.ts 跨模块唯一入口"）、
 * §4（application / ports / adapters 布局；构造注入 ports，不用全局）、
 * §9 第 7 步（金币集市挂牌 / 成交 / 确认 / 取消 / 列表）；
 * 数据库设计 SDD §5.13（coin_market_listing 守恒 CHECK +
 * coin_market_trade 11 态 DDL 权威状态机）。
 *
 * 导出约定（与 rooms / social / support / referral 模块 public.ts 同款纪律）：
 * - 全部用例类（构造注入 ports，不用全局——SDD §4 "构造注入"）；
 * - ports 接口（供其他模块 / 测试 mock 依赖，不直接 import adapters）；
 * - 装配工厂 `createCoinMarketModule`（由 `assembly.ts` 提供，本入口 re-export）；
 * - 领域纯函数与错误工具（domain/ 子目录；守恒校验 / 报价 / 状态机转换表，无 IO）；
 * - 本地 ports（2 个 coin-market 仓储端口：ListingRepo + TradeRepo）。
 *
 * 与跨模块集成点（装配层）：
 * - `Sequelize` 实例（models 已 addModels 注册，coin_market_listing /
 *   coin_market_trade 经 models/coin-market.ts）；
 * - **依赖 wallet assembly**（占款 / 放币出账经 walletModule.ledger，
 *   与 rooms 模块同款；须在 `walletModule && sequelizeInstance` 条件块内
 *   装配，main.ts 同款模式）；
 * - 仅复用 wallet ports 的 `Tx` / `Clock` 接口契约（跨模块复用，不重定义
 *   两套，与 rooms / social / referral 模块同款纪律）。
 */

// ---------------------------------------------------------------------------
// 用例类（application/；构造注入 ports，不用全局）
// ---------------------------------------------------------------------------
export { ListingCreateUseCase, type ListingCreateInput, type ListingCreatedDto } from './application/listing-create.js';
export {
  ListingPageUseCase,
  type ListingPageDto,
  type ListingItemDto,
  type PriceQuoteDto,
  LISTING_PAGE_LIMIT,
} from './application/listing-page.js';
export { ListingCancelUseCase, type ListingCancelledDto } from './application/listing-cancel.js';
export {
  TradeUseCase,
  type TradeCreateInput,
  type TradeCreatedDto,
  type TradeConfirmedDto,
  type TradeReleasedDto,
} from './application/trade-create.js';
export { TradeConfirmUseCase } from './application/trade-confirm.js';
export { CoinMarketExpiryScanUseCase } from './application/coin-market-expiry-scan.js';
export {
  TradeListUseCase,
  type TradePageDto,
  type TradeItemDto,
  type TradeDetailDto,
  type TradeCancelledDto,
  TRADE_PAGE_LIMIT,
} from './application/trade-list.js';

// ---------------------------------------------------------------------------
// 装配工厂（inject 全部 ports 的 CoinMarketModule 对象，供 server 装配调用一次）
// ---------------------------------------------------------------------------
export { createCoinMarketModule, type CoinMarketModule, type CoinMarketModuleDeps, type CoinMarketModuleConfig } from './assembly.js';

// ---------------------------------------------------------------------------
// ports（供其他模块 / 测试 mock；不直接 import adapters）
// ---------------------------------------------------------------------------
export type { ListingRepo, TradeRepo, Tx } from './ports/coin-market-repository.js';

// ---------------------------------------------------------------------------
// 领域纯函数与错误工具（domain/；守恒校验 / 报价 / 状态机转换表，无 IO）
// ---------------------------------------------------------------------------
export { CoinMarketDomainError, CM, isCoinMarketDomainError, isDuplicateKeyError, type CoinMarketErrorCode } from './domain/errors.js';
export {
  CoinMarketTradeStatus11,
  CoinMarketListingStatus5,
  type CoinMarketTradeStatus11Value,
  type CoinMarketListingStatus5Value,
  isValidListingInvariant,
  priceQuote,
  PAYMENT_DEADLINE_SECONDS,
  COIN_MARKET_TRADE_TRANSITIONS,
  canTradeTransition,
  canPlayerTriggerTransition,
} from './domain/listing-rules.js';

// ---------------------------------------------------------------------------
// 适配器（Sequelize 实现；每表一类；供测试直接构造，生产经 createCoinMarketModule）
// ---------------------------------------------------------------------------
export { SequelizeListingRepo, SequelizeTradeRepo } from './adapters/sequelize-coin-market.js';
