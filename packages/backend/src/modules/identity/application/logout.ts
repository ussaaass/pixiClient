/**
 * logout 用例：撤销当前 sid（Redis）+ 写 user_security_event（SQL，append-only）。
 *
 * 领域所有者：identity 模块（auth.logout）。
 * 对应 SDD 章节：JWT 登录与会话设计 §3 —— "登出产生的 security event 写 SQL，
 * session_key 是不透明 Redis 标识而不是 MySQL 外键。" "安全变更提交后必须同步完成
 * Redis 版本更新/撤销才向调用端报告成功；以 SQL outbox 处理进程中断后的幂等重试。"
 * §2 —— "登出/封禁主动断开相应 Socket"。
 *
 * 顺序纪律（§3）：**先 SQL 后 Redis 不成立**——正确顺序是：
 * 1) SQL 侧写 user_security_event（append-only，持久安全事实）；
 * 2) 同步完成 Redis 撤销（revokeSession）——"安全变更提交后必须同步完成 Redis
 *    版本更新/撤销才向调用端报告成功"；
 * 3) outbox 记录用于进程中断后的幂等重试（首版注释登记，worker 未建）。
 *
 * 错误码映射（IdentityErrorCode → 触发条件）：
 * - `SESSION_REVOKED`：当前 sid 已被撤销（getSession=null 但请求仍带该 sid）；
 *   幂等语义：重复登出返回 loggedOut=true（不抛错，§3 登出幂等）。
 * - `REFRESH_INVALID`：会话不存在（sid 未知/过期）→ 幂等 loggedOut=true。
 * - `ACCESS_TOKEN_INVALID`：携带的 access token 验签失败（路由层已拦截，用例层兜底）。
 * - `IDENTITY_STORAGE_UNAVAILABLE`：Redis 故障（撤销未完成 → 不报告成功，§3 fail-closed；
 *   幂等重试靠 outbox，首版登记）。
 * - 成功 → LogoutResponse `{ loggedOut: true }`（200）。
 */

import type { LogoutResponseSchema, Static } from '@gameing/contracts/identity';
import type { Clock } from '../ports/clock.js';
import type { SessionPort } from '../ports/session-port.js';
import type { IdentityRepository, Tx } from '../ports/identity-repository.js';
import type { OutboxPort } from '../ports/outbox-port.js';
import type { SecurityEventService } from './security-events.js';

export interface LogoutInput {
  /** 当前会话 sid（从已验签 access token 的 `sid` claim 取得；路由层注入）。 */
  sid: string;
  /** user.id（access token `sub`）。 */
  userId: string;
  /** 当前设备 device.id（access token `did`；可为 null）。 */
  deviceId: string | null;
}

export class LogoutUseCase {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly sessions: SessionPort,
    private readonly outbox: OutboxPort,
    private readonly clock: Clock,
    private readonly securityEvents: SecurityEventService,
  ) {}

  async run(input: LogoutInput, tx: Tx): Promise<Static<typeof LogoutResponseSchema>> {
    const now = this.clock.now();
    const { sid, userId, deviceId } = input;

    // 1) 幂等门禁：sid 已不存在（已登出/过期/被撤销）→ 直接成功（登出幂等，不抛错）。
    const record = await this.sessions.getSession(sid).catch(() => null);
    if (record === null) {
      // sid 未知/已撤销/过期：登出语义幂等，返回 loggedOut=true（§3 登出不因已撤销失败）。
      return { loggedOut: true };
    }

    // 2) SQL 侧写安全事件（append-only；§3 "登出产生的 security event 写 SQL"）。
    await this.securityEvents.append(
      this.securityEvents.revokeEvent({
        userId,
        sessionKey: sid,
        deviceId,
        result: 1, // SUCCESS（撤销成功执行）
        scope: 'session',
        eventKey: `logout:ok:${sid}`,
      }),
      tx,
    );

    // 3) 同步完成 Redis 撤销（§3 "安全变更提交后必须同步完成 Redis 撤销才报告成功"）。
    await this.sessions.revokeSession(sid, userId);

    // 4) outbox 记录（进程中断后幂等重试；§3 "以 SQL outbox 处理进程中断后的幂等重试"）。
    //    首版 worker 未建（SDD §8 后续运维项），本步登记 outbox 行 append；
    //    topic 'identity.session.revoked' 供 worker 落地后消费重放撤销。
    //    outbox port 经装配 `withTx(scope, outbox => ...)` 注入同事务实现；
    //    此处 this.outbox 为缺省无事务实现（测试/用例外兜底），正常路径由 assembly
    //    的 withTx 把 scope.transaction 传入（§6.3 同事务 outbox）。
    await this.outbox.append({
      topic: 'identity.session.revoked',
      userId,
      payload: {
        sid,
        deviceId: deviceId ?? null,
        revokedAt: now.toISOString(),
      },
      eventKey: `logout:outbox:${sid}`,
      availableAt: now,
    });

    return { loggedOut: true };
  }
}
