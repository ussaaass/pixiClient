/**
 * user_security_event 统一写入入口（脱敏 snapshot，§3 "安全事件只记录脱敏的新旧值"）。
 *
 * 领域所有者：identity 模块（全部安全事件经本服务追加，不直接 create model 行）。
 * 对应 SDD 章节：数据库设计 SDD §5.8 user_security_event（不可变安全事实流水；
 * action_type LOGIN=1/CONTACT=2/PASSWORD=3/RECOVERY=4/REVOKE=5/TOTP=6；
 * result_type SUCCESS=1/DENIED=2/FAILED=3；U(event_key) 幂等）；JWT 设计 §3
 * "已消费凭证被不同操作再次使用时记持久安全事件"、§5 脱敏规则。
 *
 * 脱敏纪律（AGENTS.md + SDD）：snapshot 只记脱敏值或不可逆摘要，不含密码秘密、
 * TOTP 共享密钥、验证码明文、完整账户/联系方式（email/phone 走 mask*，恢复码只记
 * "已消耗一条"）。event_key 为去重键（U），同事件重放不产生第二行。
 */

import type { IdentityRepository, SecurityEventInput, Tx } from '../ports/identity-repository.js';
import { SecurityEventType } from '../../../infrastructure/database/models/identity.js';
import type { SecurityResultType } from '../../../infrastructure/database/models/identity.js';
import { maskEmail, maskPhone } from '../domain/contact-rules.js';
import { maskRecoveryCode } from '../domain/totp.js';

/** 安全事件构建器（脱敏 snapshot 工厂 + 统一 append 入口）。 */
export class SecurityEventService {
  constructor(private readonly repo: IdentityRepository) {}

  /** 追加安全事件（append-only；model hooks 拦截 update/delete）。 */
  async record(input: SecurityEventInput, tx: Tx) {
    return this.repo.createSecurityEvent(input, tx);
  }

  /** 通用追加（用例自定义 snapshot 时直接经此入口，保持 append-only 单一写入点）。 */
  async append(input: SecurityEventInput, tx: Tx): Promise<void> {
    await this.repo.createSecurityEvent(input, tx);
  }

  /** 登录事件（action=LOGIN；成功/失败/锁定/限频均记，snapshot 记脱敏 identifier）。 */
  loginEvent(input: {
    userId: string;
    identifier: string | null;
    sessionKey: string | null;
    deviceId: string | null;
    result: SecurityResultTypeValue;
    /** 失败原因码（IDENTITY 错误码字符串；成功为 null）。 */
    failureCode: string | null;
    eventKey: string;
  }): SecurityEventInput {
    return {
      userId: input.userId,
      sessionKey: input.sessionKey,
      deviceId: input.deviceId,
      eventKey: input.eventKey,
      actionType: SecurityEventType.LOGIN,
      resultType: input.result,
      snapshot: {
        // identifier 可能是 username/email/phone：邮箱/手机走 mask*，username 原样
        //（非联系方式，不脱敏）；判型规则：含 @ → email，纯数字或 + 开头 → phone，
        // 其余按 username。
        identifier: maskIdentifier(input.identifier),
        failureCode: input.failureCode,
      },
    };
  }

  /** 改密码事件（action=PASSWORD；snapshot 记"已改" + 旧密码哈希摘要，不记明文）。 */
  passwordEvent(input: {
    userId: string;
    sessionKey: string | null;
    deviceId: string | null;
    result: SecurityResultTypeValue;
    authVersionBefore: string;
    authVersionAfter: string;
    eventKey: string;
  }): SecurityEventInput {
    return {
      userId: input.userId,
      sessionKey: input.sessionKey,
      deviceId: input.deviceId,
      eventKey: input.eventKey,
      actionType: SecurityEventType.PASSWORD,
      resultType: input.result,
      snapshot: {
        authVersionBefore: input.authVersionBefore,
        authVersionAfter: input.authVersionAfter,
      },
    };
  }

  /** 恢复凭证事件（action=RECOVERY；成功=新 sid + authVersion 递增）。 */
  recoveryEvent(input: {
    userId: string;
    credentialKey: string;
    sessionKey: string | null;
    deviceId: string | null;
    result: SecurityResultTypeValue;
    eventKey: string;
  }): SecurityEventInput {
    return {
      userId: input.userId,
      sessionKey: input.sessionKey,
      deviceId: input.deviceId,
      eventKey: input.eventKey,
      actionType: SecurityEventType.RECOVERY,
      resultType: input.result,
      snapshot: { credentialKey: input.credentialKey },
    };
  }

