/**
 * identity — 身份与会话：`user` / `device` / `recovery_credential` / `user_security_event`（不可变）。
 *
 * 领域所有者：identity 模块（models/identity.ts 为其唯一 model 定义）。
 * 对应 SDD 章节：后端实施SDD 附录 A.1；数据库设计SDD §5.1（user/device/recovery_credential）
 * 与 §5.8（user_security_event）。DDL 以迁移 0002-create-user.ts 与 0007-create-identity-extensions.ts 为准。
 *
 * 读写用例：
 * - `UserModel`：auth 6 端点（注册/登录/refresh/撤销/recovery）、TOTP/联系方式管理、
 *   邀请码读取；`user` 是 MySQL 保留字风险对象，`tableName: 'user'` 由 Sequelize 自动加反引号
 *   （raw SQL 处须手工加反引号，A.12 第 7 条）。
 * - `DeviceModel`：设备识别与登录凭证轮换/撤销（auth.device-register/device-login）。
 * - `RecoveryCredentialModel`：二维码恢复凭证签发/替换/撤销（auth.recovery）。
 * - `UserSecurityEventModel`（不可变）：安全事件 append-only 写入（登录/联系/密码/恢复/撤销/TOTP），
 *   不提供 update/destroy。
 *
 * 生成列：`user.system_marker`、`recovery_credential.active_marker` 为原生 TINYINT UNSIGNED
 * GENERATED ... STORED，不声明进 attributes；接口中加注释说明生成列只读（A.12 第 6 条）。
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
// user
// ---------------------------------------------------------------------------

/**
 * `user` 表属性。公共 5 字段：id/status/created_at/updated_at/deleted_at。
 * 金额/ID 列（id/asset_id/auth_version/totp_last_accepted_counter）以十进制字符串 wire 格式承载。
 * `role_type` 为位标记：PLAYER=1/AGENT=2/ADMIN=4/SYSTEM=8，合法组合 1、3、4、8（CHECK IN (1,3,4,8)）。
 */
export interface UserModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  roleType: number;
  rewardType: number;
  publicCode: string;
  username: string | null;
  passwordHash: string | null;
  passwordSetAt: Date | string | null;
  email: string | null;
  emailVerifiedAt: Date | string | null;
  phone: string | null;
  phoneVerifiedAt: Date | string | null;
  /** VARBINARY(512)：TOTP 共享密钥认证加密密文，模型保持二进制原样（hex 化归 row-mapper）。 */
  totpSecretCiphertext: Uint8Array | null;
  totpEnabledAt: Date | string | null;
  /** BIGINT UNSIGNED：最近成功使用的 TOTP 时间步，十进制字符串 wire。 */
  totpLastAcceptedCounter: string | null;
  /** JSON：TOTP 备用码哈希数组；消费后原子移除。 */
  totpRecoveryCodeHashes: string[] | null;
  nickname: string;
  /** BIGINT UNSIGNED：头像文件引用 asset.id；外键由 0017 补建（RESTRICT）。 */
  assetId: string | null;
  /** BIGINT UNSIGNED：身份权限撤销版本，会话建立时绑定比对。 */
  authVersion: string;
  /** JSON：仅 Admin 使用的 permission_code 字符串数组，非 Admin 必须为空数组。 */
  permissions: string[];
  lastLoginAt: Date | string | null;
  inviteCode: string | null;
  inviteCodeExpiresAt: Date | string | null;
  /**
   * 生成列，只读：TINYINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN (role_type & 8)=8 AND
   * status=1 AND deleted_at IS NULL THEN 1 ELSE NULL END) STORED；不进入 model attributes，
   * 唯一索引由 DDL 层生效（A.12 第 6 条）。
   */
  /** 生成列（数据库层只读，非 TS 层 readonly）；不进 model attributes（A.12 第 6 条）。 */
  systemMarker: number | null;
}

export type UserModelCreationAttributes = Optional<UserModelAttributes, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

