/**
 * wallet 模块装配工厂（inject 全部 ports 的 WalletModule，供 server 装配调用一次）。
 *
 * 领域所有者：wallet 模块。
 * 对应 SDD 章节：后端实施 SDD §1（装配工厂 `createWalletModule({sequelize,
 * config})` 返回注入了全部 ports 的 WalletModule 对象）、§4（构造注入 ports，
 * 不用全局；锁顺序/幂等/同事务约定）、§9 实施顺序第 2 步（钱包闭环）。
 *
 * 装配模式（参考 `modules/identity/assembly.ts`）：
 * - `sequelize`：Sequelize 实例（models 已 addModels 注册，§3.2 wallet 7 model +
 *   outbox + system_config + user）；
 * - `config`：时钟注入 + 系统身份 user id（SystemIdentityPort；SYSTEM 身份行
 *   全库唯一，0002 迁移 `uq_user_system_marker`；装配期解析一次注入，决策点
 *   登记：SYSTEM 行由 identity 模块创建，首版经 config 传入 id）。
 *
 * 未闭环登记（完成报告给 Lead）：
 * - Outbox worker 未建（SDD §8 后续运维项）：OutboxPort 实现为同事务直写
 *   outbox 行（§6.3 "所有分录/outbox 同事务"），消费端在 worker 落地前无消费者；
 * - ConfigReader 首版直接读 system_config 行（configuration 模块未建，SDD §9
 *   第 7 步）：parser allowlist + 范围校验在 domain/ledger-rules.ts
 *   `parseCnyToCoinRatio`（"1:10" → 分子 1 分母 10 的整数分形式，1:10 →
 *   rateCoinUnits=10n / rateCashFen=100n；缺失/非法 → null → 用例映射
 *   EXCHANGE_NOT_AVAILABLE，任务硬约定 5）；
 * - 兑换上级客损模式门禁（双资产文档 §2）依赖 referral 模块（SDD §9 第 6 步），
 *   本步未挂接，Lead 统一验证时登记；
 * - WelcomeGiftPort 对接：本模块导出 `GrantWelcomeGiftUseCase`（实现 identity
 *   接口），装配时 `createIdentityModule` 的 `config.welcomeGift` 传
 *   `walletModule.welcomeGiftPort` 即可替换 identity 首步的 `welcomeGift: null`，
 *   打通 SDD §4 "注册 workflow 幂等调用新用户赠币"（任务硬约定 8）。
 */

import type { Sequelize, Transaction } from 'sequelize';
import { OutboxModel } from '../../infrastructure/database/models/events.js';
import { SystemConfigModel } from '../../infrastructure/database/models/game.js';

import {
  AssetAccountModel,
  AssetOperationModel,
  AssetEntryModel,
  CoinExchangeModel,
  GiftGrantModel,
  TurnoverStateModel,
} from '../../infrastructure/database/models/wallet.js';
import { UserModel } from '../../infrastructure/database/models/identity.js';

import { SequelizeWalletLedger } from './adapters/sequelize-wallet-ledger.js';

import type { AssetLedger, ConfigReader, ExchangeRate, Tx, SystemIdentityPort } from './ports/wallet-repository.js';
import type { OutboxPort, OutboxAppendInput } from './ports/outbox-port.js';
import type { Clock } from './ports/clock.js';
import { SystemClock } from './ports/clock.js';
import { parseCnyToCoinRatio } from './domain/ledger-rules.js';

import { WalletSummaryUseCase } from './application/wallet-summary.js';
import { WalletActivityUseCase } from './application/wallet-activity.js';
import { CoinTransferUseCase } from './application/transfer.js';
import { CoinExchangeUseCase } from './application/exchange.js';
import { GrantWelcomeGiftUseCase } from './application/gift-grant.js';
import { TurnoverGateUseCase } from './application/turnover.js';

import type { WelcomeGiftPort } from '../identity/ports/welcome-gift-port.js';

