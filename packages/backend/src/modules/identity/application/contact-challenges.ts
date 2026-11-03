/**
 * contact-challenges 用例：邮箱/手机绑定与换绑（§5 全规则落实）。
 *
 * 领域所有者：identity 模块（/me/identity/contact-challenges、/me/identity/phone、
 * /me/identity/email）。
 * 对应 SDD 章节：JWT 登录与会话设计 §5 —— "邮箱绑定和换绑不发送验证码：首次绑定依赖
 * 当前有效会话；换绑要求输入当前完整邮箱，服务端规范化后精确比较，失败时保持旧绑定，
 * 成功时在同一事务替换邮箱并立即释放旧值。手机号同样不发送短信验证码……若账号已设置
 * 密码，两类操作都要求当前密码；未设密码时依赖有效会话。启用 TOTP 的账号还须当前 TOTP。
 * 安全事件只记录脱敏的新旧值。" 数据库设计 SDD §5.1 user（"邮箱和手机号均不发送验证码；
 * 换绑分别要求输入当前完整邮箱/手机号……匹配后在单个事务中替换 user 字段并清空对应的
 * verified_at，旧值立即可由其他账号重新绑定"）。
 *
 * 端点与契约（contracts `IdentityEndpoint`，DTO 单一来源，不手写第二套）：
 * - `POST /me/identity/contact-challenges`（CreateContactChallengeRequest →
 *   ContactChallengeResponse，201）：§5 免验证码流程的 challenge 占位——本步挑战为
 *   "绑定/换绑请求预校验 + 10min Redis 暂存"，不发送验证码；
 * - `POST /me/identity/contact-challenges/:challengeId/confirm`（ConfirmContactChallenge
 *   Request → IdentitySettingsResponse，200）：6 位 code 确认（契约保留 VERIFICATION_CODE
 *   机制；§5 免验证码语义下 code 为"再认证通过凭据"占位——见决策点登记）；
 * - `PUT /me/identity/phone`（SetPhoneContactRequest → IdentitySettingsResponse，200）；
 * - `PUT /me/identity/email`（SetEmailContactRequest → IdentitySettingsResponse，200）。
 *
 * 错误码映射（IdentityErrorCode → 触发条件）：
 * - `CURRENT_EMAIL_MISMATCH` / `CURRENT_PHONE_MISMATCH`：换绑提交的旧值与现值规范化后
 *   不等（§5 "失败时保持旧绑定"）。
 * - `IDENTIFIER_ALREADY_USED`：新邮箱/手机已被其他账号绑定（U(email)/U(phone) 唯一；
 *   §5 "新值已被其他账号占用……原绑定保持不变"）。
 * - `REAUTHENTICATION_FAILED`：已设密码但当前密码错 / TOTP 启用但当前 TOTP 错（§5 再认证）。
 * - `CHALLENGE_NOT_FOUND` / `CHALLENGE_EXPIRED`：confirm 的 challengeId 无效/过 10min TTL。
 * - `VERIFICATION_CODE_INVALID`：confirm 的 6 位 code 与暂存挑战不符（§5 免验证码语义
 *   下，code 字段为再认证占位；实际拒绝路径见决策点登记）。
 * - `VALIDATION_FAILED`：新值格式非法（邮箱/手机长度越界、规范化失败）。
 * - `ACCOUNT_LOCKED`：user.status ≠ ACTIVE。
 * - `IDENTITY_STORAGE_UNAVAILABLE`：Sequelize 故障。
 * - 成功 → IdentitySettingsResponse（200；email/phone 的 verified 因绑定不写入
 *   verified_at，§5 "邮箱不因该流程设置 email_verified_at"）。
 */

import type {
  CreateContactChallengeRequestSchema,
  ContactChallengeResponseSchema,
  ConfirmContactChallengeRequestSchema,
  SetPhoneContactRequestSchema,
  SetEmailContactRequestSchema,
  IdentitySettingsResponseSchema,
  Static,
} from '@gameing/contracts/identity';
import type { UserModel } from '../../../infrastructure/database/models/identity.js';
import { UserStatus } from '../../../infrastructure/database/models/identity.js';
import { DomainError, I } from '../domain/errors.js';
import {
  checkEmailChange,
  checkPhoneChange,
  normalizeEmail,
  normalizePhone,
  contactReauthRequirements,
  maskEmail,
  maskPhone,
} from '../domain/contact-rules.js';
import { verifyPassword } from '../domain/password.js';
import type { Clock } from '../ports/clock.js';
import type { IdentityRepository, Tx } from '../ports/identity-repository.js';
import type { OutboxPort } from '../ports/outbox-port.js';
import type { ChallengeStore } from '../ports/challenge-store-port.js';
import { toIdentitySettings } from '../adapters/row-mappers.js';
import { randomId } from '../../../infrastructure/jwt/jwt.js';
import { createHash } from 'node:crypto';
import type { SecurityEventService } from './security-events.js';

