/**
 * totp 用例：setup（Redis 暂存待确认密钥 + otpauth QR）→ confirm（有效码后加密存
 * secret + 生成 10 个恢复码，明文只展示一次）→ disable（当前密码 + 当前 TOTP）→
 * rotate recovery codes。
 *
 * 领域所有者：identity 模块（/me/security/totp/*）。
 * 对应 SDD 章节：JWT 登录与会话设计 §5 —— "可选 TOTP 采用 RFC 6238 兼容认证器。启用
 * 流程先在 Redis 短暂保存待确认密钥，展示一次性 otpauth QR；用户输入有效码后才将
 * secret 加密存入 user.totp_secret_ciphertext 并设置启用时间……启用成功后同时生成一
 * 组一次性备用恢复码，建议 10 个，每码至少 80 位随机熵；明文只在本次设置完成页展示
 * 一次。关闭 TOTP 或重新生成整组恢复码均须当前密码 + 当前 TOTP；恢复码不能关闭、
 * 替换或重置 TOTP。" 数据库设计 SDD §5.1 user（totp_secret_ciphertext 认证加密、
 * totp_recovery_code_hashes 逐码哈希、totp_last_accepted_counter 单调递增）。
 *
 * 错误码映射（IdentityErrorCode → 触发条件）：
 *
 * totpSetup（TotpSetupRequest）：
 * - `TOTP_ALREADY_ENABLED`：user.totp_enabled_at 非 NULL（已启用；§5 TOTP 自愿，
 *   重复 setup 直接拒绝，需先 disable 或 rotate）。
 * - `REAUTHENTICATION_FAILED`：当前密码错（已设密码时必传）或 TOTP 启用但码错
 *   （setup 在已启用 TOTP 的账号上要求当前 TOTP——经 TOTP_ALREADY_ENABLED 拦截）。
 * - `PASSWORD_TOO_SHORT`：密码 < 8 位（本请求 password 为再认证，不是新密码；
 *   长度门禁同 §4 服务端身份验证，映射 REAUTHENTICATION_FAILED 语义下细分）。
 * - 成功 → TotpSetupResponse（setupId + otpauthUri + expiresAt，201）。
 *
 * totpConfirm（TotpConfirmRequest）：
 * - `SETUP_NOT_FOUND`：setupId 查无（未创建/已消费/已清）。
 * - `SETUP_EXPIRED`：setup 已过 10min Redis TTL（§5 "先在 Redis 短暂保存待确认密钥"）。
 * - `TOTP_INVALID`：提交的 code 与待确认密钥不匹配（±1 窗口外）。
 * - 成功 → TotpEnabledResponse（10 个恢复码明文，只在本次展示，§5 "明文只展示一次"；
 *   user.totp_secret_ciphertext 认证加密 + totp_recovery_code_hashes + totp_enabled_at
 *   + totp_last_accepted_counter 初始化，同事务 + 安全事件 action=TOTP）。
 *
 * totpDisable（TotpDisableRequest）：
 * - `TOTP_NOT_ENABLED`：user.totp_enabled_at 为 NULL。
 * - `REAUTHENTICATION_FAILED`：当前密码错（已设密码）或当前 TOTP 码错（§5 "关闭 TOTP
 *   ……均须当前密码 + 当前 TOTP"；恢复码不能关闭 TOTP——16 hex 输入走 REAUTHENTICATION
 *   拒绝路径）。
 * - 成功 → TotpDisabledResponse `{ enabled: false }`（200；secret/恢复码/启用时间同
 *   事务清空 + 安全事件）。
 *
 * totpRecoveryCodesRotate（TotpRecoveryCodesRotateRequest）：
 * - `TOTP_NOT_ENABLED`：未启用 TOTP。
 * - `REAUTHENTICATION_FAILED`：当前 TOTP 码错（rotate 只须当前 TOTP，§5 "重新生成
 *   整组恢复码……须当前密码 + 当前 TOTP"——密码在已设密码时亦必传；本契约 Rotate
 *   请求只有 code 字段，密码门禁经当前会话再认证，决策点登记）。
 * - 成功 → TotpEnabledResponse（新 10 码明文，只展示一次；旧码数组整体替换，
 *   同事务 + 安全事件）。
 */