/** 装配配置（Lead 统一验证时按 compose env / user 行解析填入）。 */
export interface WalletModuleConfig {
  /** 时钟注入（测试可传固定时钟；缺省 SystemClock，与 identity assembly 同款约定）。 */
  clock?: Clock;
  /** 系统身份 user.id（SYSTEM 行，全库唯一；装配期解析，决策点登记）。 */
  systemUserId: string;
}

/** 装配依赖（Sequelize 实例 + 配置；模型类在装配内取，参考 identity assembly）。 */
export interface WalletModuleDeps {
  sequelize: Sequelize;
  config: WalletModuleConfig;
}

/** 全部 ports + 用例实例的 WalletModule（构造注入，不用全局，SDD §4）。 */
export interface WalletModule {
  // ports（共享实现，供测试/其他模块 mock 时参考）
  ledger: AssetLedger;
  configReader: ConfigReader;
  clock: Clock;
  systemIdentity: SystemIdentityPort;
  /** 无事务 outbox 兜底（用例外调用；正常路径经 `module.withTx` 取同事务版本）。 */
  outbox: OutboxPort;

  /**
   * 在事务 scope 内构建同事务 outbox port（§6.3 "所有分录/outbox 同事务"）：
   * 资金用例经 `module.withTx(scope, fn)` 把 `scope.transaction` 传入
   * outbox.append，随事务提交/回滚（identity 模块同款约定）。
   */
  withTx<T>(scope: { transaction: Transaction | null }, fn: (outbox: OutboxPort) => T | Promise<T>): Promise<T>;

  // 用例实例
  summary: WalletSummaryUseCase;
  activity: WalletActivityUseCase;
  transfer: CoinTransferUseCase;
  exchange: CoinExchangeUseCase;
  giftGrant: GrantWelcomeGiftUseCase;
  turnoverGate: TurnoverGateUseCase;

  /**
   * identity `WelcomeGiftPort` 适配（任务硬约定 8）：装配 identity 模块时
   * `config.welcomeGift = walletModule.welcomeGiftPort`，替换首步的 null。
   * 委托 `giftGrant.grantWelcomeGift(userId)`（按账号一次幂等，
   * gift_grant.U(grant_key) + asset_operation.operation_key 双兜底）。
   */
  welcomeGiftPort: WelcomeGiftPort;
}

/**
 * ConfigReader 实现（首版直读 system_config 行；configuration 模块（SDD §9
 * 第 7 步）落地后替换为经 configuration public API 读取，本处只改装配点）。
 * parser：`parseCnyToCoinRatio`（"1:10" → 分子 1 / 分母 10 的整数分形式，
 * 任务硬约定 5；缺失/非法 → null，用例映射 EXCHANGE_NOT_AVAILABLE）。
 */
class SequelizeConfigReader implements ConfigReader {
  constructor(
    private readonly systemConfigModel: typeof SystemConfigModel,
    private readonly sequelize: Sequelize,
  ) {}

  async readExchangeRate(tx?: Tx): Promise<ExchangeRate | null> {
    const row = await this.systemConfigModel.findOne({
      where: { configKey: 'cny_to_coin_ratio', status: 1 },
      transaction: tx?.transaction as Transaction | undefined,
    } as never);
    if (row === null) return null;
    // parser allowlist + 范围校验（domain/ledger-rules.ts；"1:10" → 10n/100n）。
    return parseCnyToCoinRatio(row.configValue);
  }
}

/**
 * OutboxPort 实现：同事务直写 outbox 行（§6.3 "领域事务 → 同事务写 outbox"；
 * 首版 worker 未建，登记 topic 消费端待补；outbox.asset_operation_id 关联
 * 资金操作，FK RESTRICT 由 0018 迁移管理）。
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
        eventKey: input.eventKey ?? `outbox:${input.topic}:${now.getTime()}:${Math.random().toString(36).slice(2)}`,
        topic: input.topic,
        userId: input.userId ?? null,
        assetOperationId: input.assetOperationId ?? null,
        payload: input.payload,
        payloadVersion: input.payloadVersion ?? 1,
        availableAt: input.availableAt ?? now,
        // 缺省项（attempts=0 等）由 model 默认值兜底；此处只登记必填项。
      } as never,
      { transaction: this.tx.transaction as Transaction } as never,
    );
  }
}

/** 系统身份端口实现（装配期解析一次注入；SYSTEM 行 user.id 十进制字符串 wire）。 */
class FixedSystemIdentity implements SystemIdentityPort {
  constructor(readonly systemUserId: string) {}
}