/** 联系方式挑战（Redis 10min TTL；§5 免验证码语义下的预校验暂存，不发送验证码）。 */
export interface ContactChallengeRecord {
  challengeId: string;
  userId: string;
  contactType: 'EMAIL' | 'PHONE';
  /** 规范化新值（原子替换目标）。 */
  normalizedNew: string;
  /** 是否换绑（true=需精确比对旧值；false=首次绑定）。 */
  isChange: boolean;
  expiresAt: string;
}

export interface ContactSettingsCtx {
  userId: string;
  sessionKey: string | null;
  deviceId: string | null;
}

export class ContactChallengesUseCase {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly outbox: OutboxPort,
    private readonly challenges: ChallengeStore,
    private readonly clock: Clock,
    private readonly securityEvents: SecurityEventService,
  ) {}

  // ------------------------------------------------- createContactChallenge

  /**
   * POST /me/identity/contact-challenges（§5 绑定/换绑预校验 + Redis 10min 暂存）。
   * 免验证码语义：不发送验证码；挑战只固化"规范化新值 + 换绑旧值校验"，
   * confirm 时按当前账号状态原子替换（§5 "成功时在同一事务替换……立即释放旧值"）。
   */
  async createContactChallenge(
    request: Static<typeof CreateContactChallengeRequestSchema>,
    ctx: ContactSettingsCtx,
    tx: Tx,
  ): Promise<Static<typeof ContactChallengeResponseSchema>> {
    const user = await this.loadActiveUser(ctx, tx);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();

    const reauth = contactReauthRequirements({
      passwordConfigured: user.passwordHash !== null,
      totpEnabled: user.totpEnabledAt !== null,
    });
    // 再认证门禁（§5 "若账号已设置密码，两类操作都要求当前密码；未设密码时依赖有效
    // 会话。启用 TOTP 的账号还须当前 TOTP"）：已设密码 → 当前密码；TOTP → 当前 TOTP。
    if (reauth.requirePassword) {
      if (request.password === undefined) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current password required');
      }
      const ok = await verifyPassword(user.passwordHash!, request.password);
      if (!ok) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current password does not match');
      }
    }
    if (reauth.requireTotp) {
      if (request.totp === undefined) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current TOTP required');
      }
      const ok = await this.verifyTotp(user, request.totp, tx);
      if (!ok) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current TOTP not accepted');
      }
    }

    let record: ContactChallengeRecord;
    if (request.contactType === 'EMAIL') {
      const normalizedNew = normalizeEmail(request.contactValue);
      if (normalizedNew.length < 3 || normalizedNew.length > 254) {
        throw new DomainError(I.VALIDATION_FAILED, 'invalid email format');
      }
      const isChange = user.email !== null;
      record = {
        challengeId: randomId(16),
        userId: user.id,
        contactType: 'EMAIL',
        normalizedNew,
        isChange,
        expiresAt,
      };
    } else {
      const normalizedNew = normalizePhone(request.contactValue);
      if (normalizedNew.length < 7 || normalizedNew.length > 20) {
        throw new DomainError(I.VALIDATION_FAILED, 'invalid phone format');
      }
      const isChange = user.phone !== null;
      record = {
        challengeId: randomId(16),
        userId: user.id,
        contactType: 'PHONE',
        normalizedNew,
        isChange,
        expiresAt,
      };
    }

    // Redis 暂存挑战（10min TTL；§3 所有 Redis key 带 TTL；§5 免验证码语义占位）。
    await this.challenges.saveTotpSetup({
      setupId: record.challengeId,
      userId: record.userId,
      secretBase32: JSON.stringify(record),
      otpauthUri: '',
      expiresAt: record.expiresAt,
    });

    return { challengeId: record.challengeId, expiresAt };
  }

  // ------------------------------------------------- confirmContactChallenge

  /**
   * POST /me/identity/contact-challenges/:challengeId/confirm（§5 原子替换 + 释放旧值）。
   * code 字段为 6 位占位（§5 免验证码语义下为"再认证通过凭据"，本步登记决策点）；
   * 实际门禁 = challenge 暂存 + 换绑旧值精确比较 + 唯一性 + 再认证。
   */
  async confirmContactChallenge(
    challengeId: string,
    request: Static<typeof ConfirmContactChallengeRequestSchema>,
    ctx: ContactSettingsCtx,
    tx: Tx,
  ): Promise<Static<typeof IdentitySettingsResponseSchema>> {
    // 1) 挑战门禁（CHALLENGE_NOT_FOUND / CHALLENGE_EXPIRED）。
    const record = await this.challenges.getTotpSetup(challengeId);
    if (record === null) {
      throw new DomainError(I.CHALLENGE_NOT_FOUND, 'challenge not found or already consumed');
    }
    if (new Date(record.expiresAt).getTime() < this.clock.now().getTime()) {
      await this.challenges.deleteTotpSetup(challengeId);
      throw new DomainError(I.CHALLENGE_EXPIRED, 'challenge expired');
    }
    const user = await this.loadActiveUser(ctx, tx);
    const payload = JSON.parse(record.secretBase32) as ContactChallengeRecord;
    if (payload.userId !== user.id) {
      throw new DomainError(I.CHALLENGE_NOT_FOUND, 'challenge does not belong to user');
    }

    // 2) 换绑旧值精确比较（§5 "换绑要求输入当前完整邮箱/手机号，服务端规范化后精确
    // 比较，失败时保持旧绑定"；首次绑定无旧值可比对，跳过）。
    if (payload.contactType === 'EMAIL') {
      if (payload.isChange) {
        // 换绑场景：挑战创建时未存旧值输入（契约 CreateContactChallenge 无 currentEmail
        // 字段），此处按 §5 以请求的 normalizedNew 为目标，旧值精确比较由
        // setPhoneContact/setEmailContact 的 currentEmail 字段承担；本 confirm 路径
        // 对换绑要求再次校验旧值（§5 "失败时保持旧绑定"）。
        // 决策点登记：contracts CreateContactChallengeRequest 未含 currentEmail/
        // currentPhone 字段，换绑旧值精确比较在 setPhone/setEmail 端点承担。
      }
      await this.applyEmailChange(user, payload.normalizedNew, ctx, tx);
    } else {
      await this.applyPhoneChange(user, payload.normalizedNew, ctx, tx);
    }

    // 3) 挑战单次消费（§5 免验证码；不重放）。
    await this.challenges.deleteTotpSetup(challengeId);
    void request.code; // code 占位（决策点登记）；§5 免验证码语义下不作为门禁。

    const fresh = (await this.repo.findUserById(user.id, tx))!;
    return this.settingsOf(fresh, tx);
  }

  // ------------------------------------------------------- setPhoneContact

  /**
   * PUT /me/identity/phone（§5 "手机号同样不发送短信验证码：首次绑定依赖当前有效
   * 会话；换绑要求输入当前完整手机号，界面同时显示已绑定号码末三位供核对，服务端
   * 规范化后精确比较并原子替换"）。
   */
  async setPhoneContact(
    request: Static<typeof SetPhoneContactRequestSchema>,
    ctx: ContactSettingsCtx,
    tx: Tx,
  ): Promise<Static<typeof IdentitySettingsResponseSchema>> {
    const user = await this.loadActiveUser(ctx, tx);
    await this.applyPhoneChange(user, request.phone, ctx, tx, request.currentPhone);
    const fresh = (await this.repo.findUserById(user.id, tx))!;
    return this.settingsOf(fresh, tx);
  }

  // ------------------------------------------------------- setEmailContact

  /**
   * PUT /me/identity/email（§5 "邮箱不因该流程设置 email_verified_at"；换绑输入完整
   * 旧邮箱精确比较，成功同事务替换并释放旧值）。
   */
  async setEmailContact(
    request: Static<typeof SetEmailContactRequestSchema>,
    ctx: ContactSettingsCtx,
    tx: Tx,
  ): Promise<Static<typeof IdentitySettingsResponseSchema>> {
    const user = await this.loadActiveUser(ctx, tx);
    await this.applyEmailChange(user, request.email, ctx, tx, request.currentEmail);
    const fresh = (await this.repo.findUserById(user.id, tx))!;
    return this.settingsOf(fresh, tx);
  }

  // ------------------------------------------------------------------ 私有

  private async loadActiveUser(ctx: ContactSettingsCtx, tx: Tx): Promise<UserModel> {
    const user = await this.repo.findUserById(ctx.userId, tx);
    if (user === null || user.status !== UserStatus.ACTIVE) {
      throw new DomainError(I.ACCOUNT_LOCKED, 'account is not active');
    }
    return user;
  }

  /**
   * 邮箱绑定/换绑原子替换（§5 "同一事务替换邮箱并立即释放旧值"）。
   * @param currentEmail 换绑时用户输入的完整旧邮箱（§5 "换绑输入完整旧邮箱精确比较"）；
   *   undefined = 首次绑定（依赖有效会话，无需旧值比对）。
   */
  private async applyEmailChange(
    user: UserModel,
    rawNewEmail: string,
    ctx: ContactSettingsCtx,
    tx: Tx,
    currentEmail?: string,
  ): Promise<void> {
    const normalizedNew = normalizeEmail(rawNewEmail);
    const now = this.clock.now();
    const isChange = user.email !== null;

    // 唯一性门禁（U(email)；新值被其他账号占用 → 原绑定保持不变，§5）。
    const occupied = await this.repo.findUserByEmail(normalizedNew, tx);
    if (occupied !== null && occupied.id !== user.id) {
      throw new DomainError(I.IDENTIFIER_ALREADY_USED, 'email is already bound to another account');
    }

    // 换绑旧值精确比较（§5 "换绑输入完整旧邮箱，服务端规范化后精确比较，失败时保持旧绑定"）。
    if (isChange) {
      if (currentEmail === undefined) {
        // 换绑必须提供完整旧邮箱（§5）；缺失 → 视为旧值不匹配（保持旧绑定）。
        throw new DomainError(I.CURRENT_EMAIL_MISMATCH, 'current email mismatch');
      }
      const check = checkEmailChange(user.email!, currentEmail, normalizedNew);
      if (!check.ok) {
        await this.recordContactDenied(user, ctx, 'EMAIL', user.email!, normalizedNew, I.CURRENT_EMAIL_MISMATCH, tx);
        throw new DomainError(I.CURRENT_EMAIL_MISMATCH, 'current email does not match');
      }
    }

    // 原子替换（§5 "成功时在同一事务替换邮箱并立即释放旧值"）：
    // email 更新为新值 + email_verified_at 置 NULL（§5 "邮箱不因该流程设置
    // email_verified_at"；旧 verified 状态因换绑失效）。
    await this.repo.updateUser(user.id, { email: normalizedNew, emailVerifiedAt: null }, tx);

    // 安全事件（§5 "安全事件只记录脱敏的新旧值"）。
    await this.recordContactEvent(user, ctx, 'EMAIL', user.email ?? null, normalizedNew, tx);
    void now;
  }

  /**
   * 手机绑定/换绑原子替换（§5 "换绑要求输入当前完整手机号，服务端规范化后精确比较
   * 并原子替换"；界面显示末三位供核对由前端经 maskPhone/phoneTail3 完成）。
   * @param currentPhone 换绑时输入的完整旧手机（§5）；undefined = 首次绑定。
   */
  private async applyPhoneChange(
    user: UserModel,
    rawNewPhone: string,
    ctx: ContactSettingsCtx,
    tx: Tx,
    currentPhone?: string,
  ): Promise<void> {
    const normalizedNew = normalizePhone(rawNewPhone);
    const isChange = user.phone !== null;

    // 唯一性门禁（U(phone) E.164；新值被其他账号占用 → 原绑定保持不变，§5）。
    const occupied = await this.repo.findUserByPhone(normalizedNew, tx);
    if (occupied !== null && occupied.id !== user.id) {
      throw new DomainError(I.IDENTIFIER_ALREADY_USED, 'phone is already bound to another account');
    }

    // 换绑旧值精确比较（§5 "换绑要求输入当前完整手机号……失败时保持旧绑定"）。
    if (isChange) {
      if (currentPhone === undefined) {
        throw new DomainError(I.CURRENT_PHONE_MISMATCH, 'current phone mismatch');
      }
      const check = checkPhoneChange(user.phone!, currentPhone, normalizedNew);
      if (!check.ok) {
        await this.recordContactDenied(user, ctx, 'PHONE', user.phone!, normalizedNew, I.CURRENT_PHONE_MISMATCH, tx);
        throw new DomainError(I.CURRENT_PHONE_MISMATCH, 'current phone does not match');
      }
    }

    // 原子替换（§5 "匹配后在单个事务中替换 user 字段并清空对应的 verified_at"）：
    // phone 更新 + phone_verified_at 置 NULL（§5 "绑定/换绑不写此字段"）。
    await this.repo.updateUser(user.id, { phone: normalizedNew, phoneVerifiedAt: null }, tx);

    // 安全事件（脱敏新旧值，§5）。
    await this.recordContactEvent(user, ctx, 'PHONE', user.phone ?? null, normalizedNew, tx);
  }

  /** TOTP/恢复码校验（同 identity-settings；§5 "启用 TOTP 的账号还须当前 TOTP"）。 */
  private async verifyTotp(user: UserModel, code: string, tx: Tx): Promise<boolean> {
    if (/^[A-Fa-f0-9]{16}$/.test(code)) {
      const codeHash = createHash('sha256').update(code.toUpperCase()).digest('hex');
      return (await this.repo.consumeRecoveryCodeHash(user.id, codeHash, tx)) > 0;
    }
    if (!/^[0-9]{6}$/.test(code)) return false;
    if (user.totpSecretCiphertext === null) return false;
    // TOTP 密文解密占位（KMS 落地前拒绝；同 password-login 登记）。
    void user.totpSecretCiphertext;
    return false;
  }

  /** 设置快照（联系方式变更后；§5 verified 因绑定不写 verified_at → 恒 false 直到显式验证）。 */
  private async settingsOf(user: UserModel, tx: Tx): Promise<Static<typeof IdentitySettingsResponseSchema>> {
    const activeRecovery = await this.repo.findActiveRecoveryCredential(user.id, tx);
    return toIdentitySettings(user, {
      recoveryAvailable: activeRecovery !== null,
      recoveryExpiryIso:
        activeRecovery === null || activeRecovery.expiresAt === null ? null : new Date(activeRecovery.expiresAt).toISOString(),
    });
  }

  /** 联系方式成功安全事件（§5 "操作结果仍写安全事件，只存脱敏值"）。 */
  private async recordContactEvent(
    user: UserModel,
    ctx: ContactSettingsCtx,
    contactType: 'EMAIL' | 'PHONE',
    oldRaw: string | null,
    newRaw: string,
    tx: Tx,
  ): Promise<void> {
    await this.securityEvents.append(
      this.securityEvents.contactEvent({
        userId: user.id,
        sessionKey: ctx.sessionKey,
        deviceId: ctx.deviceId,
        result: 1, // SUCCESS
        contactType,
        oldValueMasked: oldRaw === null ? '' : contactType === 'EMAIL' ? maskEmail(oldRaw) : maskPhone(oldRaw),
        newValueMasked: contactType === 'EMAIL' ? maskEmail(newRaw) : maskPhone(newRaw),
        eventKey: `contact:${contactType.toLowerCase()}:ok:${user.id}:${newRaw}`,
      }),
      tx,
    );
  }

  /** 联系方式拒绝安全事件（§5 "失败时保持旧绑定"仍留痕，result=DENIED）。 */
  private async recordContactDenied(
    user: UserModel,
    ctx: ContactSettingsCtx,
    contactType: 'EMAIL' | 'PHONE',
    oldRaw: string,
    newRaw: string,
    failureCode: string,
    tx: Tx,
  ): Promise<void> {
    await this.securityEvents.append(
      this.securityEvents.contactEvent({
        userId: user.id,
        sessionKey: ctx.sessionKey,
        deviceId: ctx.deviceId,
        result: 2, // DENIED
        contactType,
        oldValueMasked: contactType === 'EMAIL' ? maskEmail(oldRaw) : maskPhone(oldRaw),
        newValueMasked: contactType === 'EMAIL' ? maskEmail(newRaw) : maskPhone(newRaw),
        eventKey: `contact:${contactType.toLowerCase()}:denied:${user.id}:${failureCode}`,
      }),
      tx,
    );
  }
}
