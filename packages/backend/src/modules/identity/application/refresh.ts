/**
 * refresh 用例：HttpOnly Cookie 读 refresh token → Lua 原子轮换 → 复用检测撤销
 * + 安全事件 + 30s 弱网重放原结果 + auth_version 比对门禁（§3）。
 *
 * 领域所有者：identity 模块（auth.refresh）。
 * 对应 SDD 章节：JWT 登录与会话设计 §3 —— "每次刷新通过 Lua/原子操作比较当前摘要、
 * 原子轮换并推进序号；已消费凭证被不同操作再次使用时撤销该 session 并记持久安全事件。
 * 30 秒弱网重放窗口：同凭证+同 operationId 重放返回原结果，不生成新代。" §2
 * （"refresh token 使用同站 Secure/HttpOnly Cookie，刷新接口校验 Origin/CSRF"）。
 *
 * 错误码映射（IdentityErrorCode → 触发条件）：
 * - `REFRESH_INVALID`：refresh token 查无 session（Lua MISS）或 session 已过期
 *   （Lua EXPIRED，绝对寿命 30 天已过）。
 * - `REFRESH_REVOKED`：session 被撤销（登出/全设备退出/设备撤销后 getSession=null
 *   且 Lua MISS 的主动撤销分支）；auth_version 不一致（改密后旧 session 全失效，§3
 *   "凡保护请求验签后均检查 session 仍有效且版本相同"）→ 归 REFRESH_REVOKED。
 * - `REFRESH_REUSE_DETECTED`：已消费凭证再次使用（RFC 9700 复用检测；Lua REUSE 分支
 *   撤销整 session + 持久安全事件；§3 "已消费凭证被不同操作再次使用时撤销该 session
 *   并记持久安全事件"）。
 * - `AUTH_RATE_LIMITED`：刷新限频窗口超限（按 userId 计数，§4）。
 * - `IDENTITY_STORAGE_UNAVAILABLE`：Redis 故障（fail-closed，§3 "Redis 不可用时
 *   受保护请求失败关闭"）。
 * - 成功（轮换/重放）→ SessionResponse（新 access + 新 refresh；弱网重放 = 原代结果，
 *   不生成新代，§3 "刷新响应丢失仅重放一次既有结果"）。
 */

import type { UserModel } from '../../../infrastructure/database/models/identity.js';
import type { Clock } from '../ports/clock.js';
import type { IdentityRepository, Tx } from '../ports/identity-repository.js';
import type { JwtIssuerPort } from '../ports/jwt-port.js';
import type { AuthRateLimitPort, RefreshRotationPort } from '../ports/refresh-rotation-port.js';
import type { SessionPort, SessionRecord } from '../ports/session-port.js';
import { DomainError, I } from '../domain/errors.js';
import type { PrincipalType } from '../../../infrastructure/redis/session-store.js';
import { ACCESS_TOKEN_TTL_MS } from '../../../infrastructure/redis/session-store.js';
import { toPlayerUser } from '../adapters/row-mappers.js';
import type { SecurityEventService } from './security-events.js';
import type { SessionResult } from './session-result.js';
import { decryptReplayToken, encryptReplayToken } from '../domain/refresh-replay-crypto.js';

export interface RefreshInput {
  /** refresh token 明文（传输层从 HttpOnly Cookie 读取，§2；用例不读 body）。 */
  refreshToken: string;
  /** 会话 sid（与 refresh token 配对经 HttpOnly Cookie 双值存于路由层，§3；本步
   *  session-store 无 hash→sid 倒排索引，路由层负责把 sid 传给用例，决策点登记）。 */
  sid: string;
  /** 客户端单飞操作 ID（§2 "同一页面/多标签协调一个操作 ID"；多标签不触发随机登出）。 */
  operationId: string;
  ctx: {
    principalType: PrincipalType;
    audience: string;
  };
}