export class UserModel extends Model<UserModelAttributes, UserModelCreationAttributes> implements UserModelAttributes {
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  roleType!: number;
  rewardType!: number;
  publicCode!: string;
  username!: string | null;
  passwordHash!: string | null;
  passwordSetAt!: Date | string | null;
  email!: string | null;
  emailVerifiedAt!: Date | string | null;
  phone!: string | null;
  phoneVerifiedAt!: Date | string | null;
  totpSecretCiphertext!: Uint8Array | null;
  totpEnabledAt!: Date | string | null;
  totpLastAcceptedCounter!: string | null;
  totpRecoveryCodeHashes!: string[] | null;
  nickname!: string;
  assetId!: string | null;
  authVersion!: string;
  permissions!: string[];
  lastLoginAt!: Date | string | null;
  inviteCode!: string | null;
  inviteCodeExpiresAt!: Date | string | null;
  /** 生成列，只读（见 interface 注释）。 */
  systemMarker!: number | null;
  static associate(models: { UserModel: typeof UserModel }): void {
    // user 为聚合根；身份扩展表在本文件 associateIdentity 中挂接。
    void models.UserModel;
  }
}

// ---------------------------------------------------------------------------
// device
// ---------------------------------------------------------------------------

/**
 * `device` 表属性。`credential_key` 为当前设备凭证定位号，撤销后置空（U(credential_key)）。
 * `fingerprint_hash`/`device_digest`/`credential_secret_hash` 为 BINARY(32) 摘要。
 */
export interface DeviceModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  userId: string;
  fingerprintHash: Uint8Array;
  deviceDigest: Uint8Array;
  credentialKey: string | null;
  credentialSecretHash: Uint8Array | null;
  /** CredentialStatus：ACTIVE=1/REVOKED=2/EXPIRED=3；NULL=从未签发。 */
  credentialStatus: number | null;
  credentialExpiresAt: Date | string | null;
  credentialRevokedAt: Date | string | null;
  /** PlatformType：WEB=1/IOS=2/ANDROID=3/WINDOWS=4/MACOS=5/LINUX=6。 */
  platformType: number;
  lastSeenAt: Date | string | null;
}

export type DeviceModelCreationAttributes = Optional<DeviceModelAttributes, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

export class DeviceModel extends Model<DeviceModelAttributes, DeviceModelCreationAttributes> implements DeviceModelAttributes {
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  userId!: string;
  fingerprintHash!: Uint8Array;
  deviceDigest!: Uint8Array;
  credentialKey!: string | null;
  credentialSecretHash!: Uint8Array | null;
  credentialStatus!: number | null;
  credentialExpiresAt!: Date | string | null;
  credentialRevokedAt!: Date | string | null;
  platformType!: number;
  lastSeenAt!: Date | string | null;
  static associate(models: { UserModel: typeof UserModel; DeviceModel: typeof DeviceModel }): void {
    DeviceModel.belongsTo(models.UserModel, {
      foreignKey: 'user_id',
      as: 'user',
      constraints: false, // FK 由迁移 0007 管理（RESTRICT）
    });
  }
}

// ---------------------------------------------------------------------------
// recovery_credential
// ---------------------------------------------------------------------------

/**
 * `recovery_credential` 表属性。`active_marker` 生成列：status=ISSUED 且未删除为 1，
 * 唯一索引 U(user_id,active_marker) 限制每用户至多一条有效凭证。
 */
export interface RecoveryCredentialModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  userId: string;
  credentialKey: string;
  secretHash: Uint8Array;
  /**
   * 生成列（数据库层只读，非 TS 层 readonly）：TINYINT UNSIGNED GENERATED ALWAYS AS
   * (CASE WHEN status=1 AND deleted_at IS NULL THEN 1 ELSE NULL END) STORED；
   * 不进 model attributes（A.12 第 6 条）。
   */
  activeMarker: number | null;
  expiresAt: Date | string | null;
  lastUsedAt: Date | string | null;
  revokedAt: Date | string | null;
}

