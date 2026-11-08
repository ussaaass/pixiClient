/**
 * coin-market 模块装配工厂（inject 全部 ports 的 CoinMarketModule，
 * 供 server 装配调用一次；依赖 walletModule，因为挂牌占款 / 成交确认 /
 * 取消释放均经 walletModule.ledger AssetLedger 端口，不直接查表）。
 *
 * 领域所有者：coin-market 模块（models/coin-market.ts 为其唯一 model 定义；
 * 读写用例经 ListingRepo + TradeRepo 端口落库，领域规则经
 * domain/listing-rules.ts 校验）。
 * 对应 SDD 章节：后端实施 SDD §1（装配工厂 `createCoinMarketModule({sequelize,
 * walletModule, config})` 返回注入了全部 ports 的 CoinMarketModule 对象）、
 * §4（构造注入 ports，不用全局；锁顺序 coin_market_listing →
 * coin_market_trade → asset_hold；所有分录 / outbox 同事务）、
 * §9 第 7 步（金币集市挂牌 / 成交 / 确认 / 取消 / 列表）；
 * 数据库设计 SDD §5.13（coin_market_listing 守恒 CHECK + U(listing_key) /
 * U(asset_hold_id)；coin_market_trade 11 态状态机 + U(trade_key) /
 * U(chain_tx_id) / U(asset_operation_id)）。
 *
 * 装配模式（参考 `modules/rooms/assembly.ts`）：
 * - `sequelize`：Sequelize 实例（models 已 addModels 注册，
 *   coin_market_listing / coin_market_trade 经 models/coin-market.ts）；
 * - `walletModule`：已装配的 WalletModule（取 `walletModule.ledger` 作
 *   AssetLedger，`walletModule.clock` 取时钟；占款 / 放币出账经
 *   wallet ledger 扩展点登记，首版只写 hold 行 + 推进 trade 状态 +
 *   listing 守恒变更）；
 * - `config`：时钟注入（测试可传固定时钟；缺省经 walletModule.clock 取，
 *   与 rooms assembly 同款约定）。
 *
 * 未闭环登记（完成报告给 Lead）：
 * - 占款 / 放币出账经 wallet ledger 扩展点登记（COIN_MARKET_HOLD=12 /
 *   COIN_MARKET_TRADE=13 / COIN_MARKET_RELEASE=14 分录同事务），首版
 *   只写 hold 行 + 推进 trade 状态 + listing 守恒变更，分录经
 *   §6.3 worker 管线闭环（登记决策点：Lead 确认占款是否需同事务
 *   COIN_MARKET_HOLD=12 分录）；
 * - PAYMENT_EXPIRED / AUTO_RELEASED worker 未建（§6.3 管线），首版
 *   读路径超时推进为过渡方案（登记决策点：Lead 确认读路径逐笔推进
 *   vs worker 批量扫描）；
 * - 11 态 DDL 权威状态机首版只覆盖玩家侧路径（1→2→{7,8,9,10,11}），
 *   DISPUTE 3/4/5/6 裁决路径归 §9 第 9 步 Admin 端点（登记决策点：
 *   首版玩家侧是否允许 PAYMENT_PENDING → CANCELLED=11 买家取消）；
 * - contracts CoinMarketTradeStatus 9 值 vs DDL 11 值双轨差异：
 *   本模块用 models/coin-market.ts 11 值权威常量，contracts 9 值
 *   不动（P0 本地简化，对齐归 §9 第 9 步 Admin cutover，登记决策点）；
 * - sellerUserId 归属校验经 listing 行读回（trade 表无 seller_user_id 列，
 *   登记决策点：Lead 确认是否需 0017 迁移补 seller_user_id 冗余列）。
 */

import type { Sequelize, Transaction } from 'sequelize';
import { CoinMarketListingModel, CoinMarketTradeModel } from '../../infrastructure/database/models/coin-market.js';
import type { Clock } from '../wallet/ports/clock.js';
import type { WalletModule } from '../wallet/assembly.js';
import type { AssetLedger, Tx } from '../wallet/ports/wallet-repository.js';

import { SequelizeListingRepo, SequelizeTradeRepo } from './adapters/sequelize-coin-market.js';
import type { ListingRepo, TradeRepo } from './ports/coin-market-repository.js';
import { ListingCreateUseCase } from './application/listing-create.js';
import { ListingPageUseCase } from './application/listing-page.js';
import { ListingCancelUseCase } from './application/listing-cancel.js';
import { TradeUseCase } from './application/trade-create.js';
import { TradeConfirmUseCase } from './application/trade-confirm.js';
import { TradeListUseCase } from './application/trade-list.js';
import { CoinMarketExpiryScanUseCase } from './application/coin-market-expiry-scan.js';

