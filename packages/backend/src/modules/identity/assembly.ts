/**
 * identity 模块装配工厂（inject 全部 ports 的 IdentityModule，供 server 装配调用一次）。
 *
 * 领域所有者：identity 模块。
 * 对应 SDD 章节：后端实施 SDD §1（装配工厂 `createIdentityModule({sequelize, redis,
 * config})` 返回注入了全部 ports 的 IdentityModule 对象）、§4（构造注入 ports，
 * 不用全局）、§8（dev 容器内 Redis 10371 / MySQL 10306；argon2 native 失败回退
 * bcrypt，与 user 表注释一致）。
 *
 * 依赖装配（Lead 统一验证时按此检查接线）：
 * - `sequelize`：Sequelize 实例（models 已 addModels 注册，§3.2 identity 四 model + outbox）；
 * - `redis`：ioredis 实例（infrastructure/redis/client.ts `getRedis()`，Lead 已装 ioredis）；
 * - `config`：JWT 配置（issuer / audience / accessTtl）+ 时钟注入。
 *
 * 未闭环登记（完成报告给 Lead）：
 * - outbox worker 未建（SDD §8 后续运维项）：OutboxPort 实现为同事务直写 outbox 行，
 *   消费端在 worker 落地前无消费者；
 * - TOTP 密文 KMS 未接入：encryptTotpSecret/decryptTotpSecret 为占位封装（"TOTP"
 *   前缀），部署密钥设施落地后替换；
 * - WelcomeGiftPort 由 server composition 在 wallet 可用时注入；缺失时 registration fail closed；
 * - refresh 用例的 sid 定位依赖路由层在 Cookie 双值存 sid + refresh token（本步
 *   session-store 无 hash→sid 倒排索引，决策点登记）。
 */

import type { Sequelize, Transaction } from 'sequelize';
import type { RedisClient } from '../../infrastructure/redis/client.js';
import { RefreshRotationStore } from '../../infrastructure/redis/refresh-rotation.js';
import { JwtIssuer, loadJwtKeys, type JwtConfig } from '../../infrastructure/jwt/jwt.js';

import { SequelizeIdentityRepository } from './adapters/sequelize-identity-repository.js';
import {
  RedisSessionPortAdapter,
  RedisRefreshRotationPortAdapter,
  RedisAuthRateLimitPortAdapter,
  RedisChallengeStoreAdapter,
} from './adapters/redis-session-port.js';
import { JoseJwtIssuerAdapter } from './adapters/jose-jwt-issuer.js';
import { UserModel, DeviceModel, RecoveryCredentialModel, UserSecurityEventModel } from '../../infrastructure/database/models/identity.js';
import { OutboxModel } from '../../infrastructure/database/models/events.js';

import type { IdentityRepository, Tx } from './ports/identity-repository.js';
import type { SessionPort } from './ports/session-port.js';
import type { JwtIssuerPort } from './ports/jwt-port.js';
import type { Clock } from './ports/clock.js';
import { SystemClock } from './ports/clock.js';
import type { OutboxPort } from './ports/outbox-port.js';
import type { RefreshRotationPort, AuthRateLimitPort } from './ports/refresh-rotation-port.js';
import type { ChallengeStore } from './ports/challenge-store-port.js';
import type { WelcomeGiftPort } from './ports/welcome-gift-port.js';
import type { UnitOfWork } from './ports/unit-of-work.js';
import type { OutboxAppendInput } from './ports/outbox-port.js';
import { SequelizeUnitOfWork } from './ports/unit-of-work.js';

import { SecurityEventService } from './application/security-events.js';
import { DeviceRegisterUseCase } from './application/device-register.js';
import { AnonymousDeviceRegistrationUseCase, type PlayerAssetAccountsPort } from './application/anonymous-device-registration.js';
import { DeviceLoginUseCase } from './application/device-login.js';
import { PasswordLoginUseCase } from './application/password-login.js';
import { RecoveryUseCase } from './application/recovery.js';
import { RefreshUseCase } from './application/refresh.js';
import { LogoutUseCase } from './application/logout.js';
import { SessionRevocationUseCase } from './application/session-revocation.js';
import { IdentitySettingsUseCase } from './application/identity-settings.js';
import { ContactChallengesUseCase } from './application/contact-challenges.js';
import { TotpUseCase } from './application/totp.js';
import { RecoveryCredentialUseCase } from './application/recovery-credential.js';

/** 装配配置（Lead 统一验证时按 compose env 填入）。 */
export interface IdentityModuleConfig {
  /** JWT issuer（玩家端固定标识；Admin audience 另走 admin 模块）。 */
  issuer: string;
  /** 受众白名单（player 端默认 ['player']）。 */
  audiences?: string[];
  /** access 令牌寿命秒（§1 建议 600）。 */
  accessTtlSeconds?: number;
  /** JWT kid（密钥索引，§1 "kid 仅索引预配置可信密钥"）。 */
  kid?: string;
  /** 时钟注入（测试可传固定时钟；缺省 SystemClock）。 */
  clock?: Clock;
  /** 欢迎赠币端口（wallet 未装配时为 null；生产组合应注入其幂等赠币适配器）。 */
  welcomeGift?: WelcomeGiftPort | null;
  playerAssetAccounts?: PlayerAssetAccountsPort | null;
}