export type RecoveryCredentialModelCreationAttributes = Optional<
  RecoveryCredentialModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class RecoveryCredentialModel
  extends Model<RecoveryCredentialModelAttributes, RecoveryCredentialModelCreationAttributes>
  implements RecoveryCredentialModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  userId!: string;
  credentialKey!: string;
  secretHash!: Uint8Array;
  /** 生成列，只读（见 interface 注释）。 */
  activeMarker!: number | null;
  expiresAt!: Date | string | null;
  lastUsedAt!: Date | string | null;
  revokedAt!: Date | string | null;
  static associate(models: { UserModel: typeof UserModel; RecoveryCredentialModel: typeof RecoveryCredentialModel }): void {
    RecoveryCredentialModel.belongsTo(models.UserModel, {
      foreignKey: 'user_id',
      as: 'user',
      constraints: false,
    });
  }
}

// ---------------------------------------------------------------------------
// user_security_event（不可变）
// ---------------------------------------------------------------------------

/**
 * `user_security_event` 表属性（不可变安全事实流水）。
 * status 固定 RECORDED=1；updated_at 固定等于 created_at；deleted_at 恒 NULL（迁移 CHECK）。
 * event_key 为安全事件去重键（U(event_key)）；
 * action_type：LOGIN=1/CONTACT=2/PASSWORD=3/RECOVERY=4/REVOKE=5/TOTP=6；
 * result_type：SUCCESS=1/DENIED=2/FAILED=3。
 * `support_conversation_id` 外键由 0015 补建（目标表 0015 才建）。
 */
export interface UserSecurityEventModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  userId: string;
  sessionKey: string | null;
  adminSessionKey: string | null;
  adminUserId: string | null;
  deviceId: string | null;
  supportConversationId: string | null;
  /** 安全事件去重键（U(event_key)）。 */
  eventKey: string;
  /** 事件动作：LOGIN=1/CONTACT=2/PASSWORD=3/RECOVERY=4/REVOKE=5/TOTP=6。 */
  actionType: number;
  /** 事件结果：SUCCESS=1/DENIED=2/FAILED=3。 */
  resultType: number;
  /** 脱敏安全事件快照，不含密码秘密和验证码。 */
  snapshot: Record<string, unknown>;
}

export type UserSecurityEventModelCreationAttributes = Optional<
  UserSecurityEventModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class UserSecurityEventModel
  extends Model<UserSecurityEventModelAttributes, UserSecurityEventModelCreationAttributes>
  implements UserSecurityEventModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  userId!: string;
  sessionKey!: string | null;
  adminSessionKey!: string | null;
  adminUserId!: string | null;
  deviceId!: string | null;
  supportConversationId!: string | null;
  eventKey!: string;
  actionType!: number;
  resultType!: number;
  snapshot!: Record<string, unknown>;
  static associate(models: {
    UserModel: typeof UserModel;
    DeviceModel: typeof DeviceModel;
    UserSecurityEventModel: typeof UserSecurityEventModel;
  }): void {
    UserSecurityEventModel.belongsTo(models.UserModel, { foreignKey: 'user_id', as: 'user', constraints: false });
    UserSecurityEventModel.belongsTo(models.UserModel, {
      foreignKey: 'admin_user_id',
      as: 'adminUser',
      constraints: false,
    });
    UserSecurityEventModel.belongsTo(models.DeviceModel, {
      foreignKey: 'device_id',
      as: 'device',
      constraints: false,
    });
    // support_conversation_id 目标在 support.ts；跨文件关联在 index.ts 登记。
  }
}

