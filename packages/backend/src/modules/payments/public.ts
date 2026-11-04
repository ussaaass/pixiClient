/**
 * payments 模块跨模块唯一入口（SDD §1 public.ts 约定：模块内聚，对外仅
 * public.ts）。
 *
 * 领域所有者：payments 模块（order / payment_event / external_settlement /
 * payout_account / withdrawal / payment_channel / payment_provider 读写 +
 * 链到账 worker + 占款事务经 wallet AssetLedger）。
 * 对应 SDD 章节：后端实施 SDD §1（"modules/…/public.ts 跨模块唯一入口"）、
 * §4（application / ports / adapters 布局，构造注入 ports 不用全局）、
 * §9 第 3 步（支付与提现：orders/withdrawals/payouts + 渠道 + Mock 操作页
 * + 链到账 worker）；双资产文档 §3/§4/§5。
 *
 * 导出约定（与 wallet / identity 模块 public.ts 同款纪律）：
 * - 全部用例类（构造注入 ports，不用全局——SDD §4 "构造注入"）；
 * - ports 接口（供其他模块 / 测试 mock 依赖，不直接 import adapters）；
 * - 装配工厂 `createPaymentsModule`（由 `assembly.ts` 提供，本入口 re-export）；
 * - 领域纯函数与错误工具（domain/ 子目录；金额/状态机/报价不变量，无 IO）；
 * - Mock chain scanner（首版空实现，测试可替换 fixture，真实 TRON 扫描
 *   未闭环——Lead 统一验证时登记）。
 *
 * 用例文件之间不互相 import 内部类；跨用例共享经本文件。
 * 账本操作全部经 wallet 模块 `AssetLedger` 端口（import type 自
 * `modules/wallet/ports/wallet-repository.js`，任务硬约定 1），本模块
 * 不写分录 SQL；AssetLedger 缺方法才在 wallet ports 接口扩展（本步已加
 * createHold/releaseHold/consumeHold 三方法，实现类 `SequelizeWalletLedger`
 * 同步落地，不破坏既有实现——任务硬约定 1 "加方法不破坏实现"）。
 */

// ---------------------------------------------------------------------------
// 用例类（application/；构造注入 ports，不用全局）
// ---------------------------------------------------------------------------
export { OrderCreateUseCase, type CreateOrderInput, type CreateOrderResult } from './application/order-create.js';
export { PaymentEventUseCase, type PaymentEventInput, type PaymentEventResult } from './application/payment-event.js';
export {
  WithdrawalUseCase,
  type QuoteWithdrawalInput,
  type CreateWithdrawalInput,
  type CreateWithdrawalResult,
} from './application/withdrawal.js';
export { WithdrawalCancelUseCase, type CancelWithdrawalInput, type CancelWithdrawalResult } from './application/withdrawal-cancel.js';
export {
  PayoutAccountUseCase,
  type PayoutAccountCreateInput,
  type PayoutAccountDeleteInput,
  normalizePayoutAccount,
} from './application/payout-accounts.js';
export { ScanChainDepositsUseCase, type ScanChainDepositsInput, type ScanChainDepositsResult } from './application/chain-deposit.js';

// ---------------------------------------------------------------------------
// 装配工厂（inject 全部 ports 的 PaymentsModule 对象，供 server 装配调用一次）
// ---------------------------------------------------------------------------
export { createPaymentsModule, outboxFor, type PaymentsModule, type PaymentsModuleDeps, type PaymentsModuleConfig } from './assembly.js';

// ---------------------------------------------------------------------------
// ports（供其他模块 / 测试 mock；不直接 import adapters）
// ---------------------------------------------------------------------------
export type {
  OrderRepository,
  OrderView,
  ChannelRepository,
  ChannelView,
  PayoutAccountRepository,
  WithdrawalRepository,
  PaymentEventRepository,
  ExternalSettlementRepository,
  IdentityReader,
  IdentityUserView,
  PaymentsSharedDeps,
  Tx,
  OutboxPort,
  OutboxAppendInput,
  Clock,
  EntryIntent,
  ExchangeRate,
} from './ports/payments-repository.js';
export type { ChainScannerPort, ChainDepositCandidate } from './ports/chain-scan-port.js';

// ---------------------------------------------------------------------------
// 领域纯函数与错误工具（domain/；订单过期/支付匹配/状态机/提现报价，无 IO）
// ---------------------------------------------------------------------------
export {
  isOrderExpired,
  isOrderPayable,
  matchPaymentEvent,
  purchaseCoinsForFen,
  assertWithdrawalNetCny,
  withdrawalFeeOf,
  isWithdrawalTransitionAllowed,
  transitionReleasesHold,
  requestHashOf,
  identitySatisfied,
  ORDER_TTL_MINUTES,
  WITHDRAWAL_FEE_BPS,
  MINIMUM_WITHDRAWAL_COINS,
  WITHDRAWAL_DELAY_HOURS,
  withdrawalAllowedTransitions,
  type PaymentMatchInput,
  type PaymentMatchResult,
  type WithdrawalStatusValue,
  type IdentityUserFields,
} from './domain/rules.js';
export { PaymentDomainError, P, isPaymentDomainError, isDuplicateKeyError, type PaymentErrorCodeValue } from './domain/errors.js';

// ---------------------------------------------------------------------------
// 适配器（Sequelize 实现；供测试直接构造，生产经 createPaymentsModule）
// ---------------------------------------------------------------------------
export {
  SequelizeOrderRepository,
  SequelizeChannelRepository,
  SequelizePayoutAccountRepository,
  SequelizeWithdrawalRepository,
  SequelizePaymentEventRepository,
  SequelizeExternalSettlementRepository,
  SequelizeIdentityReader,
  type PaymentsModelSet,
} from './adapters/sequelize-payments.js';
export { MockChainScanner } from './adapters/mock-chain-scanner.js';