/** 装配依赖（Sequelize 实例 + ioredis 实例 + 配置；模型类在装配内取）。 */
export interface IdentityModuleDeps {
  sequelize: Sequelize;
  redis: RedisClient;
  config: IdentityModuleConfig;
}

/** 全部 ports + 用例实例的 IdentityModule（构造注入，不用全局，SDD §4）。 */
export interface IdentityModule {
  // ports（共享实现，供测试/其他模块 mock 时参考）
  repository: IdentityRepository;
  sessionPort: SessionPort;
  jwtIssuer: JwtIssuerPort;
  rotationPort: RefreshRotationPort;
  rateLimitPort: AuthRateLimitPort;
  challengeStore: ChallengeStore;
  outbox: OutboxPort;
  clock: Clock;
  unitOfWork: UnitOfWork;
  securityEvents: SecurityEventService;

  /**
   * 在事务 scope 内构建同事务 outbox port（§6.3 "所有分录/outbox 同事务"）：
   * 用例经 `module.withTx(scope, fn)` 把 `scope.transaction` 传入 outbox.append，
   * 随事务提交/回滚。缺省 `module.outbox` 为无事务实现（测试/用例外调用兜底）。
   */
  withTx<T>(scope: { transaction: Transaction | null }, fn: (outbox: OutboxPort) => T | Promise<T>): Promise<T>;

  // 用例实例
  deviceRegister: DeviceRegisterUseCase;
  anonymousDeviceRegistration: AnonymousDeviceRegistrationUseCase;
  deviceLogin: DeviceLoginUseCase;
  passwordLogin: PasswordLoginUseCase;
  recovery: RecoveryUseCase;
  refresh: RefreshUseCase;
  logout: LogoutUseCase;
  sessionRevocation: SessionRevocationUseCase;
  identitySettings: IdentitySettingsUseCase;
  contactChallenges: ContactChallengesUseCase;
  totp: TotpUseCase;
  recoveryCredential: RecoveryCredentialUseCase;

  /** 初始化（异步载入 Lua 脚本 + JWT 密钥；装配后调用一次）。 */
  init(): Promise<void>;
}

/**
 * OutboxPort 实现：同事务直写 outbox 行（§6.3 "领域事务 → 同事务写 outbox"；
 * 首版 worker 未建，登记 topic 消费端待补）。
 */
class SequelizeOutboxPort implements OutboxPort {
  constructor(
    private readonly outboxModel: typeof OutboxModel,
    private readonly tx: Tx,
  ) {}

  async append(input: OutboxAppendInput): Promise<void> {
    const now = new Date();
    await this.outboxModel.create(
      {
        eventKey: input.eventKey ?? `outbox:${input.topic}:${now.getTime()}:${Math.random().toString(36).slice(2)}`,
        topic: input.topic,
        userId: input.userId ?? null,
        payload: input.payload,
        payloadVersion: input.payloadVersion ?? 1,
        availableAt: input.availableAt ?? now,
        // outbox 默认值（attempts=0 等）由 model 默认值兜底；此处只登记必填项。
      } as never,
      { transaction: this.tx.transaction as Transaction } as never,
    );
  }
}

/**
 * 装配 identity 模块（调用一次；返回注入全部 ports 的 IdentityModule）。
 * 由 apps/server bootstrap 或测试装配调用。
 */