export function register_UserModel(sequelize: Sequelize): void {
  (UserModel.init as unknown as ModelInitFn)(
    {
      id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
        comment: '此表主键，对外以十进制字符串表示',
      },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '账号状态，取值见 UserStatus：ACTIVE=1/DISABLED=2/CLOSED=3',
      },
      roleType: {
        field: 'role_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '角色位标记：PLAYER=1/AGENT=2/ADMIN=4/SYSTEM=8，合法组合为 1、3、4、8',
      },
      rewardType: {
        field: 'reward_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '本用户作为上级时的返点模式：RECHARGE=1/LOSS=2',
      },
      publicCode: {
        field: 'public_code',
        type: DataTypes.STRING(32),
        allowNull: false,
        comment: '随机不透明的公开好友码，可编码为二维码查找，不作登录凭证',
      },
      username: {
        field: 'username',
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '规范化用户名，设置后可用于账号登录',
      },
      passwordHash: {
        field: 'password_hash',
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: '可选用户名密码的 Argon2id/bcrypt 哈希，不保存明文',
      },
      passwordSetAt: {
        field: 'password_set_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '首次设置密码的时间，UTC',
      },
      email: {
        field: 'email',
        type: DataTypes.STRING(254),
        allowNull: true,
        comment: '用户邮箱，规范化后唯一',
      },
      emailVerifiedAt: {
        field: 'email_verified_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '邮箱验证成功时间；绑定/换绑不写此字段',
      },
      phone: {
        field: 'phone',
        type: DataTypes.STRING(32),
        allowNull: true,
        comment: '规范化 E.164 手机号，唯一',
      },
      phoneVerifiedAt: {
        field: 'phone_verified_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '手机验证成功时间；绑定/换绑不写此字段',
      },
      totpSecretCiphertext: {
        field: 'totp_secret_ciphertext',
        type: binaryDataType(512),
        allowNull: true,
        comment: '可选 TOTP 共享密钥的认证加密密文，不得明文存储或写日志',
      },
      totpEnabledAt: {
        field: 'totp_enabled_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'TOTP 完成二次验证并启用的时间；NULL 表示未启用',
      },
      totpLastAcceptedCounter: {
        field: 'totp_last_accepted_counter',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '最近成功使用的时间步，原子拒绝同一时间步重放',
      },
      totpRecoveryCodeHashes: {
        field: 'totp_recovery_code_hashes',
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'TOTP 备用码哈希数组；消费后原子移除，不存明文',
      },
      nickname: {
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '玩家昵称',
      },
      assetId: {
        field: 'asset_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '用户头像文件引用，指向 asset 表；外键待 0017 补建',
      },
      authVersion: {
        field: 'auth_version',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 1,
        comment: '身份权限撤销版本，会话建立时绑定并比对',
      },
      permissions: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: () => '[]',
        comment: '仅 Admin 使用：获授的 permission_code 字符串数组，由应用写入，非 Admin 必须为空数组',
      },
      lastLoginAt: {
        field: 'last_login_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后一次成功登录时间，UTC',
      },
      inviteCode: {
        field: 'invite_code',
        type: DataTypes.STRING(32),
        allowNull: true,
        comment: '普通玩家邀请代码；SYSTEM 与 ADMIN 账号必须为空',
      },
      inviteCodeExpiresAt: {
        field: 'invite_code_expires_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '邀请链接/代码失效时间，默认生成后 2 年',
      },
    },

    {
      // `user` 是 MySQL 保留字风险对象：Sequelize 对 tableName 自动加反引号；raw SQL 处手工加。
      tableName: 'user',
      ...standardTableOptions('user'),
      comment: '全平台统一账号身份，含玩家、代理、系统与 Admin',
      sequelize,
    } as unknown as ModelInitOptions<UserModel>,
  );
}

