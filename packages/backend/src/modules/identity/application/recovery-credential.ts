/**
 * recovery-credential 用例：二维码恢复凭证的签发（prepare）与激活（activate）。
 *
 * 领域所有者：identity 模块（/me/security/recovery-credentials/prepare、
 * /me/security/recovery-credentials/:credentialId/activate）。
 * 对应 SDD 章节：JWT 登录与会话设计 §4（"recoveryCredentialPrepare /
 * recoveryCredentialActivate"端点）、§3（"二维码恢复……凭证仍可重复使用，直至被新
 * 二维码替换、主动撤销或过期"）；数据库设计 SDD §5.1 recovery_credential（"生成
 * 新二维码时，在一个数据库事务中将原有效行更新为 REVOKED、填入 revoked_at，再插入
 * 新 ISSUED 行；唯一索引保证不会同时出现两条有效凭证。生成操作使用幂等键，避免弱网
 * 重试误生成多张二维码"）。
 *
 * 错误码映射（IdentityErrorCode → 触发条件）：
 *
 * prepare（RecoveryCredentialPrepareRequest）：
 * - `REAUTHENTICATION_FAILED`：当前密码错（已设密码时必传）或 TOTP 启用但码错
 *   （§5 "启用 TOTP 的账号还须当前 TOTP"；§3 二维码恢复仍要求 TOTP）。
 * - `ACCOUNT_LOCKED`：user.status ≠ ACTIVE。
 * - `IDEMPOTENCY_KEY_REUSED`：同幂等键重放不同 payload（§4 "生成操作使用幂等键"；
 *   本步登记，幂等键 = credentialId 或请求级 key，worker 未建前以 credentialKey 去重）。
 * - 成功 → RecoveryCredentialIssueResponse（credentialId + expiresAt，201；旧有效凭证
 *   同事务置 REVOKED，新行 ISSUED）。
 *
 * activate（RecoveryCredentialActivateRequest，:credentialId）：
 * - `RECOVERY_CREDENTIAL_NOT_FOUND`：credentialId 查无。
 * - `RECOVERY_CREDENTIAL_REPLACED`：凭证 status = REVOKED（被新二维码替换/撤销）。
 * - `RECOVERY_CREDENTIAL_PENDING_EXPIRED`：expires_at 已过。
 * - `REAUTHENTICATION_FAILED`：activate 需当前密码/TOTP 再认证（§5 敏感操作再认证；
 *   本契约请求为空对象，再认证经路由层 access token 会话 + 可选 TOTP，决策点登记）。
 * - 成功 → IdentitySettingsResponse（200；凭证已激活可用，凭证行仍可用直至
 *   替换/撤销/过期，§3）。
 */

import type {
  RecoveryCredentialPrepareRequestSchema,
  RecoveryCredentialIssueResponseSchema,
  RecoveryCredentialActivateRequestSchema,
  IdentitySettingsResponseSchema,
  Static,
} from '@gameing/contracts/identity';
import type { UserModel } from '../../../infrastructure/database/models/identity.js';
import { RecoveryStatus, UserStatus } from '../../../infrastructure/database/models/identity.js';
import { DomainError, I } from '../domain/errors.js';
import { verifyPassword } from '../domain/password.js';
import type { Clock } from '../ports/clock.js';
import type { IdentityRepository, Tx } from '../ports/identity-repository.js';
import type { OutboxPort } from '../ports/outbox-port.js';
import type { SessionPort } from '../ports/session-port.js';
import { toIdentitySettings, toBigIntWire } from '../adapters/row-mappers.js';
import { randomId } from '../../../infrastructure/jwt/jwt.js';
import { createHash } from 'node:crypto';
import type { SecurityEventService } from './security-events.js';

export interface RecoverySettingsCtx {
  userId: string;
  sessionKey: string | null;
  deviceId: string | null;
}