export async function createIdentityModule(deps: IdentityModuleDeps): Promise<IdentityModule> {
  const { sequelize, redis, config } = deps;
  const clock = config.clock ?? new SystemClock();

  // --- 共享 ports 实现（装配内构建一次，用例共享，不各自 new） ---
  const models = {
    UserModel,
    DeviceModel,
    RecoveryCredentialModel,
    UserSecurityEventModel,
  };
  const repository = new SequelizeIdentityRepository(models);

  // SessionPort（委托 RedisSessionStore；用例不直接依赖 ioredis，SDD §4）。
  const sessionPort = new RedisSessionPortAdapter(redis);

  // JWT（jose ES256；dev 缺省 PEM → 内存生成 + warn，不写盘，§1）。
  const jwtConfig: JwtConfig = {
    issuer: config.issuer,
    allowedAudiences: config.audiences ?? ['player'],
    accessTtlSeconds: config.accessTtlSeconds ?? 600,
  };
  const kid = config.kid ?? 'identity-dev';
  const jwtKeys = await loadJwtKeys(kid);
  const jwtIssuer = new JoseJwtIssuerAdapter(new JwtIssuer(jwtConfig, jwtKeys));

  // 轮换 + 限频 + 挑战（Redis 侧 ports，装配内委托基础设施实现）。
  const rotationStore = new RefreshRotationStore(redis);
  const rotationPort = new RedisRefreshRotationPortAdapter(redis);
  const rateLimitPort = new RedisAuthRateLimitPortAdapter(redis);
  const challengeStore = new RedisChallengeStoreAdapter(redis);
  void rotationStore; // store 经 port 使用（rotationPort 内部委托）；保留引用防 tree-shake

  // 安全事件服务（用例共享；append-only 单一写入点，§3）。
  const securityEvents = new SecurityEventService(repository);

  // 工作单元（Sequelize 事务；Redis 不在此范围，§3 跨存储窗口 outbox 幂等重试）。
  const unitOfWork = new SequelizeUnitOfWork(sequelize);

  // outbox 事务工厂：把 tx 传入 SequelizeOutboxPort（§6.3 同事务 outbox）；
  // 缺省无事务实现供"用例外"调用（测试）；正常路径经 unitOfWork.run(scope) 内
  // 由装配层把 scope.transaction 注入。
  const outboxPortFactory = (tx: Tx): OutboxPort => new SequelizeOutboxPort(OutboxModel, tx);
  const defaultOutbox = outboxPortFactory({ transaction: null });

  // --- 用例实例（构造注入 ports；无 wallet 时 registration 用例拒绝发会话） ---
  const welcomeGift = config.welcomeGift ?? null;

  const deviceRegister = new DeviceRegisterUseCase(repository, sessionPort, jwtIssuer, clock, welcomeGift);
  const anonymousDeviceRegistration = new AnonymousDeviceRegistrationUseCase(
    repository,
    unitOfWork,
    config.playerAssetAccounts ?? null,
    welcomeGift,
    sessionPort,
    jwtIssuer,
    clock,
  );

  const deviceLogin = new DeviceLoginUseCase(repository, sessionPort, jwtIssuer, clock, rateLimitPort, securityEvents);

  const passwordLogin = new PasswordLoginUseCase(repository, sessionPort, jwtIssuer, clock, rateLimitPort, challengeStore, securityEvents);

  const recovery = new RecoveryUseCase(repository, sessionPort, jwtIssuer, clock, rateLimitPort, securityEvents);

  const refresh = new RefreshUseCase(repository, sessionPort, rotationPort, jwtIssuer, clock, rateLimitPort, securityEvents);

  const logout = new LogoutUseCase(repository, sessionPort, defaultOutbox, clock, securityEvents);

  const sessionRevocation = new SessionRevocationUseCase(repository, sessionPort, defaultOutbox, clock, securityEvents);

  const identitySettings = new IdentitySettingsUseCase(repository, sessionPort, defaultOutbox, clock, securityEvents);

  const contactChallenges = new ContactChallengesUseCase(repository, defaultOutbox, challengeStore, clock, securityEvents);

  const totp = new TotpUseCase(repository, defaultOutbox, challengeStore, clock, securityEvents);

  const recoveryCredential = new RecoveryCredentialUseCase(repository, sessionPort, defaultOutbox, clock, securityEvents);

  const module: IdentityModule = {
    repository,
    sessionPort,
    jwtIssuer,
    rotationPort,
    rateLimitPort,
    challengeStore,
    outbox: defaultOutbox,
    clock,
    unitOfWork,
    securityEvents,

    deviceRegister,
    anonymousDeviceRegistration,
    deviceLogin,
    passwordLogin,
    recovery,
    refresh,
    logout,
    sessionRevocation,
    identitySettings,
    contactChallenges,
    totp,
    recoveryCredential,

    async init(): Promise<void> {
      // 载入 Lua 轮换脚本（ioredis Script，sha1 自动缓存；NOSCRIPT 自动重定义，§3）。
      await rotationPort.load();
    },

    async withTx<T>(scope: { transaction: Transaction | null }, fn: (outbox: OutboxPort) => T | Promise<T>): Promise<T> {
      // 同事务 outbox（§6.3）：把 scope.transaction 传入 outbox.append，随事务提交/回滚。
      const tx: Tx = { transaction: scope.transaction as Transaction | undefined };
      return fn(outboxPortFactory(tx));
    },
  };

  // outboxFor 暴露经 module.withTx；保留独立导出的 outboxFor(module, tx) 供用例外调用。
  (module as unknown as { outboxFor: (tx: Tx) => OutboxPort }).outboxFor = outboxPortFactory;

  return module;
}

/**
 * 在事务 scope 内构建 outbox port（用例调用 outbox.append 时同事务写 outbox 行，
 * §6.3 "所有分录/outbox 同事务"）。
 * 用法（用例层）：`const outbox = outboxFor(scope)` 后 `outbox.append(...)`。
 */
export function outboxFor(module: IdentityModule, tx: Tx): OutboxPort {
  return (module as unknown as { outboxFor: (tx: Tx) => OutboxPort }).outboxFor(tx);
}
