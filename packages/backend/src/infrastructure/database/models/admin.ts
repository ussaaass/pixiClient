/**
 * admin — 管理与审计：`agent_domain` / `admin_permission` / `admin_audit_event`（不可变）/
 * `agent_audit_event`（不可变）。
 *
 * 领域所有者：admin 模块（models/admin.ts 为其唯一 model 定义）。
 * 对应 SDD 章节：后端实施SDD 附录 A.6；数据库设计SDD §5.2.1（agent_domain）与 §5.8
 * （admin_permission / agent_audit_event / admin_audit_event）。
 * DDL 以迁移 0009-create-admin-audit.ts 为准。
 *
 * 读写用例：
 * - `AgentDomainModel`：已获批普通用户拥有的运营权限与数据隔离范围（U(user_id)；
 *   capabilities JSON 为已授予 capability code 数组）；AgentDomainStatus 1~5 状态机。
 * - `AdminPermissionModel`：后台操作权限目录（permission_code U、(http_method,path_pattern) U）。
 * - `AdminAuditEventModel`（不可变）：Admin 操作审计事实；多目标引用列
 *   （withdrawal/system_config/game_config/referral_binding_event/support_conversation/
 *   coin_market_trade，FK 由 0009/0015/0016 分批补建）；system_config_id 与
 *   game_config_id 互斥（CHECK 强制）。
 * - `AgentAuditEventModel`（不可变）：代理后台敏感数据读取与运营操作审计
 *   （request_key U；resource_key 不作为外键）。
 *
 * 两张审计事件表均满足：status 固定 RECORDED=1、updated_at=created_at、
 * deleted_at 恒 NULL（迁移 CHECK + append-only hooks）。
 */

import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';
import {
  appendOnlyHooks,
  appendOnlyModelOptions,
  standardTableOptions,
  binaryDataType,
  type ModelInitFn,
  type ModelInitOptions,
} from './_shared.js';

// ---------------------------------------------------------------------------
// agent_domain
// ---------------------------------------------------------------------------

/**
 * `agent_domain` 表属性。一个用户至多一个代理域（U(user_id)）；
 * 撤销后实体保留供审计（不删除，revoked_at 记录时刻）。
 */
export interface AgentDomainModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 代理域所有者，关联统一 user；该用户仍使用原 user ID 登录。 */
  userId: string;
  /** JSON：Admin 已授予的 capability code 字符串数组，不存任意 path/script。 */
  capabilities: string[];
  /** Admin 批准时间。 */
  approvedAt: Date | string | null;
  /** 最近一次暂停时间。 */
  suspendedAt: Date | string | null;
  /** 撤销时间；实体保留供审计。 */
  revokedAt: Date | string | null;
}

export type AgentDomainModelCreationAttributes = Optional<
  AgentDomainModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class AgentDomainModel
  extends Model<AgentDomainModelAttributes, AgentDomainModelCreationAttributes>
  implements AgentDomainModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  userId!: string;
  capabilities!: string[];
  approvedAt!: Date | string | null;
  suspendedAt!: Date | string | null;
  revokedAt!: Date | string | null;
  static associate(models: { AgentDomainModel: typeof AgentDomainModel }): void {
    void models.AgentDomainModel;
    // user 侧 FK（RESTRICT）在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// admin_permission
// ---------------------------------------------------------------------------

/** `admin_permission` 表属性。权限目录：permission_code U；(http_method,path_pattern) U。 */
export interface AdminPermissionModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 权限码，如 wallet.adjust。 */
  permissionCode: string;
  /** 权限名称。 */
  name: string;
  /** 路由方法，如 GET、POST、PATCH、DELETE（VARCHAR(12)）。 */
  httpMethod: string;
  /** 后台 API 路由模板，如 /api/admin/users/:user_id；不含 query string。 */
  pathPattern: string;
}

export type AdminPermissionModelCreationAttributes = Optional<
  AdminPermissionModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class AdminPermissionModel
  extends Model<AdminPermissionModelAttributes, AdminPermissionModelCreationAttributes>
  implements AdminPermissionModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  permissionCode!: string;
  name!: string;
  httpMethod!: string;
  pathPattern!: string;
  static associate(models: { AdminPermissionModel: typeof AdminPermissionModel }): void {
    void models.AdminPermissionModel;
  }
}

// ---------------------------------------------------------------------------
// admin_audit_event（不可变）
// ---------------------------------------------------------------------------

/**
 * `admin_audit_event` 表属性（不可变审计事实）。status 固定 RECORDED=1；
 * updated_at 固定等于 created_at；deleted_at 恒 NULL（迁移 CHECK）。
 * 目标引用列中 withdrawal_id / referral_binding_event_id / support_conversation_id /
 * coin_market_trade_id 外键分别待 0015/0012/0015/0016 补建；
 * system_config_id 与 game_config_id 互斥（CHECK 强制）。
 */
