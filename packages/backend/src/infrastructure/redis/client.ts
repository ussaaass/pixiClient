/**
 * Redis 客户端单例工厂（identity 会话基础设施）。
 *
 * 领域所有者：identity 模块（会话/轮换/限频的唯一 Redis 权威存储）。
 * 对应 SDD 章节：JWT 登录与会话设计 §3（"玩家与 Admin 的短期 session/刷新令牌状态放
 * Redis，不在 MySQL 建 session 表"）；后端实施 SDD §1 infrastructure/redis、§8
 * （会话/限频走现有 Redis，dev 容器内 host=redis port=6379）。
 *
 * 约定：
 * - `ioredis` 按 Lead 并行安装（ioredis ^5），此处按"依赖已就位"编写；
 * - 连接参数读环境变量 REDIS_HOST/REDIS_PORT/REDIS_PASSWORD（与 compose.yaml dev 服务对齐：
 *   容器内 host=redis、port=6379；本机直连默认 127.0.0.1:10371）；
 * - 所有由本模块写入的 key 必须带 TTL（JWT 设计 §3），唯一例外 user:authversion:{userId}
 *   （长期安全版本镜像，无 TTL）；
 * - 进程退出时必须 `closeRedis()`，否则事件循环不释放（与 sequelize.ts 同纪律）。
 */

import { Redis, type Redis as RedisType } from 'ioredis';
// ioredis v5 的内置类型：`Redis` 既是值（构造器）也是类型（class）。
// 用命名导入 `Redis as RedisType` 取类型，默认导入取构造器；
// 不耦合 ioredis 内部 `RedisOptions`，本模块只声明 host/port/password/lazyConnect
// 等连接参数，装配层注入完整选项时用本接口（结构兼容）。
export interface RedisConnectOptions {
  host: string;
  port: number;
  /** 无密码时显式 undefined（exactOptionalPropertyTypes 下可选字段需允许 undefined）。 */
  password?: string | undefined;
  /** 延迟连接：首用建连接（纯读路由/探活阶段未配置 Redis 也能启动）。 */
  lazyConnect?: boolean | undefined;
  /** 连接故障立即失败（§3 "Redis 不可用时受保护请求失败关闭"）。 */
  enableOfflineQueue?: boolean | undefined;
  /** 每请求最大重试次数（不无限重试）。 */
  maxRetriesPerRequest?: number | undefined;
}

/** 导出类型：模块内统一以 `RedisClient` 指代 ioredis 实例（避免各处重述默认导出类型）。 */
export type RedisClient = RedisType;

/** 默认连接参数（本机直连 dev：127.0.0.1:10371，与 AGENTS.md 本机端口表一致）。 */
export const REDIS_DEFAULTS = {
  host: '127.0.0.1',
  port: 10371,
} as const;

/** 读取 REDIS_* 环境变量（与 compose.yaml dev 服务 env 对齐）。 */
export function readRedisConfig(): RedisConnectOptions {
  const host = process.env.REDIS_HOST ?? REDIS_DEFAULTS.host;
  const port = process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : REDIS_DEFAULTS.port;
  const password = process.env.REDIS_PASSWORD || undefined;
  return {
    host,
    port,
    password,
    // 会话是受保护请求的权威存储：连接故障不得静默降级（JWT 设计 §3 "Redis 不可用时
    // 受保护请求失败关闭"），因此不启用本地缓存、不做 maxRetriesPerRequest=0 的无限重试。
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  };
}

let instance: RedisClient | undefined;

/**
 * 进程内唯一 Redis 实例（延迟连接：首用时建连接）。
 * `lazyConnect` 保证纯读路由/探活阶段未配置 Redis 也能启动，
 * 首次调用任一命令（get/set/eval 等）时才真正握手。
 */
export function getRedis(): RedisClient {
  instance ??= new Redis(readRedisConfig());
  return instance;
}

/** 关闭连接。进程退出与集成测试收尾必须调用。 */
export async function closeRedis(): Promise<void> {
  if (instance === undefined) return;
  await instance.quit();
  instance = undefined;
}
