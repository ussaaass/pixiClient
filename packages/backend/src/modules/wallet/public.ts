/**
 * wallet 模块跨模块唯一入口（SDD §1 public.ts 约定：模块内聚，对外仅 public.ts）。
 *
 * 领域所有者：wallet 模块（asset_account / asset_operation / asset_entry /
 * asset_hold / coin_exchange / gift_grant / turnover_state + 双资产用例）。
 * 对应 SDD 章节：后端实施 SDD §1（"modules/…/public.ts 跨模块唯一入口"）、
 * §4（application / ports / adapters 布局）、§9 实施顺序第 2 步（钱包闭环：
 * summary/activity/transfer/exchange 真实 handler + 流水门槛 + 赠币）。
 *
 * 导出约定（与 identity 模块 public.ts 同款纪律）：
 * - 全部用例类（构造注入 ports，不用全局——SDD §4 "构造注入"）；
 * - ports 接口（供其他模块 / 测试 mock 依赖，不直接 import adapters）；
 * - 装配工厂 `createWalletModule`（由 `assembly.ts` 提供，本入口 re-export）；
 * - 领域纯函数与错误工具（domain/ 子目录；金额/版本/汇率不变量，无 IO）。
 *
 * 用例文件之间不互相 import 内部类；跨用例共享经本文件。
 * `GrantWelcomeGiftUseCase` 实现 identity `WelcomeGiftPort` 接口
 * （modules/identity/ports/welcome-gift-port.ts），装配时替换 identity 的
 * `walletModule.welcomeGiftPort`，打通 SDD §4 "注册 workflow 幂等调用新用户赠币"。
 */

// ---------------------------------------------------------------------------
// 用例类（application/；构造注入 ports，不用全局）
// ---------------------------------------------------------------------------
export { WalletSummaryUseCase } from './application/wallet-summary.js';
export { WalletActivityUseCase } from './application/wallet-activity.js';
export { CoinTransferUseCase, type TransferQuoteInput, type TransferSubmitInput } from './application/transfer.js';
export { CoinExchangeUseCase, type ExchangeQuoteInput, type ExchangeSubmitInput } from './application/exchange.js';
export { GrantWelcomeGiftUseCase } from './application/gift-grant.js';
export { TurnoverGateUseCase, type TurnoverGateResult, type TurnoverView } from './application/turnover.js';

// ---------------------------------------------------------------------------
// 装配工厂（inject 全部 ports 的 WalletModule 对象，供 server 装配调用一次）
// ---------------------------------------------------------------------------
export {
  createWalletModule,
  outboxFor,
  type WalletModule,
  type WalletModuleDeps,
  type WalletModuleConfig,
  type PlayerAssetAccountsPort,
} from './assembly.js';

// ---------------------------------------------------------------------------
// ports（供其他模块 / 测试 mock；不直接 import adapters）
// ---------------------------------------------------------------------------
export type {
  AssetLedger,
  ConfigReader,
  Tx,
  EntryIntent,
  LedgerPost,
  ExchangeRate,
  TurnoverState,
  WalletContext,
  SystemIdentityPort,
} from './ports/wallet-repository.js';
export {
  WalletOperationType,
  WalletEntryType,
  WalletRoundingMode,
  WalletTurnoverStatus,
  type WalletOperationTypeValue,
} from './ports/wallet-repository.js';
export type { OutboxPort, OutboxAppendInput } from './ports/outbox-port.js';
export type { Clock } from './ports/clock.js';
export { SystemClock } from './ports/clock.js';

// ---------------------------------------------------------------------------
// 领域纯函数与错误工具（domain/；金额守恒 / 版本冲突 / 汇率解析 / 报价校验）
// ---------------------------------------------------------------------------
export {
  requestHashOf,
  parseCnyToCoinRatio,
  checkTransferQuote,
  checkExchangeQuote,
  assertConservation,
  assertVersionNotConflicted,
  assertAvailableBalance,
  assertExchangeAmountPositive,
  checkTurnoverGate,
  TRANSFER_FEE_BPS,
  WELCOME_GIFT_COINS_DEFAULT,
  TURN_MULTIPLIER_DEFAULT,
} from './domain/ledger-rules.js';
export { WalletDomainError, W as WalletErrorCodes, isWalletDomainError, isDuplicateKeyError } from './domain/errors.js';

// ---------------------------------------------------------------------------
// row-mappers（model 行 → contracts DTO；BigInt/ID wire 十进制字符串格式化）
// ---------------------------------------------------------------------------
export {
  toBigIntWire,
  toAssetSummary,
  toWalletSummary,
  toActivityItem,
  buildActivityCursor,
  toActivityPage,
  toDateIso,
  toTurnoverView,
} from './adapters/row-mappers.js';

// ---------------------------------------------------------------------------
// 适配器（Sequelize 实现；供测试直接构造，生产经 createWalletModule）
// ---------------------------------------------------------------------------
export { SequelizeWalletLedger } from './adapters/sequelize-wallet-ledger.js';
