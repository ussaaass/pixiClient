/**
 * identity 仓储适配器（Sequelize 实现 IdentityRepository）。
 *
 * 领域所有者：identity 模块（models/identity.ts 四个 model + outbox 的 user_security_event 侧）。
 * 对应 SDD 章节：后端实施 SDD §4（adapters/ 实现 ports/）、附录 A.1；数据库设计 SDD
 * §5.1 user/device/recovery_credential、§5.8 user_security_event。
 *
 * 约定（SDD §2 第 2 条）：BIGINT id 以十进制字符串读回（Sequelize BIGINT 默认回 string，
 * 本适配器显式保持）；BINARY 列（fingerprint_hash/device_digest/credential_secret_hash/
 * secret_hash）保持 Uint8Array 原样，hex 化由调用方（用例/row-mapper）负责；
 * user_security_event 只经 `createSecurityEvent` 写入（append-only，model hooks 拦截
 * update/delete）。`user` 表为 MySQL 保留字，Sequelize 自动加反引号。
 */

import { Op, type Transaction } from 'sequelize';
import type {
  DeviceModel,
  RecoveryCredentialModel,
  UserModel,
  UserSecurityEventModel,
} from '../../../infrastructure/database/models/identity.js';
import { CredentialStatus, RecoveryStatus, RecordStatus } from '../../../infrastructure/database/models/identity.js';
import type { IdentityRepository, SecurityEventInput, Tx, UserIdentifier } from '../ports/identity-repository.js';

/** 取事务（Sequelize Transaction 鸭子类型）。 */
function txOf(tx: Tx): Transaction {
  return (tx.transaction as Transaction | undefined) ?? ({} as Transaction);
}

export class SequelizeIdentityRepository implements IdentityRepository {
  constructor(
    private readonly models: {
      UserModel: typeof UserModel;
      DeviceModel: typeof DeviceModel;
      RecoveryCredentialModel: typeof RecoveryCredentialModel;
      UserSecurityEventModel: typeof UserSecurityEventModel;
    },
  ) {}

  async findUserByIdentifier(identifier: UserIdentifier, tx: Tx): Promise<UserModel | null> {
    const table = this.models.UserModel;
    const where: Record<string, unknown> = { status: 1 }; // 只查 ACTIVE；DISABLED/CLOSED 不登录
    switch (identifier.kind) {
      case 'username':
        where.username = identifier.value;
        break;
      case 'email':
        where.email = identifier.value;
        break;
      case 'phone':
        where.phone = identifier.value;
        break;
    }
    return await table.findOne({ where, transaction: txOf(tx) });
  }

  async findUserById(userId: string, tx: Tx): Promise<UserModel | null> {
    return await this.models.UserModel.findByPk(userId, { transaction: txOf(tx) });
  }

  async findUserByUsername(username: string, tx: Tx): Promise<UserModel | null> {
    return await this.models.UserModel.findOne({ where: { username }, transaction: txOf(tx) });
  }

  async findUserByEmail(email: string, tx: Tx): Promise<UserModel | null> {
    return await this.models.UserModel.findOne({ where: { email }, transaction: txOf(tx) });
  }

  async findUserByPhone(phone: string, tx: Tx): Promise<UserModel | null> {
    return await this.models.UserModel.findOne({ where: { phone }, transaction: txOf(tx) });
  }

  async updateUser(userId: string, patch: Parameters<IdentityRepository['updateUser']>[1], tx: Tx): Promise<number> {
    const [affected] = await this.models.UserModel.update(patch as Record<string, unknown>, {
      where: { id: userId },
      transaction: txOf(tx),
    });
    return affected;
  }

  async advanceTotpCounter(userId: string, acceptedCounter: string, tx: Tx): Promise<number> {
    // 单调推进：只接受比当前更大的 counter（防重放；影响行数 0 = 重放/未启用）。
    const [affected] = await this.models.UserModel.update(
      { totpLastAcceptedCounter: acceptedCounter },
      {
        where: {
          id: userId,
          [Op.or]: [{ totpLastAcceptedCounter: null }, { totpLastAcceptedCounter: { [Op.lt]: acceptedCounter } }],
        },
        transaction: txOf(tx),
      },
    );
    return affected;
  }

  async consumeRecoveryCodeHash(userId: string, codeHash: string, tx: Tx): Promise<number> {
    const user = await this.findUserById(userId, tx);
    if (user === null) return 0;
    const hashes = user.totpRecoveryCodeHashes ?? [];
    const index = hashes.indexOf(codeHash);
    if (index < 0) return 0; // 已消费/不存在
    const remaining = hashes.filter((_, i) => i !== index);
    await this.models.UserModel.update(
      { totpRecoveryCodeHashes: remaining.length > 0 ? remaining : null },
      { where: { id: userId, totpRecoveryCodeHashes: user.totpRecoveryCodeHashes }, transaction: txOf(tx) },
    );
    return 1;
  }

  async createUser(user: Partial<UserModel>, tx: Tx): Promise<UserModel> {
    // 幂等性（赠币每账号一次）由调用方按 user.id 去重；本方法只做 INSERT。
    // `as never` 绕过 exactOptionalPropertyTypes 下 Partial<UserModel> 与
    // UserModelCreationAttributes（OmitPublicFields）的可选属性约束（SDD §2 第 8 条
    // registerXxx 最小可编译模式；创建属性由 model 默认值 + 调用方保证）。
    return await this.models.UserModel.create(user as never, { transaction: txOf(tx) });
  }

