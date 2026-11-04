/**
 * payments 模块装配工厂（inject 全部 ports 的 PaymentsModule，供 server 装配
 * 调用一次；SDD §9 第 3 步支付与提现）。
 *
 * 领域所有者：payments 模块（models/payments.ts 9 model + models/chain.ts
 * 读侧 + outbox；资产分录/锁/抢键/占款全部经 wallet 模块 `AssetLedger`
 * 端口——任务硬约定 1，本模块不写分录 SQL）。
 * 对应 SDD 章节：后端实施 SDD §1（装配工厂 `createPaymentsModule({sequelize,
 * walletModule, config})` 返回注入了全部 ports 的 PaymentsModule 对象）、
 * §4（构造注入 ports，不用全局；锁顺序/幂等/同事务约定）、§9 第 3 步
 * （支付与提现：orders/withdrawals/payouts + 渠道 + Mock 操作页 + 链到账
 * worker）、§6.3（所有分录/outbox 同事务）。
 *
 * 装配模式（参考 `modules/wallet/assembly.ts` 同款纪律）：
 * - `sequelize`：Sequelize 实例（models 已 addModels 注册，§3.2 payments 9
 *   model + chain 3 model + outbox + user + wallet 7 model）；
 * - `walletModule`：`createWalletModule` 产物（ledger/configReader/turnoverGate/
 *   systemIdentity/clock 直接复用，不重建——任务硬约定 1 "账本操作全部经
 *   AssetLedger，ledger/configReader/turnoverGate 从 walletModule 取"）；
 * - `config`：时钟注入 + 系统身份 user id（与 wallet 装配同款；systemUserId
 *   经 wallet config 传入后本处复用，登记：装配期解析一次）；
 * - Mock chain scanner（adapters/mock-chain-scanner.ts；真实 TRON 扫描未
 *   闭环，随 §6.3 outbox worker 同批落地，登记）。
 *
 * 未闭环登记（完成报告给 Lead）：
 * - 需补 seed 迁移（Mock provider MOCK=3 + channel ALIPAY method_type=1，
 *   0010 无 Mock provider/channel seed）——createOrder 在 seed 落地前因
 *   FUNDING_CHANNEL_UNAVAILABLE 不可用（渠道列表为空），属预期降级；
 * - 需补 product seed 迁移（order.product_id 首版填 ''，Mock 渠道商品语义
 *   经 order.extra JSON fulfillmentSpec 承载，product 目录落地后回填真值）；
 * - 真实 TRON RPC 扫描 + 链确认数 + USDT 日更汇率采样未闭环（chain-deposit
 *   用例首版 Mock 空实现，与 outbox worker 同批落地，SDD §9 第 3 步验收项）；
 * - 出款 worker（withdrawal SUCCEEDED=5 的 WITHDRAWAL_SETTLEMENT=7 消耗分录）
 *   未建（§4 "确认支付成功才将占款转为完成扣款"，首版状态机转换表已登记
 *   语义，实际分录随出款服务商接入落地）；
 * - payout_account 敏感字段 KMS 加密未闭环（首版 account_ciphertext 列存
 *   明文 base64，model 保持二进制原样口径不变，真实 KMS 落地后改存密文）；
 * - payment_event CHAIN_DEPOSIT=4 常量未注册（contracts 无此码，首版用 4
 *   与 models/payments.ts PaymentEventType 注释值集对齐，待 contracts 补）；
 * - 身份三选一未满足时映射 INVALID_PAYOUT_ACCOUNT（contracts 无"身份未
 *   验证"专码，P 表只映射既有码子集，errors.ts 头注释登记）。
 */

import type { Sequelize, Transaction } from 'sequelize';
import { OutboxModel } from '../../infrastructure/database/models/events.js';

import {
  PaymentProviderModel,
  PaymentChannelModel,
  OrderModel,
  PaymentEventModel,
  ExternalSettlementModel,
  PayoutAccountModel,
  WithdrawalModel,
} from '../../infrastructure/database/models/payments.js';
import { UserModel } from '../../infrastructure/database/models/identity.js';