export function register_DeviceModel(sequelize: Sequelize): void {
  (DeviceModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '设备行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      },
      userId: { field: 'user_id', type: DataTypes.BIGINT, allowNull: false, comment: '所属用户，引用 user.id' },
      fingerprintHash: {
        field: 'fingerprint_hash',
        type: binaryDataType(32),
        allowNull: false,
        comment: '规范化设备指纹摘要，不作为认证凭证',
      },
      deviceDigest: {
        field: 'device_digest',
        type: binaryDataType(32),
        allowNull: false,
        comment: '设备摘要，允许指纹相似但凭证不同',
      },
      credentialKey: {
        field: 'credential_key',
        type: DataTypes.CHAR(36),
        allowNull: true,
        comment: '当前设备登录凭证的公开随机定位号；撤销后置空',
      },
      credentialSecretHash: {
        field: 'credential_secret_hash',
        type: binaryDataType(32),
        allowNull: true,
        comment: '当前高熵设备秘密的服务端验证摘要；撤销后置空',
      },
      credentialStatus: {
        field: 'credential_status',
        type: DataTypes.SMALLINT,
        allowNull: true,
        comment: '当前凭证状态，取值见 CredentialStatus：ACTIVE=1/REVOKED=2/EXPIRED=3；NULL 表示从未签发',
      },
      credentialExpiresAt: {
        field: 'credential_expires_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '当前设备凭证到期时间，UTC',
      },
      credentialRevokedAt: {
        field: 'credential_revoked_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '当前凭证撤销或轮换时间，UTC',
      },
      platformType: {
        field: 'platform_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '平台：WEB=1/IOS=2/ANDROID=3/WINDOWS=4/MACOS=5/LINUX=6',
      },
      lastSeenAt: { field: 'last_seen_at', type: DataTypes.DATE, allowNull: true, comment: '最后访问时间，UTC' },
    },

    {
      ...standardTableOptions('device'),
      comment: '设备识别及账号归属',
      sequelize,
    } as unknown as ModelInitOptions<DeviceModel>,
  );
}

export function register_RecoveryCredentialModel(sequelize: Sequelize): void {
  (RecoveryCredentialModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '凭证状态，取值见 RecoveryStatus：ISSUED=1/REVOKED=2/EXPIRED=3',
      },
      userId: { field: 'user_id', type: DataTypes.BIGINT, allowNull: false, comment: '被恢复的账号，引用 user.id' },
      credentialKey: {
        field: 'credential_key',
        type: DataTypes.CHAR(36),
        allowNull: false,
        comment: '二维码的随机定位值',
      },
      secretHash: { field: 'secret_hash', type: binaryDataType(32), allowNull: false, comment: '恢复秘密哈希，不保存明文' },
      expiresAt: { field: 'expires_at', type: DataTypes.DATE, allowNull: true, comment: '过期时间，UTC；默认签发后 2 年' },
      lastUsedAt: {
        field: 'last_used_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最近一次成功使用时间，UTC；使用不消费或撤销二维码',
      },
      revokedAt: {
        field: 'revoked_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '被新二维码替换或由用户/管理员撤销的时间，UTC',
      },
    },

    {
      ...standardTableOptions('recovery_credential'),
      comment: '密码保护二维码恢复凭证的当前及历史记录',
      sequelize,
    } as unknown as ModelInitOptions<RecoveryCredentialModel>,
  );
}