/** 装配配置（时钟注入；测试可传固定时钟；缺省经 walletModule.clock 取）。 */
export interface CoinMarketModuleConfig {
  /** 时钟注入（测试可传固定时钟；缺省经 walletModule.clock 取，与 rooms assembly 同款约定）。 */
  clock?: Clock;
}

/** 装配依赖（Sequelize 实例 + 已装配的 WalletModule + 配置；模型类在装配内取，参考 rooms assembly）。 */
export interface CoinMarketModuleDeps {
  sequelize: Sequelize;
  walletModule: WalletModule;
  config: CoinMarketModuleConfig;
}

/** 全部 ports + 用例实例的 CoinMarketModule（构造注入，不用全局，SDD §4）。 */
export interface CoinMarketModule {
  // ports（共享实现，供测试 / 其他模块 mock 时参考）
  listingRepo: ListingRepo;
  tradeRepo: TradeRepo;
  ledger: AssetLedger;
  clock: Clock;

  // 用例实例（构造注入 ports，不用全局，SDD §4）
  listingCreate: ListingCreateUseCase;
  listingPage: ListingPageUseCase;
  listingCancel: ListingCancelUseCase;
  trade: TradeUseCase;
  tradeConfirm: TradeConfirmUseCase;
  tradeList: TradeListUseCase;
  expiryScan: CoinMarketExpiryScanUseCase;

  /**
   * 在事务 scope 内构建同事务端口（§6.3 "所有分录 / outbox 同事务"约定；
   * coin-market 写路径经 withTx 透传 tx，供用例同事务 / 无事务调用）。
   */
  withTx<T>(scope: { transaction: Transaction | null }, fn: (tx: Tx) => T | Promise<T>): Promise<T>;
}

/**
 * 装配 coin-market 模块（inject 全部 ports 的 CoinMarketModule，
 * 供 server 装配调用一次）。
 * 用法（apps/server bootstrap）：
 * ```ts
 * const coinMarketModule = createCoinMarketModule({
 *   sequelize,
 *   walletModule,
 *   config,
 * });
 * ```
 * 注：本模块依赖 walletModule，须在 `walletModule && sequelizeInstance`
 * 条件块内装配（main.ts 同款模式）。
 */
export function createCoinMarketModule(deps: CoinMarketModuleDeps): CoinMarketModule {
  const { walletModule, config } = deps;
  const clock: Clock = config.clock ?? walletModule.clock;
  const ledger: AssetLedger = walletModule.ledger;

  // 构建 Sequelize 仓储实现（每表一类，不混类；model 类构造注入，
  // 不用全局，SDD §4；各 Repo 独立实现，供按角色取用）。
  const listingRepo = new SequelizeListingRepo(CoinMarketListingModel);
  const tradeRepo = new SequelizeTradeRepo(CoinMarketTradeModel, CoinMarketListingModel);

  // displayNameOf：跨模块匿名展示名（首版简化：返回 userId 后 8 位，
  // 登记决策点：Lead 确认是否经 identity model 读 publicCode）
  const displayNameOf = async (userId: string): Promise<string> => `USER_${userId.slice(-8)}`;

  // 用例实例（构造注入 ports，不用全局，SDD §4；各 Repo 独立类按角色传入）。
  const listingCreate = new ListingCreateUseCase(listingRepo, ledger, clock);
  const listingPage = new ListingPageUseCase(listingRepo, displayNameOf);
  const listingCancel = new ListingCancelUseCase(listingRepo, ledger, clock);
  const trade = new TradeUseCase(tradeRepo, listingRepo, ledger, clock);
  const tradeConfirm = new TradeConfirmUseCase(tradeRepo, listingRepo, clock);
  const tradeList = new TradeListUseCase(tradeRepo, listingRepo, ledger, clock);
  const expiryScan = new CoinMarketExpiryScanUseCase(tradeRepo, listingRepo, ledger, clock);

  const module: CoinMarketModule = {
    listingRepo,
    tradeRepo,
    ledger,
    clock,
    listingCreate,
    listingPage,
    listingCancel,
    trade,
    tradeConfirm,
    tradeList,
    expiryScan,

    async withTx<T>(scope: { transaction: Transaction | null }, fn: (tx: Tx) => T | Promise<T>): Promise<T> {
      if (scope.transaction === null) throw new TypeError('CoinMarket commands require an active transaction');
      // coin-market 写路径经 withTx 透传 tx（同事务约定，SDD §6.3；
      // 用例写 coin_market_listing / coin_market_trade 同事务提交 / 回滚，
      // asset_hold 释放经 walletModule.ledger 同事务调用）。
      const tx: Tx = { transaction: scope.transaction as Transaction | undefined };
      return fn(tx);
    },
  };

  return module;
}