export interface AdminAuditEventModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 管理操作人，引用 user.id。 */
  adminUserId: string;
  /** Redis 后台会话的不透明审计关联键，不作为外键。 */
  adminSessionKey: string | null;
  /** 涉及的玩家，引用 user.id。 */
  userId: string | null;
  /** 本次权限/账号管理操作的目标管理员，引用 user.id。 */
  targetAdminUserId: string | null;
  /** 资产操作，引用 asset_operation.id。 */
  assetOperationId: string | null;
  /** 审核提现；外键待 0010/0015 补建。 */
  withdrawalId: string | null;
  /** 本次改动的全局配置记录，引用 system_config.id。 */
  systemConfigId: string | null;
  /** 本次改动的游戏配置记录，引用 game_config.id。 */
  gameConfigId: string | null;
  /** 涉及的代理域；代理域授权、广播或域配置操作使用。 */
  agentDomainId: string | null;
  /** 管理换绑事件；外键待 0012 补建。 */
  referralBindingEventId: string | null;
  /** 客服分派、消息管理或人工账号恢复对应的客服会话；外键待 0015 补建。 */
  supportConversationId: string | null;
  /** 集市争议裁决、延期或复核对应的成交；外键待 0016 补建。 */
  coinMarketTradeId: string | null;
  /** 请求与操作关联值。 */
  requestKey: string;
  /** 权限对应动作码。 */
  actionCode: string;
  /** 操作结果：SUCCESS=1/DENIED=2/FAILED=3（与 contracts AgentAuditResultType 一致）。 */
  resultType: number;
  /** 操作理由及失败说明。 */
  reason: string;
  /** 脱敏前后数据与关联对象。 */
  snapshot: Record<string, unknown>;
  /** BINARY(32)：访问 IP 带密钥摘要。 */
  ipHash: Uint8Array;
}

export type AdminAuditEventModelCreationAttributes = Optional<
  AdminAuditEventModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class AdminAuditEventModel
  extends Model<AdminAuditEventModelAttributes, AdminAuditEventModelCreationAttributes>
  implements AdminAuditEventModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  adminUserId!: string;
  adminSessionKey!: string | null;
  userId!: string | null;
  targetAdminUserId!: string | null;
  assetOperationId!: string | null;
  withdrawalId!: string | null;
  systemConfigId!: string | null;
  gameConfigId!: string | null;
  agentDomainId!: string | null;
  referralBindingEventId!: string | null;
  supportConversationId!: string | null;
  coinMarketTradeId!: string | null;
  requestKey!: string;
  actionCode!: string;
  resultType!: number;
  reason!: string;
  snapshot!: Record<string, unknown>;
  ipHash!: Uint8Array;
  static associate(models: { AdminAuditEventModel: typeof AdminAuditEventModel }): void {
    void models.AdminAuditEventModel;
    // admin_user / user / target_admin / asset_operation / system_config / game_config / agent_domain 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// agent_audit_event（不可变）
// ---------------------------------------------------------------------------

/**
 * `agent_audit_event` 表属性（不可变审计事实）。status 固定 RECORDED=1；
 * updated_at 固定等于 created_at；deleted_at 恒 NULL（迁移 CHECK）。
 * request_key U；resource_key 只标识资源，不作为外键。
 */
export interface AgentAuditEventModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 操作所属代理域，引用 agent_domain.id。 */
  agentDomainId: string;
  /** 代理操作者，关联统一 user。 */
  userId: string;
  /** 已登记动作，如 DOWNLINE_DETAIL_READ/PRIVATE_MESSAGE_READ/CONFIG_PUBLISH。 */
  actionCode: string;
  /** 目标资源类型，如 SOCIAL_CONVERSATION/ASSET_OPERATION/ROUND。 */
  resourceType: string;
  /** 目标资源标识；不作为任意表外键。 */
  resourceKey: string;
  /** 读取私聊/导出等敏感操作的业务目的或工单引用。 */
  purpose: string;
  /** 一次后台请求的幂等审计键（U(request_key)）。 */
  requestKey: string;
  /** 操作结果：SUCCESS=1/DENIED=2/FAILED=3。 */
  resultType: number;
  /** 脱敏查询条件/影响计数；不得含消息正文或认证秘密。 */
  snapshot: Record<string, unknown>;
  /** BINARY(32)：操作来源 IP 的带密钥摘要。 */
  ipHash: Uint8Array;
}

