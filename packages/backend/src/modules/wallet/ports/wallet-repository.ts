/**
 * wallet 仓储端口（asset_account / asset_operation / asset_entry / asset_hold /
 * coin_exchange / gift_grant / turnover_state + system_config 读取）。
 *
 * 领域所有者：wallet 模块（adapters/sequelize-wallet-ledger.ts 实现 AssetLedger；
 * assembly.ts 内实现 ConfigReader；ports/clock.ts 的 SystemClock 为 Clock 生产实现）。
 * 对应 SDD 章节：后端实施 SDD §4（用例与端口；事务/幂等/审计约定：锁顺序
 * `sender account → receiver account → hold`（按 asset_account.id 数值升序
 * SELECT ... FOR UPDATE）；幂等先抢 `asset_operation.operation_key` 唯一约束，
 * committed_at 非空 = 已成功可重放；所有分录/outbox 同事务）、§3.2 实体归属
 * 矩阵（wallet owns 7 表）、附录 A.3（wallet 7 model）。
 *
 * 约定（SDD §2 第 2 条）：
 * - 金额/ID 全链路 BigInt 计算，wire 十进制字符串（row-mapper 完成跨层格式化，
 *   本端口出入参已是字符串/BigInt 业务单位——金币为枚、CNY 为分）；
 * - `Tx` 为 Sequelize 事务句柄鸭子类型（与 identity 模块同款约定），用例内所有
 *   写操作共享同一事务（回滚即整事务回滚）；
 * - 不可变表（asset_operation/asset_entry/coin_exchange/gift_grant）只提供
 *   append 路径，update/destroy 由 model hooks 拦截（_shared.ts A.12 第 5 条）。
 *
 * 错误码语义（contracts `WalletErrorCode`，HTTP 边界映射见各用例文件头注释）：
 * - `IDEMPOTENCY_KEY_REUSED`：operation_key 命中但 request_hash 不同（同键异内容）。
 * - `WALLET_STORAGE_UNAVAILABLE`：Sequelize 故障 / 账户行缺失（未开户）/ 乐观
 *   version 冲突（无法重放）。
 */

import type {
  AssetAccountModel,
  AssetOperationModel,
  AssetHoldModel,
  CoinExchangeModel,
  GiftGrantModel,
  TurnoverStateModel,
} from '../../../infrastructure/database/models/wallet.js';
import type { UserModel as IdentityUserModel } from '../../../infrastructure/database/models/identity.js';
import type { AssetType, AccountType } from '../../../infrastructure/database/models/wallet.js';

/** 事务句柄（Sequelize Transaction 鸭子类型；与 identity 模块 `Tx` 结构一致）。 */
export interface Tx {
  transaction?: unknown;
}

/**
 * 资产操作类型本地引用（models/wallet.ts `AssetOperationType` 子集；
 * 1~14 全量常量在 model 文件登记，本处只取 wallet 用例用到的 1~3）。
 */
export const WalletOperationType = {
  TRANSFER: 1,
  COIN_EXCHANGE: 2,
  GIFT_GRANT: 3,
  ORDER_FULFILLMENT: 5,
  WITHDRAWAL_HOLD: 6,
  WITHDRAWAL_SETTLEMENT: 7,
  WITHDRAWAL_RELEASE: 8,
} as const;
export type WalletOperationTypeValue = (typeof WalletOperationType)[keyof typeof WalletOperationType];

/** 分录类型常量（asset_entry.entry_type：INTERNAL=1/EXTERNAL=2/HOLD=3/COMPENSATION=4，
 * models/wallet.ts EntryType 全量；payments 模块充值履约/提现占款/释放用例经此扩展使用）。 */
export const WalletEntryType = { INTERNAL: 1, EXTERNAL: 2, HOLD: 3, COMPENSATION: 4 } as const;

/** 舍入模式常量（coin_exchange.rounding_type：CEIL_CHARGE=1/FLOOR_CREDIT=2）。 */
export const WalletRoundingMode = { CEIL_CHARGE: 1, FLOOR_CREDIT: 2 } as const;