import { SequelizeOrderRepository } from './adapters/sequelize-payments.js';
import { SequelizeChannelRepository } from './adapters/sequelize-payments.js';
import { SequelizePayoutAccountRepository } from './adapters/sequelize-payments.js';
import { SequelizeWithdrawalRepository } from './adapters/sequelize-payments.js';
import { SequelizePaymentEventRepository } from './adapters/sequelize-payments.js';
import { SequelizeExternalSettlementRepository } from './adapters/sequelize-payments.js';
import { SequelizeIdentityReader } from './adapters/sequelize-payments.js';
import { MockChainScanner } from './adapters/mock-chain-scanner.js';

import type {
  AssetLedger,
  ConfigReader,
  SystemIdentityPort,
  Tx,
  Clock,
  OutboxPort,
  OutboxAppendInput,
} from './ports/payments-repository.js';
import type { TurnoverGateUseCase } from '../wallet/application/turnover.js';
import type { WalletModule } from '../wallet/assembly.js';
import type {
  OrderRepository,
  ChannelRepository,
  PayoutAccountRepository,
  WithdrawalRepository,
  PaymentEventRepository,
  ExternalSettlementRepository,
  IdentityReader,
} from './ports/payments-repository.js';
import type { ChainScannerPort } from './ports/chain-scan-port.js';

import { OrderCreateUseCase } from './application/order-create.js';
import { PaymentEventUseCase } from './application/payment-event.js';
import { WithdrawalUseCase } from './application/withdrawal.js';
import { WithdrawalCancelUseCase } from './application/withdrawal-cancel.js';
import { PayoutAccountUseCase } from './application/payout-accounts.js';
import { ScanChainDepositsUseCase } from './application/chain-deposit.js';

export interface PaymentsModuleConfig {
  /** 时钟注入（缺省 = walletModule.clock 复用；测试可传固定时钟）。 */
  clock?: Clock;
}

export interface PaymentsModuleDeps {
  sequelize: Sequelize;
  /** wallet 模块装配产物（ledger/configReader/turnoverGate/systemIdentity 复用，不重建）。 */
  walletModule: WalletModule;
  config: PaymentsModuleConfig;
}

export interface PaymentsModule {
  // 用例（构造注入 ports，不用全局，SDD §4）
  orderCreate: OrderCreateUseCase;
  paymentEvent: PaymentEventUseCase;
  withdrawal: WithdrawalUseCase;
  withdrawalCancel: WithdrawalCancelUseCase;
  payoutAccounts: PayoutAccountUseCase;
  chainDeposit: ScanChainDepositsUseCase;

  // ports（共享实现，供测试/其他模块 mock 时参考）
  orders: OrderRepository;
  channels: ChannelRepository;
  payoutAccountsRepo: PayoutAccountRepository;
  withdrawals: WithdrawalRepository;
  paymentEvents: PaymentEventRepository;
  externalSettlements: ExternalSettlementRepository;
  identity: IdentityReader;
  chainScanner: ChainScannerPort;

  /** 无事务 outbox 兜底（用例外调用；正常路径经 `module.withTx` 取同事务版本）。 */
  outbox: OutboxPort;

  /**
   * 在事务 scope 内构建同事务 outbox port（§6.3 "所有分录/outbox 同事务"）：
   * 资金用例经 `module.withTx(scope, fn)` 把 `scope.transaction` 传入
   * `outbox.append`，随事务提交/回滚（与 wallet `withTx` 同款约定）。
   */
  withTx<T>(scope: { transaction: Transaction | null }, fn: (outbox: OutboxPort) => T | Promise<T>): Promise<T>;
}

/**
 * OutboxPort 实现（同事务直写 outbox 行，§6.3 "所有分录/outbox 同事务"；
 * 与 wallet assembly 内同款实现，payments 模块独立装配时自建一份）。
 */
class SequelizeOutboxPort implements OutboxPort {
  constructor(
    private readonly outboxModel: typeof OutboxModel,
    private readonly tx: Tx,
  ) {}

  async append(input: OutboxAppendInput): Promise<void> {
    const now = new Date();
    await this.outboxModel.create(
      {
        eventKey: input.eventKey ?? `payments-outbox:${input.topic}:${now.getTime()}:${Math.random().toString(36).slice(2)}`,
        topic: input.topic,
        userId: input.userId ?? null,
        assetOperationId: input.assetOperationId ?? null,
        payload: input.payload,
        payloadVersion: input.payloadVersion ?? 1,
        availableAt: input.availableAt ?? now,
      } as never,
      { transaction: this.tx.transaction as Transaction } as never,
    );
  }
}

