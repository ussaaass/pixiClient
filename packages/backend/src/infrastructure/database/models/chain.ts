/**
 * chain — TRON 链到账子域：`chain_address` / `chain_deposit_event` / `chain_scan_cursor`。
 *
 * 领域所有者：payments 模块（models/chain.ts 独立便于 worker 扫描租约隔离，§3.2 链到账子域）。
 * 对应 SDD 章节：后端实施SDD 附录 A.4（chain 表）；数据库设计SDD §5.4。
 * DDL 以迁移 0011-create-chain.ts 为准。
 *
 * 读写用例：
 * - `ChainAddressModel`：USDT 订单随机分配独立 TRON 地址（每单一地址，U(order_id)）；
 *   超时/金额不符/无法唯一匹配时保留归属并转客服，不自动发币。
 * - `ChainDepositEventModel`：TRC-20 转账发现、确认与订单匹配（U(chain_code,tx_hash,event_index)）；
 *   ChainDepositStatus 1~7 状态机，含 REORGED。
 * - `ChainScanCursorModel`：扫描检查点与接管租约（fencing_token 拒绝旧进程写入；
 *   U(chain_code,scanner_key) 隔离多扫描任务）。
 *
 * 金额列 amount_atomic DECIMAL(36,0) 接口 wire 十进制字符串。
 */

import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';
import { standardTableOptions, type ModelInitFn, type ModelInitOptions } from './_shared.js';

// ---------------------------------------------------------------------------
// chain_address
// ---------------------------------------------------------------------------

/**
 * `chain_address` 表属性。地址与订单一对一绑定（U(order_id)、U(chain_code,address)）；
 * user_id 必须与 order.user_id 一致。
 */
export interface ChainAddressModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  userId: string;
  orderId: string;
  /** 含主网或测试网的链标识。 */
  chainCode: string;
  /** 规范化收款地址。 */
  address: string;
  /** 隔离签名服务引用，不是私钥。 */
  signerReference: string | null;
  assignedAt: Date | string;
}

export type ChainAddressModelCreationAttributes = Optional<
  ChainAddressModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class ChainAddressModel
  extends Model<ChainAddressModelAttributes, ChainAddressModelCreationAttributes>
  implements ChainAddressModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  userId!: string;
  orderId!: string;
  chainCode!: string;
  address!: string;
  signerReference!: string | null;
  assignedAt!: Date | string;
  static associate(models: { ChainAddressModel: typeof ChainAddressModel }): void {
    void models.ChainAddressModel;
    // user / order 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// chain_deposit_event
// ---------------------------------------------------------------------------

/**
 * `chain_deposit_event` 表属性。链上事实禁止删除（deleted_at 恒 NULL，迁移 CHECK）；
 * amount_atomic DECIMAL(36,0) 为代币最小单位整数，接口 wire 十进制字符串；
 * U(chain_code,tx_hash,event_index) 不只按 tx_hash 去重。
 */
export interface ChainDepositEventModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  chainAddressId: string;
  /** 审定匹配的商城订单；超时/金额不符/无法唯一匹配时为空并转客服。 */
  orderId: string | null;
  chainCode: string;
  txHash: string;
  /** INT UNSIGNED：同一交易日志事件位置。 */
  eventIndex: number;
  /** 白名单 USDT 合约。 */
  contractAddress: string;
  /** 付款链地址。 */
  senderAddress: string;
  /** DECIMAL(36,0)：代币最小单位整数，接口 wire 十进制字符串。 */
  amountAtomic: string;
  /** 代币精度快照。 */
  tokenDecimals: number;
  /** BIGINT UNSIGNED：所在区块高度。 */
  blockHeight: string;
  blockHash: string;
  confirmedAt: Date | string | null;
  /** JSON：固化区块、执行结果和校验依据。 */
  confirmationSnapshot: Record<string, unknown> | null;
}