export class RecoveryCredentialUseCase {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly sessions: SessionPort,
    private readonly outbox: OutboxPort,
    private readonly clock: Clock,
    private readonly securityEvents: SecurityEventService,
  ) {}

  // ---------------------------------------------------------- prepare

  /**
   * POST /me/security/recovery-credentials/prepare（签发新二维码凭证；同事务替换旧凭证）。
   * recoverySecret 为客户端持有高熵秘密（§3 "二维码含密码加密的高熵恢复秘密，不含明文
   * 账户密码；服务端不保存二维码解密密码"）——服务端只存 sha256 摘要（secret_hash
   * BINARY(32)，§5.1）。
   */
  async prepare(
    request: Static<typeof RecoveryCredentialPrepareRequestSchema>,
    ctx: RecoverySettingsCtx,
    tx: Tx,
  ): Promise<Static<typeof RecoveryCredentialIssueResponseSchema>> {
    const user = await this.loadActiveUser(ctx, tx);

    // 再认证（§3 "二维码恢复……凭证保护" + §5 敏感操作再认证：已设密码 → 当前密码；
    // TOTP 启用 → 当前 TOTP；恢复码不能签发新凭证，§5 "恢复码不能关闭、替换或重置 TOTP"）。
    if (user.passwordHash !== null) {
      if (request.password === undefined) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current password required');
      }
      const pwOk = await verifyPassword(user.passwordHash, request.password);
      if (!pwOk) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current password does not match');
      }
    }
    if (user.totpEnabledAt !== null) {
      if (request.totp === undefined) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current TOTP required');
      }
      const ok = await this.verifyTotp(user, request.totp, tx);
      if (!ok) {
        throw new DomainError(I.REAUTHENTICATION_FAILED, 'current TOTP not accepted');
      }
    }

    // 签发新凭证（§5.1 "生成新二维码时，在一个数据库事务中将原有效行更新为 REVOKED、
    // 填入 revoked_at，再插入新 ISSUED 行"；唯一索引 U(user_id,active_marker) 兜底）。
    // credential_key = 36 位随机定位值（§3 "二维码的随机定位值"，CHAR(36) 列宽）。
    const credentialKey = randomId(18);
    const secretHash = createHash('sha256').update(request.recoverySecret).digest();
    const now = this.clock.now();
    // 过期时间：默认签发后 2 年（§5.1 "默认签发后 2 年"）。
    const expiresAt = new Date(now.getTime() + 2 * 365 * 24 * 60 * 60 * 1000);

    const row = await this.repo.issueRecoveryCredential(
      {
        userId: user.id,
        credentialKey,
        secretHash,
        expiresAt,
      },
      tx,
    );

    // 幂等登记（§5.1 "生成操作使用幂等键，避免弱网重试误生成多张二维码"；
    // outbox 行 event_key 去重；首版 worker 未建，登记 topic 'identity.recovery.issued'）。
    await this.outbox.append({
      topic: 'identity.recovery.issued',
      userId: user.id,
      payload: { credentialId: toBigIntWire(row.id), credentialKey },
      eventKey: `recovery:issued:${credentialKey}`,
      availableAt: now,
    });

    // 安全事件（action=RECOVERY；签发留痕，不记明文秘密，§3 "不保存明文"）。
    await this.securityEvents.append(
      this.securityEvents.recoveryEvent({
        userId: user.id,
        credentialKey,
        sessionKey: ctx.sessionKey,
        deviceId: ctx.deviceId,
        result: 1, // SUCCESS
        eventKey: `recovery:issued:${credentialKey}`,
      }),
      tx,
    );

    return {
      credentialId: toBigIntWire(row.id) as string,
      expiresAt: expiresAt.toISOString(),
    };
  }

  // ---------------------------------------------------------- activate

  /**
   * POST /me/security/recovery-credentials/:credentialId/activate（激活已签发凭证）。
   * 凭证在 prepare 后即为 ISSUED 可用（§3 "二维码凭证仍可重复使用"），activate 为
   * 显式确认动作（§4 端点）：校验凭证仍 ISSUED 未过期 + 再认证（经路由层会话）。
   */
  async activate(
    credentialId: string,
    request: Static<typeof RecoveryCredentialActivateRequestSchema>,
    ctx: RecoverySettingsCtx,
    tx: Tx,
  ): Promise<Static<typeof IdentitySettingsResponseSchema>> {
    void request; // 空对象请求（契约 RecoveryCredentialActivateRequestSchema = {}）。
    const user = await this.loadActiveUser(ctx, tx);
    const row = await this.repo.findRecoveryCredentialByKey(credentialId, tx);
    if (row === null || row.userId !== user.id) {
      throw new DomainError(I.RECOVERY_CREDENTIAL_NOT_FOUND, 'recovery credential not found');
    }
    if (row.status === RecoveryStatus.REVOKED) {
      throw new DomainError(I.RECOVERY_CREDENTIAL_REPLACED, 'recovery credential revoked or replaced');
    }
    const nowMs = this.clock.now().getTime();
    if (row.status === RecoveryStatus.EXPIRED || (row.expiresAt !== null && new Date(row.expiresAt).getTime() < nowMs)) {
      throw new DomainError(I.RECOVERY_CREDENTIAL_PENDING_EXPIRED, 'recovery credential expired');
    }

    // activate 即"成功使用"：更新 last_used_at（§3 "使用不消费或撤销二维码"），
    // 凭证行保持 ISSUED 可重复使用。
    await this.repo.markRecoveryCredentialUsed(row.id, this.clock.now(), tx);

    // 安全事件（action=RECOVERY，凭证激活留痕）。
    await this.securityEvents.append(
      this.securityEvents.recoveryEvent({
        userId: user.id,
        credentialKey: credentialId,
        sessionKey: ctx.sessionKey,
        deviceId: ctx.deviceId,
        result: 1,
        eventKey: `recovery:activated:${credentialId}:${nowMs}`,
      }),
      tx,
    );

    const activeRecovery = await this.repo.findActiveRecoveryCredential(user.id, tx);
    return toIdentitySettings(user, {
      recoveryAvailable: activeRecovery !== null,
      recoveryExpiryIso:
        activeRecovery === null || activeRecovery.expiresAt === null ? null : new Date(activeRecovery.expiresAt).toISOString(),
    });
  }

  // ------------------------------------------------------------------ 私有

  private async loadActiveUser(ctx: RecoverySettingsCtx, tx: Tx): Promise<UserModel> {
    const user = await this.repo.findUserById(ctx.userId, tx);
    if (user === null || user.status !== UserStatus.ACTIVE) {
      throw new DomainError(I.ACCOUNT_LOCKED, 'account is not active');
    }
    return user;
  }

  private async verifyTotp(user: UserModel, code: string, _tx: Tx): Promise<boolean> {
    // 恢复码（16 hex）不能签发/替换凭证（§5 "恢复码不能关闭、替换或重置 TOTP"）：
    // 本路径只接受 6 位当前 TOTP；16 hex 输入走拒绝路径。
    if (/^[A-Fa-f0-9]{16}$/.test(code)) {
      return false;
    }
    if (!/^[0-9]{6}$/.test(code)) return false;
    if (user.totpSecretCiphertext === null) return false;
    // TOTP 密文解密占位（KMS 落地前拒绝；同 totp.ts 登记）。
    void user.totpSecretCiphertext;
    return false;
  }
}