/**
 * 装配 wallet 模块（调用一次；返回注入全部 ports 的 WalletModule）。
 * 由 apps/server bootstrap 或测试装配调用；与 `createIdentityModule` 同进程
 * 共享 Sequelize 实例（models 已 addModels 注册，§3.2 归属矩阵）。
 */
export function createWalletModule(deps: WalletModuleDeps): WalletModule {
  const { sequelize, config } = deps;
  const clock = config.clock ?? new SystemClock();

  // --- 共享 ports 实现（装配内构建一次，用例共享，不各自 new） ---
  const ledger = new SequelizeWalletLedger(
    {
      AssetAccountModel,
      AssetOperationModel,
      AssetEntryModel,
      CoinExchangeModel,
      GiftGrantModel,
      TurnoverStateModel,
    },
    { UserModel },
  );

  const configReader = new SequelizeConfigReader(SystemConfigModel, sequelize);
  const systemIdentity = new FixedSystemIdentity(config.systemUserId);

  // outbox 事务工厂：把 tx 传入 SequelizeOutboxPort（§6.3 同事务 outbox）；
  // 缺省无事务实现供"用例外"调用（测试）；正常路径经 withTx 注入（identity 同款）。
  const outboxPortFactory = (tx: Tx): OutboxPort => new SequelizeOutboxPort(OutboxModel, tx);
  const defaultOutbox = outboxPortFactory({ transaction: null });

  // --- 用例实例（构造注入 ports；不用全局，SDD §4） ---
  const summary = new WalletSummaryUseCase(ledger);
  const activity = new WalletActivityUseCase(ledger);
  const transfer = new CoinTransferUseCase(ledger, configReader, clock, systemIdentity);
  const exchange = new CoinExchangeUseCase(ledger, configReader, clock, systemIdentity);
  const giftGrant = new GrantWelcomeGiftUseCase(ledger, systemIdentity, clock, defaultOutbox, sequelize);
  const turnoverGate = new TurnoverGateUseCase(ledger);

  // identity WelcomeGiftPort 适配（任务硬约定 8；替换 identity 首步 null 注入）。
  const welcomeGiftPort: WelcomeGiftPort = {
    grantWelcomeGift(userId: string): Promise<void> {
      return giftGrant.grantWelcomeGift(userId);
    },
  };

  const module: WalletModule = {
    ledger,
    configReader,
    clock,
    systemIdentity,
    outbox: defaultOutbox,
    summary,
    activity,
    transfer,
    exchange,
    giftGrant,
    turnoverGate,
    welcomeGiftPort,

    async withTx<T>(scope: { transaction: Transaction | null }, fn: (outbox: OutboxPort) => T | Promise<T>): Promise<T> {
      // 同事务 outbox（§6.3）：把 scope.transaction 传入 outbox.append，随事务提交/回滚。
      const tx: Tx = { transaction: scope.transaction as Transaction | undefined };
      return fn(outboxPortFactory(tx));
    },
  };

  return module;
}

/**
 * 在事务 scope 内构建 outbox port（用例调用 outbox.append 时同事务写 outbox 行，
 * §6.3 "所有分录/outbox 同事务"）。
 * 用法（路由层）：`const outbox = await outboxFor(module, scope)` 后传入用例 submit。
 */
export function outboxFor(module: WalletModule, tx: Tx): Promise<OutboxPort> {
  return module.withTx({ transaction: (tx.transaction as Transaction | null) ?? null }, (o) => o);
}
