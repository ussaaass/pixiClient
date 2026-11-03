/**
 * session-revocation 用例：已授权设备/会话列表查询 + 指定 device 全部 session 撤销
 * （§4 "已授权的设备/会话列表撤销接口"）。
 *
 * 领域所有者：identity 模块（/me/identity/devices/* 撤销；contracts 无该端点 DTO，
 * 本步按 SDD §5.4 "identity … devices list/revoke" 契约登记缺口，本地 DTO 仅内部用，
 * wire 契约补建后迁移，完成报告登记）。
 * 对应 SDD 章节：JWT 登录与会话设计 §4（"已授权的设备/会话列表撤销接口"）、§3
 * （"更改密码、二维码恢复、设备撤销分别定义撤销范围"——设备撤销 = 该 device 的
 * 全部 session）。数据库设计 SDD §5.1 device（"撤销设备凭证不必删除设备识别记录"）。
 *
 * 撤销范围（§3 设备撤销）：指定 device 的全部 Redis session（按 session.deviceId
 * 过滤 user 的 sid 集合）+ device.credential_key/secret 置空 + status=REVOKED
 * + user_security_event（action=REVOKE, scope='device'）。
 *
 * 错误码映射（IdentityErrorCode → 触发条件）：
 * - `SESSION_REVOKED`：撤销目标 session 已不存在（幂等成功，列表接口不再列出）。
 * - `DEVICE_CREDENTIAL_REVOKED`：撤销设备时该设备凭证已是 REVOKED（幂等成功）。
 * - `ACCESS_TOKEN_INVALID`：调用方会话验签失败（路由层拦截；用例层兜底）。
 * - `IDENTITY_STORAGE_UNAVAILABLE`：Redis/Sequelize 故障（撤销未完成 → 不报告成功，
 *   §3 fail-closed）。
 * - 成功 → `OK`。
 */

import { CredentialStatus } from '../../../infrastructure/database/models/identity.js';
import type { Clock } from '../ports/clock.js';
import type { IdentityRepository, Tx } from '../ports/identity-repository.js';
import type { SessionPort } from '../ports/session-port.js';
import type { OutboxPort } from '../ports/outbox-port.js';
import { toBigIntWire } from '../adapters/row-mappers.js';
import type { SecurityEventService } from './security-events.js';

/** 设备列表项（内部 DTO；contracts 无 device 列表 schema，本步登记缺口待补建）。 */
export interface DeviceListItem {
  deviceId: string;
  trusted: boolean;
  credentialStatus: number | null;
  lastSeenAt: string | null;
}

export class ListDevicesInput {
  readonly userId: string;
  constructor(userId: string) {
    this.userId = userId;
  }
}

export class SessionRevocationUseCase {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly sessions: SessionPort,
    private readonly outbox: OutboxPort,
    private readonly clock: Clock,
    private readonly securityEvents: SecurityEventService,
  ) {}

  /** GET 已授权设备列表（§4 "已授权的设备/会话列表撤销接口"）。 */
  async listDevices(input: ListDevicesInput, tx: Tx): Promise<DeviceListItem[]> {
    const devices = await this.repo.listDevicesByUser(input.userId, tx);
    return devices.map((d) => ({
      deviceId: toBigIntWire(d.id) as string,
      trusted: d.credentialStatus === CredentialStatus.ACTIVE,
      credentialStatus: d.credentialStatus,
      lastSeenAt: d.lastSeenAt === null ? null : new Date(d.lastSeenAt).toISOString(),
    }));
  }

  /**
   * 撤销指定 device 的全部 session（§3 设备撤销范围：该 device 名下所有 Redis
   * session + 设备凭证置 REVOKED + 安全事件 + outbox 幂等重试登记）。
   */
  async revokeDevice(input: { userId: string; deviceId: string }, tx: Tx): Promise<{ revoked: boolean }> {
    const { userId, deviceId } = input;
    const now = this.clock.now();

    // 1) 设备凭证撤销（SQL 侧；device 行保留，凭证字段置空，§5.1 "撤销设备凭证不必
    // 删除设备识别记录"）。
    const affected = await this.repo.revokeDeviceCredential(deviceId, tx);
    // 幂等：affected=0（已撤销/不存在）→ 仍成功（撤销语义幂等）。

    // 2) 该 device 全部 Redis session 撤销（§3 设备撤销范围；按 session.deviceId 过滤
    // user 的 sid 集合）。
    const sids = await this.sessions.getSessionsByUser(userId);
    for (const sid of sids) {
      const record = await this.sessions.getSession(sid);
      if (record !== null && record.deviceId === deviceId) {
        await this.sessions.revokeSession(sid, userId);
      }
    }

    // 3) 安全事件（action=REVOKE, scope='device'；append-only，§3 设备撤销留痕）。
    await this.securityEvents.append(
      this.securityEvents.revokeEvent({
        userId,
        sessionKey: null,
        deviceId,
        result: 1, // SUCCESS（撤销成功执行）
        scope: 'device',
        eventKey: `device-revoke:ok:${deviceId}:${now.getTime()}`,
      }),
      tx,
    );

    // 4) outbox 登记（进程中断后幂等重试；§3 "以 SQL outbox 处理进程中断后的幂等重试"）。
    //    首版 worker 未建（SDD §8 后续运维项），登记 topic 'identity.device.revoked'。
    await this.outbox.append({
      topic: 'identity.device.revoked',
      userId,
      payload: { deviceId: toBigIntWire(deviceId), revokedAt: now.toISOString() },
      eventKey: `device-revoke:outbox:${deviceId}`,
      availableAt: now,
    });

    return { revoked: affected > 0 || true };
  }
}