export function register_UserSecurityEventModel(sequelize: Sequelize): void {
  (UserSecurityEventModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '事件状态，固定为 RecordStatus.RECORDED=1，安全事实不可改写',
      },
      userId: { field: 'user_id', type: DataTypes.BIGINT, allowNull: false, comment: '被操作用户，引用 user.id' },
      sessionKey: { field: 'session_key', type: DataTypes.CHAR(36), allowNull: true, comment: 'Redis 玩家会话定位键，不是数据库外键' },
      adminSessionKey: {
        field: 'admin_session_key',
        type: DataTypes.CHAR(36),
        allowNull: true,
        comment: 'Redis 管理会话定位键，不是数据库外键',
      },
      adminUserId: {
        field: 'admin_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '由 Admin 处理时的身份，引用 user.id',
      },
      deviceId: { field: 'device_id', type: DataTypes.BIGINT, allowNull: true, comment: '本事件涉及的设备，引用 device.id' },
      supportConversationId: {
        field: 'support_conversation_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '人工客服参与的账号恢复或安全处置会话，引用 support_conversation.id；外键由 0015 补建',
      },
      eventKey: {
        field: 'event_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '安全事件去重键',
      },
      actionType: {
        field: 'action_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '事件动作：LOGIN=1/CONTACT=2/PASSWORD=3/RECOVERY=4/REVOKE=5/TOTP=6',
      },
      resultType: {
        field: 'result_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '事件结果：SUCCESS=1/DENIED=2/FAILED=3',
      },
      snapshot: {
        type: DataTypes.JSON,
        allowNull: false,
        comment: '脱敏安全事件快照，不含密码秘密和验证码',
      },
    },

    {
      ...appendOnlyModelOptions('user_security_event'),
      hooks: { ...appendOnlyHooks('user_security_event') },
      comment: '账号凭证及联系绑定安全历史',
      sequelize,
    } as unknown as ModelInitOptions<UserSecurityEventModel>,
  );
}
// ---------------------------------------------------------------------------
// 文件级注册器
// ---------------------------------------------------------------------------

/** identity 模块状态/类型常量（本地常量；单一来源在 contracts 包落地后迁移，当前为本地常量）。 */
export const UserStatus = { ACTIVE: 1, DISABLED: 2, CLOSED: 3 } as const;
export type UserStatusValue = (typeof UserStatus)[keyof typeof UserStatus];

export const CredentialStatus = { ACTIVE: 1, REVOKED: 2, EXPIRED: 3 } as const;
export type CredentialStatusValue = (typeof CredentialStatus)[keyof typeof CredentialStatus];

export const PlatformType = { WEB: 1, IOS: 2, ANDROID: 3, WINDOWS: 4, MACOS: 5, LINUX: 6 } as const;
export type PlatformTypeValue = (typeof PlatformType)[keyof typeof PlatformType];

export const RecoveryStatus = { ISSUED: 1, REVOKED: 2, EXPIRED: 3 } as const;
export type RecoveryStatusValue = (typeof RecoveryStatus)[keyof typeof RecoveryStatus];

/** RecordStatus：不可变事件行固定 1。本地常量，单一来源在 contracts 包落地后迁移。 */
export const RecordStatus = { RECORDED: 1 } as const;
export type RecordStatusValue = (typeof RecordStatus)[keyof typeof RecordStatus];

export const SecurityEventType = { LOGIN: 1, CONTACT: 2, PASSWORD: 3, RECOVERY: 4, REVOKE: 5, TOTP: 6 } as const;
export type SecurityEventTypeValue = (typeof SecurityEventType)[keyof typeof SecurityEventType];

export const SecurityResultType = { SUCCESS: 1, DENIED: 2, FAILED: 3 } as const;
export type SecurityResultTypeValue = (typeof SecurityResultType)[keyof typeof SecurityResultType];

export interface IdentityModels {
  UserModel: typeof UserModel;
  DeviceModel: typeof DeviceModel;
  RecoveryCredentialModel: typeof RecoveryCredentialModel;
  UserSecurityEventModel: typeof UserSecurityEventModel;
}

/** 定义 4 个 identity model（不在此声明跨文件关联）。 */
export function initIdentity(sequelize: Sequelize, models: IdentityModels): void {
  register_UserModel(sequelize);
  register_DeviceModel(sequelize);
  register_RecoveryCredentialModel(sequelize);
  register_UserSecurityEventModel(sequelize);
  void models;
}

/** 声明 identity 文件内的跨表关联（FK 全部 constraints: false，由迁移管理）。 */
export function associateIdentity(models: IdentityModels): void {
  DeviceModel.associate(models);
  RecoveryCredentialModel.associate(models);
  UserSecurityEventModel.associate(models);
}