export class RefreshUseCase {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly sessions: SessionPort,
    private readonly rotation: RefreshRotationPort,
    private readonly jwt: JwtIssuerPort,
    private readonly clock: Clock,
    private readonly rateLimit: AuthRateLimitPort,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async run(input: RefreshInput, tx: Tx): Promise<SessionResult> {
    const now = this.clock.now();
    const nowMs = now.getTime();
    const presentedHash = this.jwt.hashRefreshToken(input.refreshToken);

    // 1. 定位 Redis 权威 session；sid 与 refresh token 由 HttpOnly Cookie 配对传入。
    const sid = input.sid;
    const record = await this.sessions.getSession(sid);
    if (record === null) {
      // session 不存在：REFRESH_REVOKED（主动撤销）或 REFRESH_INVALID（未知 token），
      // 无法区分时按 INVALID 登记（§4 错误码常量化，区分过期/已撤销/刷新复用）。
      throw new DomainError(I.REFRESH_INVALID, 'refresh token session not found');
    }

    // 2. 限频（按 userId 计数，§4 AUTH_RATE_LIMITED）。
    const rate = await this.rateLimit.check(record.userId, nowMs);
    if (rate.limited) {
      throw new DomainError(I.AUTH_RATE_LIMITED, 'rate limit exceeded', { retryable: true });
    }

    // 3. 重放判断与代际校验均在下方 Lua 中原子完成，避免 GET/Lua 之间的 TOCTOU。
    // 4. Lua 原子轮换（比较摘要 → 推进序号 → 写新摘要 → 缓存重放结果，§3）。
    //    新一代 refresh token 由本用例生成（高熵不透明；摘要进 Lua）。
    const newRefreshToken = this.jwt.createRefreshToken();
    const newHash = this.jwt.hashRefreshToken(newRefreshToken);
    const encryptedRefreshToken = encryptReplayToken(newRefreshToken, `${sid}:${presentedHash}:${input.operationId}`);
    const outcome = await this.rotation.rotateRefresh(sid, presentedHash, newHash, encryptedRefreshToken, input.operationId, nowMs);

    if (outcome.kind === 'REPLAY') {
      const replayToken = decryptReplayToken(outcome.replayCache.encryptedRefreshToken, `${sid}:${presentedHash}:${input.operationId}`);
      return await this.reissueSession(record, replayToken, input.ctx, now, nowMs, tx);
    }

    // 4a. session 不存在（Lua MISS）：撤销/未知 → REFRESH_REVOKED（区别于 REFRESH_INVALID
    // 的"无 session 行"；Lua MISS 表示 Redis 侧无记录，多为撤销后 TTL 清掉）。
    if (outcome.kind === 'MISS') {
      throw new DomainError(I.REFRESH_REVOKED, 'session revoked or expired');
    }
    // 4b. 绝对寿命已过（Lua EXPIRED）→ REFRESH_INVALID（过期，§4 区分"过期"）。
    if (outcome.kind === 'EXPIRED') {
      throw new DomainError(I.REFRESH_INVALID, 'session expired');
    }
    // 4c. 复用检测（§3 "已消费凭证被不同操作再次使用时撤销该 session 并记持久安全事件"）。
    if (outcome.kind === 'REUSE_DETECTED') {
      const ownerUserId = record.userId;
      await this.securityEvents.append(
        this.securityEvents.refreshReuseEvent({
          userId: ownerUserId,
          sessionKey: sid,
          result: 1, // SUCCESS（撤销动作成功执行；事件记录的是复用检测这一安全事实）
          eventKey: `refresh:reuse:${sid}:${presentedHash}`,
        }),
        tx,
      );
      throw new DomainError(I.REFRESH_REUSE_DETECTED, 'refresh token reuse detected; session revoked');
    }

    // 4d. Lua OK 已原子推进会话与 TTL；随后校验账号版本并签发新 access。
    return await this.issueRotated(record, newRefreshToken, input.ctx, now, nowMs, tx);
  }

  // ------------------------------------------------------------------ 私有

  /** auth_version 比对门禁（§3 "凡保护请求验签后均检查 session 仍有效且版本相同"）。 */
  private async checkAuthVersion(user: UserModel, recordAuthVersion: string): Promise<void> {
    const sqlAuthVersion = user.authVersion ?? '1';
    if (recordAuthVersion !== sqlAuthVersion) {
      // 版本不一致：改密/恢复/全设备退出后旧 session 全失效（§3）。
      throw new DomainError(I.REFRESH_REVOKED, 'auth version mismatch; session invalidated');
    }
  }

  private async issueRotated(
    record: SessionRecord,
    newRefreshToken: string,
    ctx: RefreshInput['ctx'],
    now: Date,
    nowMs: number,
    tx: Tx,
  ): Promise<SessionResult> {
    const user = await this.repo.findUserById(record.userId, tx);
    if (user === null || user.status !== 1) {
      throw new DomainError(I.REFRESH_REVOKED, 'user inactive; session invalidated');
    }
    await this.checkAuthVersion(user, record.authVersion);
    return this.signSession(record, user, newRefreshToken, ctx, now, nowMs, tx);
  }

  /** 弱网重放原结果（§3 "刷新响应丢失仅重放一次既有结果"；不生成新代）。 */
  private async reissueSession(
    record: SessionRecord,
    replayRefreshToken: string,
    ctx: RefreshInput['ctx'],
    now: Date,
    nowMs: number,
    tx: Tx,
  ): Promise<SessionResult> {
    const user = await this.repo.findUserById(record.userId, tx);
    if (user === null || user.status !== 1) {
      throw new DomainError(I.REFRESH_REVOKED, 'user inactive; session invalidated');
    }
    await this.checkAuthVersion(user, record.authVersion);
    // 重放加密缓存中的原 refresh token，不产生下一代凭证。
    return this.signSession(record, user, replayRefreshToken, ctx, now, nowMs, tx);
  }

  private async signSession(
    record: { sessionId: string; userId: string; deviceId: string | null; authVersion: string },
    user: UserModel,
    newRefreshToken: string,
    ctx: RefreshInput['ctx'],
    now: Date,
    nowMs: number,
    tx: Tx,
  ): Promise<SessionResult> {
    void tx; // 签名/签发无需写 SQL（session 在 Redis；§3 跨存储窗口）；保留参数对齐调用链。
    const sid = record.sessionId;
    const accessToken = await this.jwt.signAccessToken({
      userId: user.id,
      sid,
      deviceId: record.deviceId,
      authVersion: record.authVersion,
      audience: ctx.audience,
      now,
    });
    const expiresAtIso = new Date(nowMs + ACCESS_TOKEN_TTL_MS).toISOString();
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresAt: expiresAtIso,
      user: toPlayerUser(user),
      device: { deviceId: record.deviceId ?? user.id, trusted: true },
      sid,
      refreshToken: newRefreshToken,
    };
  }
}