  async upsertDevice(input: Parameters<IdentityRepository['upsertDevice']>[0], tx: Tx): Promise<DeviceModel> {
    // 设备 upsert：按 user_id + fingerprint_hash 查；不存在创建，存在更新凭证字段与 last_seen。
    const existing = await this.models.DeviceModel.findOne({
      where: { userId: input.userId, fingerprintHash: input.fingerprintHash },
      transaction: txOf(tx),
    });
    if (existing === null) {
      // `as never` 绕过 exactOptionalPropertyTypes 下创建属性与 model 创建签名的
      // 可选属性约束（SDD §2 第 8 条 registerXxx 最小可编译模式；device 必填项
      // 由 upsert 入参保证）。
      return await this.models.DeviceModel.create({ ...input } as never, { transaction: txOf(tx) } as never);
    }
    const updated = await existing.update(
      {
        deviceDigest: input.deviceDigest,
        credentialKey: input.credentialKey,
        credentialSecretHash: input.credentialSecretHash,
        credentialStatus: input.credentialStatus,
        credentialExpiresAt: input.credentialExpiresAt,
        credentialRevokedAt: input.credentialRevokedAt,
        platformType: input.platformType,
        lastSeenAt: input.lastSeenAt,
      },
      { transaction: txOf(tx) },
    );
    return updated as DeviceModel;
  }

  async findDeviceByCredentialKey(credentialKey: string, tx: Tx): Promise<DeviceModel | null> {
    return await this.models.DeviceModel.findOne({
      where: { credentialKey },
      transaction: txOf(tx),
    });
  }

  async listDevicesByUser(userId: string, tx: Tx): Promise<DeviceModel[]> {
    return await this.models.DeviceModel.findAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
      transaction: txOf(tx),
    });
  }

  async revokeDeviceCredential(deviceId: string, tx: Tx): Promise<number> {
    // 撤销设备凭证：credential_key/secret_hash 置空、status=REVOKED、revoked_at=now
    // （§3 "撤销设备凭证不必删除设备识别记录"；保留识别行，清凭证字段）。
    const now = new Date();
    const [affected] = await this.models.DeviceModel.update(
      {
        credentialKey: null,
        credentialSecretHash: null,
        credentialStatus: CredentialStatus.REVOKED,
        credentialRevokedAt: now,
      },
      { where: { id: deviceId }, transaction: txOf(tx) },
    );
    return affected;
  }

  async findActiveRecoveryCredential(userId: string, tx: Tx): Promise<RecoveryCredentialModel | null> {
    // active_marker 生成列保证至多一条有效；按 status=ISSUED + 未删除查。
    return await this.models.RecoveryCredentialModel.findOne({
      where: { userId, status: RecoveryStatus.ISSUED },
      order: [['createdAt', 'DESC']],
      transaction: txOf(tx),
    });
  }

  async findRecoveryCredentialByKey(credentialKey: string, tx: Tx): Promise<RecoveryCredentialModel | null> {
    return await this.models.RecoveryCredentialModel.findOne({
      where: { credentialKey },
      transaction: txOf(tx),
    });
  }

  async issueRecoveryCredential(
    input: Parameters<IdentityRepository['issueRecoveryCredential']>[0],
    tx: Tx,
  ): Promise<RecoveryCredentialModel> {
    // §3 "生成新二维码时，在一个数据库事务中将原有效行更新为 REVOKED、填入 revoked_at，
    // 再插入新 ISSUED 行"。同事务两步，唯一索引 U(user_id,active_marker) 兜底。
    const now = new Date();
    await this.models.RecoveryCredentialModel.update(
      { status: RecoveryStatus.REVOKED, revokedAt: now },
      { where: { userId: input.userId, status: RecoveryStatus.ISSUED }, transaction: txOf(tx) },
    );
    return await this.models.RecoveryCredentialModel.create(
      {
        userId: input.userId,
        credentialKey: input.credentialKey,
        secretHash: input.secretHash,
        status: RecoveryStatus.ISSUED,
        expiresAt: input.expiresAt,
        // outbox/不可变表的默认值（attempts 等）由 model 默认值兜底；此处只登记必填项。
      } as never,
      { transaction: txOf(tx) } as never,
    );
  }

  async markRecoveryCredentialUsed(credentialId: string, usedAt: Date, tx: Tx): Promise<number> {
    const [affected] = await this.models.RecoveryCredentialModel.update(
      { lastUsedAt: usedAt },
      { where: { id: credentialId }, transaction: txOf(tx) },
    );
    return affected;
  }

  async createSecurityEvent(input: SecurityEventInput, tx: Tx): Promise<UserSecurityEventModel> {
    // append-only：model hooks 已拦截 update/delete；此处只 create（A.12 第 5 条）。
    const row = await this.models.UserSecurityEventModel.create(
      {
        userId: input.userId,
        sessionKey: input.sessionKey ?? null,
        adminSessionKey: input.adminSessionKey ?? null,
        adminUserId: input.adminUserId ?? null,
        deviceId: input.deviceId ?? null,
        supportConversationId: input.supportConversationId ?? null,
        eventKey: input.eventKey,
        actionType: input.actionType,
        resultType: input.resultType,
        snapshot: input.snapshot,
        status: RecordStatus.RECORDED,
      },
      { transaction: txOf(tx) } as never,
    );
    return row;
  }
}
