/**
 * identity 模块跨模块唯一入口（SDD §1 public.ts 约定：模块内聚，对外仅 public.ts）。
 *
 * 领域所有者：identity 模块（user / device / recovery_credential / user_security_event
 * + Redis 会话 / refresh 轮换 / TOTP / 联系方式换绑 / 安全事件）。
 * 对应 SDD 章节：后端实施 SDD §1（"modules/…/public.ts 跨模块唯一入口"）、§4
 * （application / ports / adapters 布局）、§9 实施顺序第 1 步（身份与会话）。
 *
 * 导出约定：
 * - 全部用例工厂（构造注入 ports，不用全局——SDD §4 "构造注入"纪律）；
 * - ports 接口（供其他模块 / 测试 mock 依赖，不直接 import adapters）；
 * - 装配工厂 `createIdentityModule`（由 `assembly.ts` 提供，本入口 re-export）；
 * - 类型与常量（SessionRecord、PrincipalType、IdentityErrorCode 等 re-export）。
 *
 * 用例文件之间不互相 import 内部类（任务硬约定 2）；跨用例共享经本文件
 * （SecurityEventService 为 application 层共享服务，非用例类）。
 */

// ---------------------------------------------------------------------------
// 用例工厂（每个文件一个用例；构造注入 ports，不用全局）
// ---------------------------------------------------------------------------
export { DeviceRegisterUseCase, type DeviceRegisterInput } from './application/device-register.js';
export { AnonymousDeviceRegistrationUseCase, type AnonymousDeviceRegistrationInput } from './application/anonymous-device-registration.js';
export { toPublicSession, type SessionResult } from './application/session-result.js';
export { DeviceLoginUseCase, type DeviceLoginInput } from './application/device-login.js';
export { PasswordLoginUseCase, type PasswordLoginInput, type PasswordLoginResult } from './application/password-login.js';
export { RecoveryUseCase, type RecoveryInput } from './application/recovery.js';
export { RefreshUseCase, type RefreshInput } from './application/refresh.js';
export { LogoutUseCase, type LogoutInput } from './application/logout.js';
export { SessionRevocationUseCase, type DeviceListItem, type ListDevicesInput } from './application/session-revocation.js';
export { IdentitySettingsUseCase, type SettingsCtx, USERNAME_RULES, assertValidUsername } from './application/identity-settings.js';
export { ContactChallengesUseCase, type ContactChallengeRecord, type ContactSettingsCtx } from './application/contact-challenges.js';
export { TotpUseCase, type TotpSettingsCtx } from './application/totp.js';
export { RecoveryCredentialUseCase, type RecoverySettingsCtx } from './application/recovery-credential.js';

// 共享服务（application 层；用例经构造注入，不直接 create model 行）。
export { SecurityEventService, type SecurityResultTypeValue, maskIdentifier } from './application/security-events.js';
// 会话记录构造策略：跨模块经 public.ts 复用，不直接依赖 identity adapter。
export { buildNewSession } from './adapters/redis-session-port.js';

// ---------------------------------------------------------------------------
// 装配工厂（inject 全部 ports 的 IdentityModule 对象，供 server 装配调用一次）
// ---------------------------------------------------------------------------
export { createIdentityModule, type IdentityModule, type IdentityModuleDeps } from './assembly.js';

// ---------------------------------------------------------------------------
// ports（供其他模块 / 测试 mock；不直接 import adapters）
// ---------------------------------------------------------------------------
export type { IdentityRepository, SecurityEventInput, Tx, UserIdentifier } from './ports/identity-repository.js';
export type { SessionPort, NewSessionRecordInput } from './ports/session-port.js';
export type { JwtIssuerPort } from './ports/jwt-port.js';
export type { Clock } from './ports/clock.js';
export { SystemClock } from './ports/clock.js';
export type { OutboxPort, OutboxAppendInput } from './ports/outbox-port.js';
export type { RefreshRotationPort, AuthRateLimitPort } from './ports/refresh-rotation-port.js';
export type { ChallengeStore, LoginChallengeRecord, TotpSetupRecord } from './ports/challenge-store-port.js';
export type { WelcomeGiftPort } from './ports/welcome-gift-port.js';
export type { UnitOfWork, UnitOfWorkScope } from './ports/unit-of-work.js';
export { SequelizeUnitOfWork } from './ports/unit-of-work.js';

// ---------------------------------------------------------------------------
// 领域纯函数（password / totp / contact-rules；无 IO，测试可直用）
// ---------------------------------------------------------------------------
export {
  hashPassword,
  verifyPassword,
  assertMinPasswordLength,
  currentPasswordAlgo,
  MIN_PASSWORD_LENGTH,
  type PasswordHashResult,
} from './domain/password.js';
export {
  generateTotpSecret,
  totpAuthUri,
  verifyTotp,
  hotp,
  counterFor,
  generateRecoveryCodes,
  recoveryCodeMatches,
  maskRecoveryCode,
  TOTP_PARAMS,
  RECOVERY_CODE_COUNT,
} from './domain/totp.js';
export {
  normalizeEmail,
  normalizePhone,
  maskEmail,
  maskPhone,
  phoneTail3,
  checkEmailChange,
  checkPhoneChange,
  contactReauthRequirements,
  type ContactChangeCheck,
} from './domain/contact-rules.js';
export { DomainError, I } from './domain/errors.js';

// ---------------------------------------------------------------------------
// 会话/JWT 基础设施类型 re-export（跨模块消费 SessionRecord 等）
// ---------------------------------------------------------------------------
export type { SessionRecord, PrincipalType } from '../../infrastructure/redis/session-store.js';
export { SESSION_LIFETIME, ACCESS_TOKEN_TTL_MS } from '../../infrastructure/redis/session-store.js';
export type { RotationOk, RotationReuse, RotationResult, ScriptOutcome } from '../../infrastructure/redis/refresh-rotation.js';
export { REPLAY_WINDOW_MS } from '../../infrastructure/redis/refresh-rotation.js';
export type { RateCheck } from '../../infrastructure/redis/auth-rate-limit.js';
export { AUTH_RATE_LIMIT } from '../../infrastructure/redis/auth-rate-limit.js';
