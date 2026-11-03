/**
 * identity 仓储端口（user / device / recovery_credential / user_security_event）。
 *
 * 领域所有者：identity 模块（adapters/sequelize-identity-repository.ts 实现）。
 * 对应 SDD 章节：后端实施 SDD §4（"用例与端口（application / ports / adapters）"）、
 * 附录 A.1（identity 四 model）；数据库设计 SDD §5.1 user/device/recovery_credential
 * 与 §5.8 user_security_event。
 *
 * 约定（SDD §2 第 2 条）：BIGINT id 以十进制字符串读回（row-mapper 约定，adapter 内
 * 完成）；user_security_event 只经本端口 append-only 写入（model hooks 已拦截
 * update/delete，adapter 只提供 create）；跨表写归 identity 用例，不直接 `Model.update()`
 * 其他模块表。
 */

import type {
  DeviceModel,
  UserModel,
  RecoveryCredentialModel,
  UserSecurityEventModel,
} from '../../../infrastructure/database/models/identity.js';

/** 事务句柄（Sequelize Transaction 鸭子类型；用例内所有写操作共享同一事务）。 */
export interface Tx {
  transaction?: unknown;
}

/** findUserByIdentifier 的查询维度。 */
export type UserIdentifier = { kind: 'username'; value: string } | { kind: 'email'; value: string } | { kind: 'phone'; value: string };

/** 安全事件记录请求（append-only；eventKey 去重）。 */
export interface SecurityEventInput {
  userId: string;
  sessionKey?: string | null;
  adminSessionKey?: string | null;
  adminUserId?: string | null;
  deviceId?: string | null;
  supportConversationId?: string | null;
  eventKey: string;
  /** 事件动作：LOGIN=1/CONTACT=2/PASSWORD=3/RECOVERY=4/REVOKE=5/TOTP=6。 */
  actionType: number;
  /** 事件结果：SUCCESS=1/DENIED=2/FAILED=3。 */
  resultType: number;
  /** 脱敏快照（不含密码秘密和验证码，§3 "安全事件只记录脱敏的新旧值"）。 */
  snapshot: Record<string, unknown>;
}

export interface IdentityRepository {
  /** 按 username/email/phone 精确查（identifier 规范化由用例层负责）。 */
  findUserByIdentifier(identifier: UserIdentifier, tx: Tx): Promise<UserModel | null>;
  findUserById(userId: string, tx: Tx): Promise<UserModel | null>;
  /** 用户名唯一性（设置/变更 username 用）。 */
  findUserByUsername(username: string, tx: Tx): Promise<UserModel | null>;
  /** 邮箱占用（换绑原子替换前查）。 */
  findUserByEmail(email: string, tx: Tx): Promise<UserModel | null>;
  /** 手机占用（换绑原子替换前查）。 */
  findUserByPhone(phone: string, tx: Tx): Promise<UserModel | null>;

  /** 更新 user 凭证（username/password/email/phone/totp/auth_version 等），返回影响行数。 */
  updateUser(
    userId: string,
    patch: Partial<
      Pick<
        UserModel,
        | 'username'
        | 'passwordHash'
        | 'passwordSetAt'
        | 'email'
        | 'emailVerifiedAt'
        | 'phone'
        | 'phoneVerifiedAt'
        | 'totpSecretCiphertext'
        | 'totpEnabledAt'
        | 'totpLastAcceptedCounter'
        | 'totpRecoveryCodeHashes'
        | 'authVersion'
        | 'lastLoginAt'
      >
    >,
    tx: Tx,
  ): Promise<number>;

  /** 原子推进 TOTP 最后接受时间步（单调，防重放；影响行数 0 = 重放）。 */
  advanceTotpCounter(userId: string, acceptedCounter: string, tx: Tx): Promise<number>;
  /** 原子消费一条 TOTP 恢复码哈希（从数组移除指定 hash，影响行数 0 = 已消费/不存在）。 */
  consumeRecoveryCodeHash(userId: string, codeHash: string, tx: Tx): Promise<number>;

  /** 创建 user（设备注册时首次访问建账号；幂等由调用方保证）。 */
  createUser(user: Partial<UserModel>, tx: Tx): Promise<UserModel>;

  /** 设备 upsert：按 fingerprint_hash + user_id 查找，不存在则创建，存在则更新 last_seen。 */
  upsertDevice(
    input: {
      userId: string;
      fingerprintHash: Uint8Array;
      deviceDigest: Uint8Array;
      credentialKey: string | null;
      credentialSecretHash: Uint8Array | null;
      credentialStatus: number | null;
      credentialExpiresAt: Date | null;
      credentialRevokedAt: Date | null;
      platformType: number;
      lastSeenAt: Date;
    },
    tx: Tx,
  ): Promise<DeviceModel>;

  /** 按 credential_key 查当前有效设备凭证（device-login 用）。 */
  findDeviceByCredentialKey(credentialKey: string, tx: Tx): Promise<DeviceModel | null>;
  /** 查用户全部设备（设备/会话列表撤销用，§4 "已授权的设备/会话列表撤销接口"）。 */
  listDevicesByUser(userId: string, tx: Tx): Promise<DeviceModel[]>;
  /** 撤销设备凭证（credential_key 置空、status=REVOKED、secret_hash 置空）。 */
  revokeDeviceCredential(deviceId: string, tx: Tx): Promise<number>;

  /** 查用户当前有效恢复凭证（最多一条 status=ISSUED，active_marker 生成列保证）。 */
  findActiveRecoveryCredential(userId: string, tx: Tx): Promise<RecoveryCredentialModel | null>;
  /** 按 credential_key 查恢复凭证（recovery 用）。 */
  findRecoveryCredentialByKey(credentialKey: string, tx: Tx): Promise<RecoveryCredentialModel | null>;
  /** 签发恢复凭证：旧有效行置 REVOKED，新行 ISSUED（同事务；唯一索引保证至多一条有效）。 */
  issueRecoveryCredential(
    input: { userId: string; credentialKey: string; secretHash: Uint8Array; expiresAt: Date },
    tx: Tx,
  ): Promise<RecoveryCredentialModel>;
  /** 标记恢复凭证使用（last_used_at；不消费不撤销，§3 "使用不消费或撤销"）。 */
  markRecoveryCredentialUsed(credentialId: string, usedAt: Date, tx: Tx): Promise<number>;

  /** 追加安全事件（append-only；model hooks 拦截 update/delete）。 */
  createSecurityEvent(input: SecurityEventInput, tx: Tx): Promise<UserSecurityEventModel>;
}