export type AgentAuditEventModelCreationAttributes = Optional<
  AgentAuditEventModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class AgentAuditEventModel
  extends Model<AgentAuditEventModelAttributes, AgentAuditEventModelCreationAttributes>
  implements AgentAuditEventModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  agentDomainId!: string;
  userId!: string;
  actionCode!: string;
  resourceType!: string;
  resourceKey!: string;
  purpose!: string;
  requestKey!: string;
  resultType!: number;
  snapshot!: Record<string, unknown>;
  ipHash!: Uint8Array;
  static associate(models: { AgentAuditEventModel: typeof AgentAuditEventModel; AgentDomainModel: typeof AgentDomainModel }): void {
    AgentAuditEventModel.belongsTo(models.AgentDomainModel, {
      foreignKey: 'agent_domain_id',
      as: 'agentDomain',
      constraints: false,
    });
    // user 侧 FK（RESTRICT）在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// 状态/类型常量（本地常量；单一来源在 @gameing/contracts 落地后迁移）
// ---------------------------------------------------------------------------

/** AgentDomainStatus：代理域状态机。 */
export const AgentDomainStatus = {
  PENDING_REVIEW: 1,
  ACTIVE: 2,
  SUSPENDED: 3,
  REVOKED: 4,
  WITHDRAWN: 5,
} as const;
export type AgentDomainStatusValue = (typeof AgentDomainStatus)[keyof typeof AgentDomainStatus];

/** RecordStatus：不可变审计行固定 1（本地常量，单一来源在 contracts 落地后统一）。 */
export const RecordStatus = { RECORDED: 1 } as const;
export type RecordStatusValue = (typeof RecordStatus)[keyof typeof RecordStatus];

/** AuditResultType：审计操作结果（与 contracts AgentAuditResultType 数值一致）。 */
export const AuditResultType = { SUCCESS: 1, DENIED: 2, FAILED: 3 } as const;
export type AuditResultTypeValue = (typeof AuditResultType)[keyof typeof AuditResultType];

/** ActiveStatus：行工作状态（多文件共用，单一来源在 contracts 落地后统一）。 */
export const ActiveStatus = { ACTIVE: 1, DISABLED: 2, RETIRED: 3 } as const;
export type ActiveStatusValue = (typeof ActiveStatus)[keyof typeof ActiveStatus];

export function register_AgentDomainModel(sequelize: Sequelize): void {
  (AgentDomainModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '代理域状态，取值见 AgentDomainStatus：PENDING_REVIEW=1/ACTIVE=2/SUSPENDED=3/REVOKED=4/WITHDRAWN=5',
      },
      userId: {
        field: 'user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '代理域所有者，关联统一 user；该用户仍使用原 user ID 登录',
      },
      capabilities: {
        type: DataTypes.JSON,
        allowNull: false,
        comment: 'Admin 已授予的 capability code 字符串数组，不存任意 path/script',
      },
      approvedAt: {
        field: 'approved_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Admin 批准时间，UTC',
      },
      suspendedAt: {
        field: 'suspended_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最近一次暂停时间，UTC',
      },
      revokedAt: {
        field: 'revoked_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '撤销时间；实体保留供审计，UTC',
      },
    },

    {
      ...standardTableOptions('agent_domain'),
      comment: '已获批普通用户拥有的运营权限与数据隔离范围，不表示独立账号',
      sequelize,
    } as unknown as ModelInitOptions<AgentDomainModel>,
  );
}

export function register_AdminPermissionModel(sequelize: Sequelize): void {
  (AdminPermissionModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '权限行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      },
      permissionCode: {
        field: 'permission_code',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '权限码，如 wallet.adjust',
      },
      name: { type: DataTypes.STRING(100), allowNull: false, comment: '权限名称' },
      httpMethod: {
        field: 'http_method',
        type: DataTypes.STRING(12),
        allowNull: false,
        comment: '路由方法，如 GET、POST、PATCH、DELETE',
      },
      pathPattern: {
        field: 'path_pattern',
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: '后台 API 路由模板，如 /api/admin/users/:user_id；不含 query string',
      },
    },

    {
      ...standardTableOptions('admin_permission'),
      comment: '后台操作权限',
      sequelize,
    } as unknown as ModelInitOptions<AdminPermissionModel>,
  );
}