/** 流水状态常量（turnover_state.status：ACTIVE=1/COMPLETE=2/REVERSED=3）。 */
export const WalletTurnoverStatus = { ACTIVE: 1, COMPLETE: 2, REVERSED: 3 } as const;

/** 账户资产类型取值（AssetType：COIN=1/CNY_BALANCE=2，models/wallet.ts 常量）。 */
export type AssetTypeValue = (typeof AssetType)[keyof typeof AssetType];
/** 账户主体类型取值（AccountType：PLAYER=1/SYSTEM=2）。 */
export type AccountTypeValue = (typeof AccountType)[keyof typeof AccountType];

/** 流水判定结果（summary/提现/转出共用；remainingCoins 十进制字符串 wire）。 */
export interface TurnoverState {
  /** 仍须完成的有效下注额（分单位 = 金币枚数；0 表示已完成）。 */
  remainingCoins: string;
  /** remainingCoins == 0 且行存在（或无行）时为 true；无行 = 无流水要求 = true。 */
  canTransferOrWithdraw: boolean;
}

/**
 * 资产账本端口（asset_account 读/锁/入账 + asset_operation 抢键 + asset_entry 追加 +
 * coin_exchange/gift_grant/turnover_state 快照写入 + user 昵称读取）。
 * 全部方法要求在同一事务 scope 内调用（`tx` 显式传入，用例不隐式持库）。
 */