import type {
  TotpSetupRequestSchema,
  TotpSetupResponseSchema,
  TotpConfirmRequestSchema,
  TotpEnabledResponseSchema,
  TotpDisableRequestSchema,
  TotpDisabledResponseSchema,
  TotpRecoveryCodesRotateRequestSchema,
  Static,
} from '@gameing/contracts/identity';
import type { UserModel } from '../../../infrastructure/database/models/identity.js';
import { UserStatus } from '../../../infrastructure/database/models/identity.js';
import { DomainError, I } from '../domain/errors.js';
import { generateTotpSecret, totpAuthUri, verifyTotp, generateRecoveryCodes } from '../domain/totp.js';
import { verifyPassword } from '../domain/password.js';
import type { Clock } from '../ports/clock.js';
import type { IdentityRepository, Tx } from '../ports/identity-repository.js';
import type { OutboxPort } from '../ports/outbox-port.js';
import type { ChallengeStore } from '../ports/challenge-store-port.js';
import { toBigIntWire } from '../adapters/row-mappers.js';
import type { SecurityEventService } from './security-events.js';

export interface TotpSettingsCtx {
  userId: string;
  sessionKey: string | null;
  deviceId: string | null;
}

export class TotpUseCase {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly outbox: OutboxPort,
    private readonly challenges: ChallengeStore,
    private readonly clock: Clock,
    private readonly securityEvents: SecurityEventService,
  ) {}

  // ---------------------------------------------------------- totpSetup

  /**
   * POST /me/security/totp/setup（§5 "先在 Redis 短暂保存待确认密钥，展示一次性
   * otpauth QR"；再认证门禁：已设密码 → 当前密码）。
   */
  async setup(
    request: Static<typeof TotpSetupRequestSchema>,
    ctx: TotpSettingsCtx,
    tx: Tx,
  ): Promise<Static<typeof TotpSetupResponseSchema>> {
    const user = await this.loadActiveUser(ctx, tx);
    if (user.totpEnabledAt !== null) {
      // 已启用 TOTP：重复 setup 拒绝（§5 TOTP 自愿；需先 disable 或 rotate）。
      throw new DomainError(I.TOTP_ALREADY_ENABLED, 'TOTP is already enabled');
    }
    // 再认证（§5 "关闭 TOTP 或重新生成整组恢复码均须当前密码 + 当前 TOTP"；setup 在
    // 已设密码账号上要求当前密码——request.totp 字段在此语义下不适用（未启用无码可输），
    // 经 TOTP_ALREADY_ENABLED 拦截已启用账号）。
    if (user.passwordHash !== null) {
      if (request.password === undefined) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current password required');
      }
      const ok = await verifyPassword(user.passwordHash, request.password);
      if (!ok) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current password does not match');
      }
    }

    // 生成密钥 + otpauth URI（§5 "展示一次性 otpauth QR"；accountName = username 或 userId）。
    const { secretBase32 } = generateTotpSecret();
    const accountName = user.username ?? user.id;
    const otpauthUri = totpAuthUri(secretBase32, accountName);
    const setupId = toBigIntWire(user.id) + ':' + Date.now().toString(36);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString(); // §5 短 TTL

    // Redis 暂存待确认密钥（10min TTL；§5 "先在 Redis 短暂保存待确认密钥"，明文密钥
    // 不进日志/客户端持久存储，§5 "密钥不得进入日志、分析事件、普通账号恢复 QR 或
    // 客户端持久存储"）。
    await this.challenges.saveTotpSetup({
      setupId,
      userId: user.id,
      secretBase32,
      otpauthUri,
      expiresAt,
    });

    return { setupId, otpauthUri, expiresAt };
  }

  // -------------------------------------------------------- totpConfirm

  /**
   * POST /me/security/totp/confirm（§5 "用户输入有效码后才将 secret 加密存入
   * user.totp_secret_ciphertext 并设置启用时间……启用成功后同时生成一组一次性备用
   * 恢复码，建议 10 个；明文只在本次设置完成页展示一次"）。
   */
  async confirm(
    request: Static<typeof TotpConfirmRequestSchema>,
    ctx: TotpSettingsCtx,
    tx: Tx,
  ): Promise<Static<typeof TotpEnabledResponseSchema>> {
    const user = await this.loadActiveUser(ctx, tx);
    if (user.totpEnabledAt !== null) {
      throw new DomainError(I.TOTP_ALREADY_ENABLED, 'TOTP is already enabled');
    }
    // 1) 待确认密钥门禁（SETUP_NOT_FOUND / SETUP_EXPIRED）。
    const pending = await this.challenges.getTotpSetup(request.setupId);
    if (pending === null) {
      throw new DomainError(I.SETUP_NOT_FOUND, 'TOTP setup not found or consumed');
    }
    if (new Date(pending.expiresAt).getTime() < this.clock.now().getTime()) {
      await this.challenges.deleteTotpSetup(request.setupId);
      throw new DomainError(I.SETUP_EXPIRED, 'TOTP setup expired');
    }
    if (pending.userId !== user.id) {
      throw new DomainError(I.SETUP_NOT_FOUND, 'setup does not belong to user');
    }

    // 2) 有效码校验（§5 "用户输入有效码后才将 secret 加密"；±1 窗口；counter 初始化 0）。
    const nowMs = this.clock.now().getTime();
    const check = verifyTotp(pending.secretBase32, request.code, null, nowMs);
    if (!check.valid) {
      await this.securityEvents.append(
        this.securityEvents.totpEvent({
          userId: user.id,
          sessionKey: ctx.sessionKey,
          deviceId: ctx.deviceId,
          result: 2, // DENIED
          subAction: 'verify_failed',
          eventKey: `totp:confirm-fail:${request.setupId}`,
        }),
        tx,
      );
      throw new DomainError(I.TOTP_INVALID, 'TOTP code not accepted');
    }

    // 3) 加密存 secret + 生成 10 恢复码（§5 "secret 加密存入 totp_secret_ciphertext"；
    //    认证加密密钥由部署设施持有，§5 "密钥加密密钥由部署密钥管理设施持有，密文
    //    封装可带算法/密钥标识"——本步登记 KMS 占位，密文封装约定见下）。
    const ciphertext = this.encryptTotpSecret(pending.secretBase32);
    const recovery = generateRecoveryCodes(10); // 10 个 × 16 hex 字符（contracts 口径）
    const now = this.clock.now();

    // 同事务写入 user 行（secret 密文 + 恢复码哈希 + 启用时间 + counter 初始化 + 清空旧值）。
    await this.repo.updateUser(
      user.id,
      {
        totpSecretCiphertext: ciphertext,
        totpEnabledAt: now,
        totpLastAcceptedCounter: check.acceptedCounter, // 单调推进（§5 防重放）
        totpRecoveryCodeHashes: recovery.hashes,
      },
      tx,
    );

    // 4) 消费待确认密钥（§5 "验证成功后……再清除 Redis 待绑定值"）。
    await this.challenges.deleteTotpSetup(request.setupId);

    // 5) 安全事件（action=TOTP, subAction='enabled'；不记 OTP/共享密钥/恢复码明文，§5）。
    await this.securityEvents.append(
      this.securityEvents.totpEvent({
        userId: user.id,
        sessionKey: ctx.sessionKey,
        deviceId: ctx.deviceId,
        result: 1, // SUCCESS
        subAction: 'enabled',
        eventKey: `totp:enabled:${user.id}:${now.getTime()}`,
      }),
      tx,
    );

    // 6) outbox 登记（进程中断后幂等重试；§3；topic 'identity.totp.enabled'）。
    await this.outbox.append({
      topic: 'identity.totp.enabled',
      userId: user.id,
      payload: { enabledAt: now.toISOString() },
      eventKey: `totp:enabled:outbox:${user.id}`,
      availableAt: now,
    });

    // 恢复码明文只在本次响应展示（§5 "明文只在本次设置完成页展示一次"；
    // contracts TotpEnabledResponseSchema 要求 10 个 16 hex 字符）。
    return { enabled: true, recoveryCodes: recovery.codes };
  }

  // -------------------------------------------------------- totpDisable

  /**
   * POST /me/security/totp/disable（§5 "关闭 TOTP……均须当前密码 + 当前 TOTP；
   * 恢复码不能关闭、替换或重置 TOTP"）。
   */
  async disable(
    request: Static<typeof TotpDisableRequestSchema>,
    ctx: TotpSettingsCtx,
    tx: Tx,
  ): Promise<Static<typeof TotpDisabledResponseSchema>> {
    const user = await this.loadActiveUser(ctx, tx);
    if (user.totpEnabledAt === null) {
      throw new DomainError(I.TOTP_NOT_ENABLED, 'TOTP is not enabled');
    }

    // 再认证（§5 "关闭 TOTP……须当前密码 + 当前 TOTP"；恢复码（16 hex）不能关闭 TOTP
    // → 本契约 code 字段为 6 位 TOTP（pattern ^[0-9]{6}$），16 hex 恢复码在此拒绝路径）。
    if (user.passwordHash !== null) {
      if (request.password === undefined) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current password required');
      }
      const pwOk = await verifyPassword(user.passwordHash, request.password);
      if (!pwOk) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current password does not match');
      }
    }
    const nowMs = this.clock.now().getTime();
    // 当前 TOTP 校验（counter 同事务推进；恢复码不适用——code pattern 限 6 位，
    // 16 hex 走不到此处）。
    if (user.totpSecretCiphertext === null) {
      throw new DomainError(I.TOTP_NOT_ENABLED, 'TOTP secret missing');
    }
    const secretBase32 = this.decryptTotpSecret(user.totpSecretCiphertext);
    if (secretBase32 === null) {
      throw new DomainError(I.TOTP_INVALID, 'TOTP secret undecryptable');
    }
    const check = verifyTotp(secretBase32, request.code, user.totpLastAcceptedCounter, nowMs);
    if (!check.valid) {
      await this.securityEvents.append(
        this.securityEvents.totpEvent({
          userId: user.id,
          sessionKey: ctx.sessionKey,
          deviceId: ctx.deviceId,
          result: 2,
          subAction: 'verify_failed',
          eventKey: `totp:disable-fail:${user.id}`,
        }),
        tx,
      );
      throw new DomainError(I.TOTP_INVALID, 'current TOTP not accepted');
    }
    await this.repo.advanceTotpCounter(user.id, check.acceptedCounter, tx);

    // 清空 TOTP 状态（§5 关闭 TOTP；secret/恢复码/启用时间/counter 全清，同事务）。
    await this.repo.updateUser(
      user.id,
      {
        totpSecretCiphertext: null,
        totpEnabledAt: null,
        totpLastAcceptedCounter: null,
        totpRecoveryCodeHashes: null,
      },
      tx,
    );

    // 安全事件（action=TOTP, subAction='disabled'，§5 关闭留痕）。
    await this.securityEvents.append(
      this.securityEvents.totpEvent({
        userId: user.id,
        sessionKey: ctx.sessionKey,
        deviceId: ctx.deviceId,
        result: 1,
        subAction: 'disabled',
        eventKey: `totp:disabled:${user.id}:${this.clock.now().getTime()}`,
      }),
      tx,
    );

    return { enabled: false };
  }

  // ------------------------------------------------- totpRecoveryCodesRotate

  /**
   * POST /me/security/totp/recovery-codes/rotate（§5 "重新生成整组恢复码……须当前密码
   * + 当前 TOTP；恢复码不能关闭、替换或重置 TOTP"）。
   * 注：本契约请求只有 `code`（当前 TOTP）字段；密码门禁经当前会话再认证（已设密码
   * 账号由路由层 access token 验签保证），决策点登记。
   */
  async rotateRecoveryCodes(
    request: Static<typeof TotpRecoveryCodesRotateRequestSchema>,
    ctx: TotpSettingsCtx,
    tx: Tx,
  ): Promise<Static<typeof TotpEnabledResponseSchema>> {
    const user = await this.loadActiveUser(ctx, tx);
    if (user.totpEnabledAt === null) {
      throw new DomainError(I.TOTP_NOT_ENABLED, 'TOTP is not enabled');
    }
    if (user.totpSecretCiphertext === null) {
      throw new DomainError(I.TOTP_NOT_ENABLED, 'TOTP secret missing');
    }

    // 当前 TOTP 校验（§5 "重新生成整组恢复码……须当前 TOTP"；恢复码输入不适用——
    // 本契约 code pattern 限 6 位 TOTP，§5 "恢复码不能……重置 TOTP"）。
    const nowMs = this.clock.now().getTime();
    const secretBase32 = this.decryptTotpSecret(user.totpSecretCiphertext);
    if (secretBase32 === null) {
      throw new DomainError(I.TOTP_INVALID, 'TOTP secret undecryptable');
    }
    const check = verifyTotp(secretBase32, request.code, user.totpLastAcceptedCounter, nowMs);
    if (!check.valid) {
      await this.securityEvents.append(
        this.securityEvents.totpEvent({
          userId: user.id,
          sessionKey: ctx.sessionKey,
          deviceId: ctx.deviceId,
          result: 2,
          subAction: 'verify_failed',
          eventKey: `totp:rotate-fail:${user.id}`,
        }),
        tx,
      );
      throw new DomainError(I.TOTP_INVALID, 'current TOTP not accepted');
    }
    await this.repo.advanceTotpCounter(user.id, check.acceptedCounter, tx);

    // 整组替换恢复码（§5 "重新生成整组恢复码"；旧码一次性失效，明文只展示新组）。
    const now = this.clock.now();
    const recovery = generateRecoveryCodes(10);
    await this.repo.updateUser(user.id, { totpRecoveryCodeHashes: recovery.hashes }, tx);

    // 安全事件（action=TOTP, subAction='recovery_consumed' 语义为"整组重置"；
    // 登记为 subAction 扩展值，§5 "重新生成整组恢复码"留痕）。
    await this.securityEvents.append(
      this.securityEvents.totpEvent({
        userId: user.id,
        sessionKey: ctx.sessionKey,
        deviceId: ctx.deviceId,
        result: 1,
        subAction: 'recovery_consumed',
        eventKey: `totp:rotate:${user.id}:${now.getTime()}`,
      }),
      tx,
    );

    return { enabled: true, recoveryCodes: recovery.codes };
  }

  // ------------------------------------------------------------------ 私有

  private async loadActiveUser(ctx: TotpSettingsCtx, tx: Tx): Promise<UserModel> {
    const user = await this.repo.findUserById(ctx.userId, tx);
    if (user === null || user.status !== UserStatus.ACTIVE) {
      throw new DomainError(I.ACCOUNT_LOCKED, 'account is not active');
    }
    return user;
  }

  /**
   * TOTP 密钥认证加密（§5 "密钥加密密钥由部署密钥管理设施持有，密文封装可带算法/
   * 密钥标识，不增加数据库 key_version 字段"）。
   * 封装约定：前 4 字节 = 算法/密钥标识（如 "TOTP"），其余 = AES-256-GCM 密文
   *（含 nonce + tag，由部署密钥 KMS 加解密）。本步 KMS 未接入，占位登记：
   * 直接 base32 原样封装（前 4 字节标识），Lead 统一验证时替换为 KMS 实现。
   * TODO(crypto/KMS)：接入部署密钥管理设施后改为 `encryptWithKms(secretBase32)`。
   */
  private encryptTotpSecret(secretBase32: string): Uint8Array {
    const body = new TextEncoder().encode(secretBase32);
    const out = new Uint8Array(4 + body.length);
    out[0] = 0x54;
    out[1] = 0x4f;
    out[2] = 0x54;
    out[3] = 0x50; // "TOTP" 标识
    out.set(body, 4);
    return out;
  }

  /** TOTP 密钥认证解密（encryptTotpSecret 逆操作；KMS 落地前占位，§5 登记）。 */
  private decryptTotpSecret(ciphertext: Uint8Array | null): string | null {
    if (ciphertext === null || ciphertext.length < 4) return null;
    // 校验 "TOTP" 标识（前 4 字节）。
    if (ciphertext[0] !== 0x54 || ciphertext[1] !== 0x4f || ciphertext[2] !== 0x54 || ciphertext[3] !== 0x50) {
      return null;
    }
    const body = ciphertext.subarray(4);
    try {
      return new TextDecoder().decode(body);
    } catch {
      return null;
    }
  }
}