export function register_AdminAuditEventModel(sequelize: Sequelize): void {
  (AdminAuditEventModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '事件状态，固定为 RecordStatus.RECORDED=1，审计事实不可改写',
      },
      adminUserId: {
        field: 'admin_user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '管理操作人，引用 user.id',
      },
      adminSessionKey: {
        field: 'admin_session_key',
        type: DataTypes.CHAR(36),
        allowNull: true,
        comment: 'Redis 后台会话的不透明审计关联键，不作为外键',
      },
      userId: {
        field: 'user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '涉及的玩家，引用 user.id',
      },
      targetAdminUserId: {
        field: 'target_admin_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '本次权限/账号管理操作的目标管理员，引用 user.id',
      },
      assetOperationId: {
        field: 'asset_operation_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '资产操作，引用 asset_operation.id',
      },
      withdrawalId: {
        field: 'withdrawal_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '审核提现；外键待 0010 补建（0015 执行）',
      },
      systemConfigId: {
        field: 'system_config_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '本次改动的全局配置记录，引用 system_config.id',
      },
      gameConfigId: {
        field: 'game_config_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '本次改动的游戏配置记录，引用 game_config.id',
      },
      agentDomainId: {
        field: 'agent_domain_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '涉及的代理域；代理域授权、广播或域配置操作使用',
      },
      referralBindingEventId: {
        field: 'referral_binding_event_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '管理换绑事件；外键待 0012 补建（0016 执行）',
      },
      supportConversationId: {
        field: 'support_conversation_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '客服分派、消息管理或人工账号恢复对应的客服会话；外键待 0015 补建',
      },
      coinMarketTradeId: {
        field: 'coin_market_trade_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '集市争议裁决、延期或复核对应的成交；外键待 0016 补建',
      },
      requestKey: {
        field: 'request_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '请求与操作关联值',
      },
      actionCode: {
        field: 'action_code',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '权限对应动作码',
      },
      resultType: {
        field: 'result_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '操作结果：SUCCESS=1/DENIED=2/FAILED=3',
      },
      reason: {
        type: DataTypes.STRING(500),
        allowNull: false,
        comment: '操作理由及失败说明',
      },
      snapshot: {
        type: DataTypes.JSON,
        allowNull: false,
        comment: '脱敏前后数据与关联对象',
      },
      ipHash: {
        field: 'ip_hash',
        type: binaryDataType(32),
        allowNull: false,
        comment: '访问 IP 带密钥摘要',
      },
    },

    {
      ...appendOnlyModelOptions('admin_audit_event'),
      hooks: { ...appendOnlyHooks('admin_audit_event') },
      comment: '后台不可变操作审计',
      sequelize,
    } as unknown as ModelInitOptions<AdminAuditEventModel>,
  );
}

export function register_AgentAuditEventModel(sequelize: Sequelize): void {
  (AgentAuditEventModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '事件状态，固定为 RecordStatus.RECORDED=1，审计事实不可改写',
      },
      agentDomainId: {
        field: 'agent_domain_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '操作所属代理域，引用 agent_domain.id',
      },
      userId: {
        field: 'user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '代理操作者，关联统一 user',
      },
      actionCode: {
        field: 'action_code',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '已登记动作，如 DOWNLINE_DETAIL_READ/PRIVATE_MESSAGE_READ/CONFIG_PUBLISH',
      },
      resourceType: {
        field: 'resource_type',
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '目标资源类型，如 SOCIAL_CONVERSATION/ASSET_OPERATION/ROUND',
      },
      resourceKey: {
        field: 'resource_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '目标资源标识；不作为任意表外键',
      },
      purpose: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: '读取私聊/导出等敏感操作的业务目的或工单引用',
      },
      requestKey: {
        field: 'request_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '一次后台请求的幂等审计键',
      },
      resultType: {
        field: 'result_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '操作结果：SUCCESS=1/DENIED=2/FAILED=3',
      },
      snapshot: {
        type: DataTypes.JSON,
        allowNull: false,
        comment: '脱敏查询条件/影响计数；不得含消息正文或认证秘密',
      },
      ipHash: {
        field: 'ip_hash',
        type: binaryDataType(32),
        allowNull: false,
        comment: '操作来源 IP 的带密钥摘要',
      },
    },

    {
      ...appendOnlyModelOptions('agent_audit_event'),
      hooks: { ...appendOnlyHooks('agent_audit_event') },
      comment: '代理后台敏感数据读取与运营操作的不可变审计',
      sequelize,
    } as unknown as ModelInitOptions<AgentAuditEventModel>,
  );
}
// ---------------------------------------------------------------------------
// 文件级注册器
// ---------------------------------------------------------------------------

export interface AdminModels {
  AgentDomainModel: typeof AgentDomainModel;
  AdminPermissionModel: typeof AdminPermissionModel;
  AdminAuditEventModel: typeof AdminAuditEventModel;
  AgentAuditEventModel: typeof AgentAuditEventModel;
}

/** 定义 4 个 admin model（不在此声明跨文件关联）。 */
export function initAdmin(sequelize: Sequelize, models: AdminModels): void {
  register_AgentDomainModel(sequelize);
  register_AdminPermissionModel(sequelize);
  register_AdminAuditEventModel(sequelize);
  register_AgentAuditEventModel(sequelize);
  void models;
}

/** 声明 admin 文件内的跨表关联（FK 全部 constraints: false，由迁移管理）。 */
export function associateAdmin(models: AdminModels): void {
  AgentDomainModel.associate(models);
  AdminPermissionModel.associate(models);
  AdminAuditEventModel.associate(models);
  AgentAuditEventModel.associate(models);
}