export function createPaymentsModule(deps: PaymentsModuleDeps): PaymentsModule {
  const { sequelize, walletModule, config } = deps;

  // ledger / configReader / turnoverGate / systemIdentity / clock 从 walletModule 取（不重建，
  // 任务硬约定 1；outbox 端口经 wallet assembly 的 outboxPortFactory 同事务绑定）。
  const ledger: AssetLedger = walletModule.ledger;
  const configReader: ConfigReader = walletModule.configReader;
  const turnoverGate: TurnoverGateUseCase = walletModule.turnoverGate;
  const systemIdentity: SystemIdentityPort = walletModule.systemIdentity;
  const clock: Clock = config.clock ?? walletModule.clock;

  const modelSet = {
    PaymentProviderModel,
    PaymentChannelModel,
    OrderModel,
    PaymentEventModel,
    ExternalSettlementModel,
    PayoutAccountModel,
    WithdrawalModel,
    UserModel,
  };

  const orders = new SequelizeOrderRepository(modelSet);
  const channels = new SequelizeChannelRepository(modelSet);
  const payoutAccountsRepo = new SequelizePayoutAccountRepository(modelSet);
  const withdrawals = new SequelizeWithdrawalRepository(modelSet);
  const paymentEvents = new SequelizePaymentEventRepository(modelSet);
  const externalSettlements = new SequelizeExternalSettlementRepository(modelSet);
  const identity = new SequelizeIdentityReader(modelSet);
  // Mock chain scanner（首版空实现；真实 TRON 扫描未闭环，登记）。
  const chainScanner: ChainScannerPort = new MockChainScanner();

  // 同事务 outbox 工厂（与 wallet assembly 同款：把 scope.transaction 传入
  // outbox.append，随事务提交/回滚，§6.3 "所有分录/outbox 同事务"）。
  const outboxPortFactory = (tx: Tx): OutboxPort => new SequelizeOutboxPort(OutboxModel, tx);
  const defaultOutbox = outboxPortFactory({ transaction: null });

  const paymentEvent = new PaymentEventUseCase(orders, paymentEvents, externalSettlements, ledger, systemIdentity, clock);

  const orderCreate = new OrderCreateUseCase(orders, channels, configReader, clock);
  const withdrawal = new WithdrawalUseCase(
    withdrawals,
    payoutAccountsRepo,
    ledger,
    configReader,
    turnoverGate,
    identity,
    systemIdentity,
    clock,
  );
  const withdrawalCancel = new WithdrawalCancelUseCase(withdrawals, ledger, systemIdentity, clock);
  const payoutAccounts = new PayoutAccountUseCase(payoutAccountsRepo);
  const chainDeposit = new ScanChainDepositsUseCase(chainScanner, paymentEvent);

  const module: PaymentsModule = {
    orderCreate,
    paymentEvent,
    withdrawal,
    withdrawalCancel,
    payoutAccounts,
    chainDeposit,

    orders,
    channels,
    payoutAccountsRepo,
    withdrawals,
    paymentEvents,
    externalSettlements,
    identity,
    chainScanner,

    outbox: defaultOutbox,

    async withTx<T>(scope: { transaction: Transaction | null }, fn: (outbox: OutboxPort) => T | Promise<T>): Promise<T> {
      // 同事务 outbox（§6.3）：把 scope.transaction 传入 outbox.append，随事务提交/回滚。
      const tx: Tx = { transaction: scope.transaction as Transaction | undefined };
      return fn(outboxPortFactory(tx));
    },
  };

  void sequelize; // 预留（未来 payments 自有事务边界经 sequelize.transaction；
  // 首版全部资金事务经调用方 submitInTx 注入，与 wallet 路由层同款约定，登记）。

  return module;
}

/**
 * 在事务 scope 内构建 outbox port（与 wallet `outboxFor` 同款；用例调用
 * outbox.append 时同事务写 outbox 行，§6.3 "所有分录/outbox 同事务"）。
 * 用法（路由层）：`const outbox = await outboxFor(module, scope)` 后传入用例。
 */
export function outboxFor(module: PaymentsModule, tx: Tx): Promise<OutboxPort> {
  return module.withTx({ transaction: (tx.transaction as Transaction | null) ?? null }, (o) => o);
}