export interface AssetLedger {
  /**
   * 幂等抢键：INSERT asset_operation（operation_key 唯一约束先抢，§4）。
   * - 新键成功 → `{ inserted: true }`（同事务后续记账，最后 setCommitted）。
   * - 键已存在且 request_hash 一致、committed_at 非空 → 重放原操作行
   *   （`{ inserted: false, operation }`，用例据此返回原结果快照，不产生第二笔）。
   * - 键已存在且 request_hash 不一致 → 抛 `IDEMPOTENCY_KEY_REUSED`。
   * - 键已存在、request_hash 一致但 committed_at 为空（前次事务未提交残留）
   *   → 抛 `WALLET_STORAGE_UNAVAILABLE`（首版不静默复用，登记决策点）。
   */
  claimOperation(input: {
    operationKey: string;
    operationType: number;
    requestHash: Uint8Array;
    initiatedByUserId: string | null;
    extra: Record<string, unknown> | null;
    reason: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; operation: AssetOperationModel }>;

  /** 事务提交点回填 committed_at + result_snapshot（资金事务成功提交的业务时间，UTC）。 */
  setCommitted(operationId: string, committedAt: Date, resultSnapshot: Record<string, unknown>, tx: Tx): Promise<void>;

  /** 读结果快照（重放原结果用；committed_at 非空时非空）。 */
  getOperationResultSnapshot(operationId: string, tx: Tx): Promise<Record<string, unknown> | null>;

  /**
   * 按账户 id 数值升序逐条 SELECT ... FOR UPDATE（锁顺序
   * `sender → receiver → hold` 由用例按 asset_account.id 数值升序组装传入，
   * 防死锁，§4）。返回与入参顺序一致的行；任一账户缺失（未开户）抛
   * WALLET_STORAGE_UNAVAILABLE（adapter 映射后由用例捕获）。
   */
  lockAccountsByIds(accountIds: string[], tx: Tx): Promise<AssetAccountModel[]>;

  /** 读账户行（无锁；summary/报价类查询）。缺失返回 null。 */
  readAccount(userId: string, assetType: AssetTypeValue, accountType: AccountTypeValue, tx?: Tx): Promise<AssetAccountModel | null>;

  /**
   * 账户入账（乐观 version 冲突判定 + 分录追加；同账户同 account_version 唯一
   * 约束兜底，A.3 `U(asset_account_id, account_version)`）：
   * - 逐账户更新 amount/frozen_amount + version+1（WHERE version = 锁读版本，
   *   影响行数 0 = 乐观冲突 → 抛 WALLET_STORAGE_UNAVAILABLE）；
   * - 逐笔 append asset_entry（entry_seq 从 1 起，U(operation, seq)；
   *   同一账户多笔 delta 按序计算 amount_after/frozen_after 与 account_version）。
   * 金额不变量（delta 符号、frozen 范围、双账本守恒）由用例层 domain 纯函数
   * 校验（见 `domain/`），本方法只做落库。
   */
  postEntries(operationId: string, intents: EntryIntent[], tx: Tx): Promise<LedgerPost[]>;

  /** 追加 coin_exchange 快照（不可变；U(asset_operation_id)、U(preview_key) 兜底）。 */
  appendCoinExchange(input: {
    userId: string;
    assetOperationId: string;
    /** 用户扣除金币（有符号，此处为负）。 */
    coins: bigint;
    /** 用户增加人民币分（有符号，此处为正）。 */
    cashCents: bigint;
    feeCents: bigint;
    rateCoinUnits: bigint;
    rateCashFen: bigint;
    roundingType: number;
    previewKey: string;
    tx: Tx;
  }): Promise<CoinExchangeModel>;

  /** 追加 gift_grant 快照（不可变；U(grant_key) 幂等兜底，赠币按账号一次）。 */
  appendGiftGrant(input: {
    userId: string;
    assetOperationId: string;
    orderId: string | null;
    grantKey: string;
    coins: bigint;
    /** DECIMAL(12,4) wire 十进制字符串（默认 '5'）。 */
    turnoverMultiplier: string;
    requiredTurnoverCoins: bigint;
    tx: Tx;
  }): Promise<GiftGrantModel>;

  /** 读流水状态行（每人至多一行；缺失 = 无流水要求，返回 null）。 */
  readTurnoverState(userId: string, tx?: Tx): Promise<TurnoverStateModel | null>;

  /**
   * 流水状态 upsert（remaining_coins 累加、version 乐观锁；A.3 `U(user_id)`）：
   * - 无行 → 创建（remaining = required，version = 1，status = ACTIVE）；
   * - 有行 → remaining 累加 required（status 回 ACTIVE），version+1。
   * 乐观冲突（version ≠ 锁读版本）抛 WALLET_STORAGE_UNAVAILABLE。
   */
  upsertTurnoverState(userId: string, requiredCoins: bigint, expectedVersion: bigint | null, tx: Tx): Promise<TurnoverStateModel>;

  /** 读用户昵称（transfer 报价的 recipientDisplayName；缺失返回 null）。 */
  readNickname(userId: string, tx?: Tx): Promise<string | null>;

  /** 读用户行（RECIPIENT_NOT_FOUND/SELF 门禁 + 状态检查；缺失返回 null）。 */
  readUser(userId: string, tx?: Tx): Promise<IdentityUserModel | null>;

  /** 流水判定（无行 = null，即"无流水要求"，转账/提现不受限）。 */
  getTurnover(userId: string, tx?: Tx): Promise<TurnoverState | null>;

  /** 读欢迎赠币快照（gift_grant 按 grant_key = welcome:{userId} 唯一；未赠 = null）。 */
  readWelcomeGift(userId: string, tx?: Tx): Promise<{ coins: string; turnoverRequirement: string } | null>;

  // ------------------------------------------------------------------
  // 占款（asset_hold；§9 第 3 步 payments 模块提现占款扩展，任务硬约定 1
  // "AssetLedger 缺方法在 wallet ports 接口加方法"——实现类已有通用
  // postEntries 但无 hold 专用路径，本扩展补 3 方法，不破坏既有实现）
  // ------------------------------------------------------------------

  /**
   * 创建占款行（asset_hold；`U(hold_key)` 幂等兜底——同键重放返回既有行，
   * 不抛 IDEMPOTENCY_KEY_REUSED，占款与 WITHDRAWAL_HOLD=6 分录同事务调用，
   * 双资产文档 §4 "申请时原子占款 净到账额 + 手续费"）。
   * 金额：`amount = remaining = cents`（十进制字符串 wire，CNY 分）。
   * HoldStatus 默认 OPEN=1；生命周期状态由 releaseHold/consumeHold 推进。
   */
  createHold(input: {
    assetOperationId: string;
    assetAccountId: string;
    holdKey: string;
    holdType: number;
    amount: string;
    expiresAt?: Date | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; hold: AssetHoldModel }>;

  /**
   * 释放占款（HoldStatus RELEASED=4；remaining → 0、closed_at 回填；
   * 幂等：已 RELEASED 行重放静默返回既有行，不重复写分录——分录由
   * 调用方（WITHDRAWAL_RELEASE=8 反向分录）经 postEntries 完成，
   * 本方法只推进 hold 行状态，双资产文档 §4 "拒绝/取消/失败幂等释放"）。
   */
  releaseHold(holdId: string, tx: Tx): Promise<AssetHoldModel>;

  /**
   * 消耗占款（出款成功 SUCCEEDED：remaining → 0、HoldStatus CONSUMED=3、
   * closed_at 回填；幂等同 releaseHold，双资产文档 §4 "确认支付成功才将
   * 占款转为完成扣款"——WITHDRAWAL_SETTLEMENT=7 分录同事务）。
   * 首版出款 worker 未闭环，本方法为消费侧预留（登记决策点）。
   */
  consumeHold(holdId: string, tx: Tx): Promise<AssetHoldModel>;
}

/** 分录记账意图（一次资产账户 delta；金额单位：金币枚 / CNY 分；BigInt）。 */
export interface EntryIntent {
  accountId: string;
  /** 资产总额变动（有符号）。 */
  delta: bigint;
  /** 冻结额变动（有符号；冻结释放不增加总额；普通转账/兑换/赠币 = 0）。 */
  frozenDelta: bigint;
  /** EntryType：INTERNAL=1（用户间内部转账；系统账户侧走 EXTERNAL=2，
   * payments 模块落地后扩展，首版用户侧恒 1）。 */
  entryType: number;
  /** 分录可读说明（memo VARCHAR(500)）。 */
  memo: string;
}

/** 入账结果（账户新版本 + 记账后余额，供用例守恒校验与分录对账）。 */
export interface LedgerPost {
  accountId: string;
  version: bigint;
  amount: bigint;
  frozenAmount: bigint;
}

/** 兑换汇率（整数分形式；`cny_to_coin_ratio` 解析结果，双资产文档 §2
 * "按分子/分母解析为整数分"：`1:10` → rateCoinUnits=10n / rateCashFen=100n）。 */
export interface ExchangeRate {
  /** 金币整数分子。 */
  rateCoinUnits: bigint;
  /** 人民币分分母（元 × 100）。 */
  rateCashFen: bigint;
}

/**
 * 配置读取端口（system_config 运行时解析归 configuration 模块 parser allowlist；
 * wallet 经本端口读，不直接查表，SDD §4 "ConfigReader 端口：parser allowlist
 * + 范围校验"）。实现见 assembly.ts（Sequelize 直读 system_config 行 + 格式解析）。
 * 配置缺失/非法 → 调用方（用例）映射 `EXCHANGE_NOT_AVAILABLE`。
 */
export interface ConfigReader {
  /** 读兑换汇率；无有效配置或格式非法返回 null。 */
  readExchangeRate(tx?: Tx): Promise<ExchangeRate | null>;
}

/**
 * 系统身份端口（全库唯一 SYSTEM user 行，role_type & 8，0002 迁移
 * `uq_user_system_marker` 保证唯一；双资产文档 §2 "系统账户为资产来源/归宿"）。
 * 装配时解析一次注入（identity 模块落地后读 user 行；首版可用配置传入）。
 */
export interface SystemIdentityPort {
  /** 系统身份 user.id（十进制字符串 wire）。 */
  readonly systemUserId: string;
}

/** 用例上下文（身份/会话由路由层解析后传入；wallet 用例不做认证）。 */
export interface WalletContext {
  /** 发起玩家 user.id（十进制字符串 wire）。 */
  userId: string;
}