export type ChainDepositEventModelCreationAttributes = Optional<
  ChainDepositEventModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class ChainDepositEventModel
  extends Model<ChainDepositEventModelAttributes, ChainDepositEventModelCreationAttributes>
  implements ChainDepositEventModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  chainAddressId!: string;
  orderId!: string | null;
  chainCode!: string;
  txHash!: string;
  eventIndex!: number;
  contractAddress!: string;
  senderAddress!: string;
  amountAtomic!: string;
  tokenDecimals!: number;
  blockHeight!: string;
  blockHash!: string;
  confirmedAt!: Date | string | null;
  confirmationSnapshot!: Record<string, unknown> | null;
  static associate(models: { ChainDepositEventModel: typeof ChainDepositEventModel; ChainAddressModel: typeof ChainAddressModel }): void {
    ChainDepositEventModel.belongsTo(models.ChainAddressModel, {
      foreignKey: 'chain_address_id',
      as: 'chainAddress',
      constraints: false,
    });
    // order 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// chain_scan_cursor
// ---------------------------------------------------------------------------

/**
 * `chain_scan_cursor` 表属性。扫描器接管租约：fencing_token 每次接管递增、旧进程写入
 * 被拒绝；last_finalized_height/fencing_token 为普通版本号允许 0。
 */
export interface ChainScanCursorModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  chainCode: string;
  /** 合约和地址集合扫描任务键（U(chain_code,scanner_key)）。 */
  scannerKey: string;
  /** BIGINT UNSIGNED：已处理固化区块高度；高度为普通数值，允许 0。 */
  lastFinalizedHeight: string;
  lastBlockHash: string | null;
  /** 当前扫描进程身份。 */
  ownerKey: string | null;
  /** BIGINT UNSIGNED：接管版本；普通版本号，允许 0 起。 */
  fencingToken: string;
  /** 接管租约期限。 */
  leaseUntil: Date | string | null;
}

export type ChainScanCursorModelCreationAttributes = Optional<
  ChainScanCursorModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class ChainScanCursorModel
  extends Model<ChainScanCursorModelAttributes, ChainScanCursorModelCreationAttributes>
  implements ChainScanCursorModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  chainCode!: string;
  scannerKey!: string;
  lastFinalizedHeight!: string;
  lastBlockHash!: string | null;
  ownerKey!: string | null;
  fencingToken!: string;
  leaseUntil!: Date | string | null;
  static associate(models: { ChainScanCursorModel: typeof ChainScanCursorModel }): void {
    void models.ChainScanCursorModel;
  }
}

// ---------------------------------------------------------------------------
// 状态/类型常量（本地常量；单一来源在 @gameing/contracts 落地后迁移）
// ---------------------------------------------------------------------------

/** ChainDepositStatus：链到账事件状态。 */
export const ChainDepositStatus = {
  SEEN: 1,
  CONFIRMING: 2,
  CONFIRMED: 3,
  MATCHED: 4,
  UNMATCHED: 5,
  FAILED: 6,
  REORGED: 7,
} as const;
export type ChainDepositStatusValue = (typeof ChainDepositStatus)[keyof typeof ChainDepositStatus];

/** ActiveStatus：行工作状态（多文件共用，单一来源在 contracts 落地后统一）。 */
export const ActiveStatus = { ACTIVE: 1, DISABLED: 2, RETIRED: 3 } as const;
export type ActiveStatusValue = (typeof ActiveStatus)[keyof typeof ActiveStatus];

export function register_ChainAddressModel(sequelize: Sequelize): void {
  (ChainAddressModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '地址行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      },
      userId: {
        field: 'user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '唯一地址归属用户，引用 user.id；必须与 order.user_id 一致',
      },
      orderId: {
        field: 'order_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '唯一绑定的 TRON 入款订单，引用 order.id；每单随机分配一个地址，地址与订单一对一',
      },
      chainCode: {
        field: 'chain_code',
        type: DataTypes.STRING(32),
        allowNull: false,
        comment: '含主网或测试网的链标识',
      },
      address: {
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '规范化收款地址',
      },
      signerReference: {
        field: 'signer_reference',
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: '隔离签名服务引用，不是私钥',
      },
      assignedAt: { field: 'assigned_at', type: DataTypes.DATE, allowNull: false, comment: '分配时刻，UTC' },
    },

    {
      ...standardTableOptions('chain_address'),
      comment: 'TRON 收款地址归属',
      sequelize,
    } as unknown as ModelInitOptions<ChainAddressModel>,
  );
}

