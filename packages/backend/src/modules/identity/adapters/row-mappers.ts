/**
 * user model ↔ contracts 映射 + 联系方式脱敏（row-mapper 约定，SDD §2 第 2 条）。
 *
 * 领域所有者：identity 模块（跨层格式转换放语义所有者边界，AGENTS.md §5）。
 * 对应 SDD 章节：后端实施 SDD §4 adapters/row-mappers.ts；contracts
 * `PlayerUserSchema` / `IdentitySettingsResponseSchema`（§1 "不手写第二套 DTO"）。
 *
 * 脱敏规则（安全事件 snapshot 与 settings 共用，§3 "安全事件只记录脱敏的新旧值"）：
 * - 邮箱：保留 local-part 前 2 + 尾部 2（中间 `***`）+ `@` + 域名首字符 + `***`；
 * - 手机：保留前 3 与末 3（中间 `***`）；界面同时显示已绑定号码末三位供核对（§5）。
 * 脱敏复用 `domain/contact-rules.ts` 的 `maskEmail`/`maskPhone`/`phoneTail3`
 * （语义所有者在 domain，row-mapper 只引用，不重定义规则）。
 */

import type { PlayerUserSchema, IdentitySettingsResponseSchema, Static } from '@gameing/contracts/identity';
import type { DeviceModel, UserModel } from '../../../infrastructure/database/models/identity.js';
import { maskEmail, maskPhone, phoneTail3 } from '../domain/contact-rules.js';

/**
 * BIGINT UNSIGNED 列 → 十进制字符串 wire（Sequelize 已回 string；此处兜底 String 转换，
 * 防 JS number 跨越 Number.MAX_SAFE_INTEGER，SDD §2 第 2 条）。
 */
export function toBigIntWire(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * UserModel → contracts `PlayerUserSchema`（userId 十进制字符串 + displayName + roleType）。
 * displayName 取 nickname（玩家昵称），roleType 为位标记原值（PLAYER=1/AGENT=2/ADMIN=4/SYSTEM=8）。
 */
export function toPlayerUser(user: UserModel): Static<typeof PlayerUserSchema> {
  return {
    userId: toBigIntWire(user.id) as string,
    displayName: user.nickname,
    roleType: user.roleType,
  };
}

/** 脱敏邮箱（row-mapper 与 settings snapshot 共用；规则登记于 domain/contact-rules.ts）。 */
export function maskEmailValue(email: string | null): string {
  return email === null ? '' : maskEmail(email);
}

/** 脱敏手机（保留前 3 末 3；规则登记于 domain/contact-rules.ts）。 */
export function maskPhoneValue(phone: string | null): string {
  return phone === null ? '' : maskPhone(phone);
}

/** 手机末三位（界面核对提示，§5）。 */
export function phoneTail(phone: string | null): string {
  return phone === null ? '' : phoneTail3(phone);
}

/**
 * UserModel → contracts `IdentitySettingsResponseSchema`（GET 设置快照）。
 * 脱敏规则（登记）：
 * - 邮箱 `maskedValue`：local-part 前 2 + 尾 2（中间 ***）+ @ + 域名首字符 + ***；
 *   `verified`：email_verified_at 非 null。
 * - 手机 `maskedValue`：前 3 + *** + 末 3；`verified`：phone_verified_at 非 null。
 * - 联系方式绑定不代表已验证收件能力（§5），故绑定后 verified 仍为 false
 *   （email_verified_at/phone_verified_at 不因绑定写入）。
 */
export function toIdentitySettings(
  user: UserModel,
  params: {
    recoveryAvailable: boolean;
    recoveryExpiryIso: string | null;
  },
): Static<typeof IdentitySettingsResponseSchema> {
  return {
    username: user.username,
    email: user.email === null ? null : { maskedValue: maskEmailValue(user.email), verified: user.emailVerifiedAt !== null },
    phone: user.phone === null ? null : { maskedValue: maskPhoneValue(user.phone), verified: user.phoneVerifiedAt !== null },
    passwordConfigured: user.passwordHash !== null,
    totpEnabled: user.totpEnabledAt !== null,
    recoveryCredential: {
      available: params.recoveryAvailable,
      expiresAt: params.recoveryExpiryIso,
    },
  };
}

/**
 * DeviceModel → contracts `DeviceSessionSchema`（device id + trusted）。
 * trusted = credential_status = ACTIVE（当前有效凭证视为受信；REVOKED/EXPIRED/NULL 非受信）。
 */
export function toDeviceSession(device: DeviceModel): { deviceId: string; trusted: boolean } {
  return {
    deviceId: toBigIntWire(device.id) as string,
    trusted: device.credentialStatus === 1, // CredentialStatus.ACTIVE=1
  };
}