  /** 撤销事件（action=REVOKE；登出/全设备退出/设备撤销，session_key 为 Redis 标识）。 */
  revokeEvent(input: {
    userId: string;
    sessionKey: string | null;
    deviceId: string | null;
    result: SecurityResultTypeValue;
    /** 撤销范围：'session'（单 sid）/ 'user'（全设备）/ 'device'（指定设备全部 session）。 */
    scope: 'session' | 'user' | 'device';
    eventKey: string;
  }): SecurityEventInput {
    return {
      userId: input.userId,
      sessionKey: input.sessionKey,
      deviceId: input.deviceId,
      eventKey: input.eventKey,
      actionType: SecurityEventType.REVOKE,
      resultType: input.result,
      snapshot: { scope: input.scope },
    };
  }

  /** TOTP 事件（action=TOTP；启用/停用/验证失败/恢复码消耗；不记 OTP/共享密钥/恢复码明文）。 */
  totpEvent(input: {
    userId: string;
    sessionKey: string | null;
    deviceId: string | null;
    result: SecurityResultTypeValue;
    /** 子动作：'enabled'/'disabled'/'verify_failed'/'recovery_consumed'。 */
    subAction: 'enabled' | 'disabled' | 'verify_failed' | 'recovery_consumed';
    /** 恢复码脱敏（只记前 2 后 2 + ****，不记完整码/摘要，§5）。 */
    recoveryCodeMasked?: string;
    eventKey: string;
  }): SecurityEventInput {
    return {
      userId: input.userId,
      sessionKey: input.sessionKey,
      deviceId: input.deviceId,
      eventKey: input.eventKey,
      actionType: SecurityEventType.TOTP,
      resultType: input.result,
      snapshot: {
        subAction: input.subAction,
        ...(input.recoveryCodeMasked !== undefined ? { recoveryCode: maskRecoveryCode(input.recoveryCodeMasked) } : {}),
      },
    };
  }

  /** 联系方式换绑事件（action=CONTACT；脱敏新旧值，§5 "安全事件只记录脱敏的新旧值"）。 */
  contactEvent(input: {
    userId: string;
    sessionKey: string | null;
    deviceId: string | null;
    result: SecurityResultTypeValue;
    contactType: 'EMAIL' | 'PHONE';
    /** 脱敏旧值（maskEmail/maskPhone，非明文）。 */
    oldValueMasked: string;
    /** 脱敏新值。 */
    newValueMasked: string;
    eventKey: string;
  }): SecurityEventInput {
    return {
      userId: input.userId,
      sessionKey: input.sessionKey,
      deviceId: input.deviceId,
      eventKey: input.eventKey,
      actionType: SecurityEventType.CONTACT,
      resultType: input.result,
      snapshot: {
        contactType: input.contactType,
        oldValueMasked: input.oldValueMasked,
        newValueMasked: input.newValueMasked,
      },
    };
  }

  /** 刷新复用检测事件（action=REVOKE；RFC 9700 复用 → 撤销 session + 持久安全事件，§3）。 */
  refreshReuseEvent(input: {
    userId: string;
    sessionKey: string | null;
    result: SecurityResultTypeValue;
    eventKey: string;
  }): SecurityEventInput {
    return {
      userId: input.userId,
      sessionKey: input.sessionKey,
      eventKey: input.eventKey,
      actionType: SecurityEventType.REVOKE,
      resultType: input.result,
      snapshot: { reason: 'REFRESH_REUSE_DETECTED' },
    };
  }
}

export type SecurityResultTypeValue = (typeof SecurityResultType)[keyof typeof SecurityResultType];

/**
 * identifier 脱敏（login 事件用）：含 `@` → 邮箱走 maskEmail；纯数字或 `+` 开头 →
 * 手机走 maskPhone；其余按 username 原样（非联系方式，不脱敏）。
 */
function maskIdentifier(identifier: string | null): string | null {
  if (identifier === null) return null;
  if (identifier.includes('@')) return maskEmail(identifier);
  if (/^[+\d\s-]+$/.test(identifier)) return maskPhone(identifier);
  return identifier;
}

// 脱敏工具重导出（用例层 snapshot 拼装复用；规则在 domain 定义，此处不重实现）。
export { maskEmail, maskPhone, maskRecoveryCode };
export { maskIdentifier };