export function register_ChainDepositEventModel(sequelize: Sequelize): void {
  (ChainDepositEventModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '链到账事件状态，取值见 ChainDepositStatus：SEEN=1/CONFIRMING=2/CONFIRMED=3/MATCHED=4/UNMATCHED=5/FAILED=6/REORGED=7',
      },
      chainAddressId: {
        field: 'chain_address_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '接收地址，引用 chain_address.id',
      },
      orderId: {
        field: 'order_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '审定匹配的商城订单，引用 order.id；超时/金额不符/无法唯一匹配时为空并转客服',
      },
      chainCode: {
        field: 'chain_code',
        type: DataTypes.STRING(32),
        allowNull: false,
        comment: '链及网络标识',
      },
      txHash: {
        field: 'tx_hash',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '链交易哈希',
      },
      eventIndex: {
        field: 'event_index',
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '同一交易日志事件位置',
      },
      contractAddress: {
        field: 'contract_address',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '白名单 USDT 合约',
      },
      senderAddress: {
        field: 'sender_address',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '付款链地址',
      },
      amountAtomic: {
        field: 'amount_atomic',
        type: DataTypes.DECIMAL(36, 0),
        allowNull: false,
        comment: '代币最小单位整数',
      },
      tokenDecimals: {
        field: 'token_decimals',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '代币精度快照',
      },
      blockHeight: {
        field: 'block_height',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '所在区块高度',
      },
      blockHash: {
        field: 'block_hash',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '区块标识',
      },
      confirmedAt: {
        field: 'confirmed_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '满足固化及成功执行条件时间，UTC',
      },
      confirmationSnapshot: {
        field: 'confirmation_snapshot',
        type: DataTypes.JSON,
        allowNull: true,
        comment: '固化区块、执行结果和校验依据',
      },
    },

    {
      ...standardTableOptions('chain_deposit_event'),
      comment: 'TRC20 转账发现确认和订单匹配',
      sequelize,
    } as unknown as ModelInitOptions<ChainDepositEventModel>,
  );
}

export function register_ChainScanCursorModel(sequelize: Sequelize): void {
  (ChainScanCursorModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '游标行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      },
      chainCode: {
        field: 'chain_code',
        type: DataTypes.STRING(32),
        allowNull: false,
        comment: '链及网络',
      },
      scannerKey: {
        field: 'scanner_key',
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '合约和地址集合扫描任务键',
      },
      lastFinalizedHeight: {
        field: 'last_finalized_height',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '已处理固化区块高度；高度为普通数值，允许 0',
      },
      lastBlockHash: {
        field: 'last_block_hash',
        type: DataTypes.STRING(128),
        allowNull: true,
        comment: '检查点区块标识',
      },
      ownerKey: {
        field: 'owner_key',
        type: DataTypes.STRING(128),
        allowNull: true,
        comment: '当前扫描进程身份',
      },
      fencingToken: {
        field: 'fencing_token',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '接管版本，旧进程写入被拒绝；普通版本号，允许 0 起',
      },
      leaseUntil: {
        field: 'lease_until',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '接管租约期限，UTC',
      },
    },

    {
      ...standardTableOptions('chain_scan_cursor'),
      comment: '链扫描检查点及接管版本',
      sequelize,
    } as unknown as ModelInitOptions<ChainScanCursorModel>,
  );
}
// ---------------------------------------------------------------------------
// 文件级注册器
// ---------------------------------------------------------------------------

export interface ChainModels {
  ChainAddressModel: typeof ChainAddressModel;
  ChainDepositEventModel: typeof ChainDepositEventModel;
  ChainScanCursorModel: typeof ChainScanCursorModel;
}

/** 定义 3 个 chain model（不在此声明跨文件关联）。 */
export function initChain(sequelize: Sequelize, models: ChainModels): void {
  register_ChainAddressModel(sequelize);
  register_ChainDepositEventModel(sequelize);
  register_ChainScanCursorModel(sequelize);
  void models;
}

/** 声明 chain 文件内的跨表关联（FK 全部 constraints: false，由迁移管理）。 */
export function associateChain(models: ChainModels): void {
  ChainAddressModel.associate(models);
  ChainDepositEventModel.associate(models);
  ChainScanCursorModel.associate(models);
}
