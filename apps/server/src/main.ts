import { createApp, type ReadinessCheck } from './app.js';
import { probeMysql } from './infrastructure/database/mysql-probe.js';
import { probeRedis } from './infrastructure/redis/redis-probe.js';
import { createLogger } from './infrastructure/logging/logger.js';
import { getSequelize } from './infrastructure/database/sequelize.js';
import { getRedis, closeRedis } from '@gameing/backend/infrastructure/redis';
import { addModels } from '@gameing/backend/infrastructure/database/models';
import { createIdentityModule } from '@gameing/backend/modules/identity/public';
import { createWalletModule } from '@gameing/backend/modules/wallet/public';
import { createSocketAuthServer } from './socket/socket-auth.js';
import type { Sequelize } from 'sequelize';

/**
 * 服务进程入口。
 *
 * 负责：读取配置、装配应用、启动监听、注册优雅关闭。
 * 业务逻辑一律在 app/与 domain 层，本文件不包含领域规则。
 */

function readPort(): number {
  const raw = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(raw) || raw <= 0 || raw > 65535) {
    throw new Error(`PORT 非法：${process.env.PORT ?? ''}`);
  }
  return raw;
}

/**
 * 就绪探针依赖。
 *
 * P1 阶段登记 MySQL 与 Redis 两个探针：
 * - `mysql`：通过进程内唯一 Sequelize 实例执行 `authenticate`，凭证缺失时
 *   报 "credentials missing" 而不是抛异常中断探针。
 * - `redis`：当前仅做 TCP 可达性检查（Redis 尚未接入服务端依赖）；接入
 *   ioredis 后扩展为 `PING` 校验，契约保持不变。
 *
 * 探针返回 null 表示就绪；返回字符串表示未就绪的安全原因（不含密码等敏感信息）。
 * 任一探针未就绪时，`/health/ready` 返回 503 + `SERVICE_UNAVAILABLE`。
 *
 * 注意：探针未就绪不会阻止服务启动（`/health/live` 仍返回 200），
 * 只影响 `/health/ready` 与容器编排的就绪判定。
 */
const readinessChecks: ReadinessCheck[] = [
  { name: 'mysql', probe: probeMysql },
  { name: 'redis', probe: () => probeRedis() },
];

const logger = createLogger({
  level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
  base: { service: 'gameing-hall-api' },
});

const port = readPort();

// --- identity 模块装配（Redis 会话 + JWT ES256） ---
// Sequelize 实例 + addModels（注册全部 63 张表的 Model 定义，含 identity 四表 + outbox）
// 在装配前完成；Redis 连接 lazyConnect=true（首用才握手），纯读路由阶段不影响。
let identityModule;
let sequelizeInstance: Sequelize | undefined;
try {
  sequelizeInstance = getSequelize();
  addModels(sequelizeInstance);
  const redis = getRedis();
  identityModule = await createIdentityModule({
    sequelize: sequelizeInstance,
    redis,
    config: {
      issuer: 'gameing-hall-api',
      audiences: ['player'],
      accessTtlSeconds: 600,
      kid: 'identity-dev',
    },
  });
  await identityModule.init();
  logger.info('identity 模块装配完成', { issuer: 'gameing-hall-api' });
} catch (error) {
  logger.warn('identity 模块装配失败（auth 路由不挂载；MySQL/Redis 未配置或连接失败）', {
    errorCode: error instanceof Error ? error.name : 'UnknownError',
  });
  identityModule = undefined;
}

// --- wallet 模块装配（资金用例；需 identity 模块就绪） ---
// systemUserId 通过 env var 注入（SYSTEM 行 user.id，首版由 bootstrap 脚本解析，
// 未设置时 wallet 路由不挂载，不影响 identity 路由可用）。
let walletModule;
if (identityModule && sequelizeInstance) {
  try {
    const systemUserId = process.env.SYSTEM_USER_ID ?? '';
    if (!systemUserId) {
      logger.warn('SYSTEM_USER_ID env 未设置，wallet 路由不挂载（资金端点不可用）');
    } else {
      walletModule = createWalletModule({
        sequelize: sequelizeInstance,
        config: { systemUserId },
      });
      logger.info('wallet 模块装配完成', { systemUserId });
    }
  } catch (error) {
    logger.warn('wallet 模块装配失败（wallet 路由不挂载）', {
      errorCode: error instanceof Error ? error.name : 'UnknownError',
    });
    walletModule = undefined;
  }
}

const identityModuleOpt = identityModule ?? undefined;
const walletModuleOpt = walletModule ?? undefined;
const sequelizeOpt = sequelizeInstance ?? undefined;
const app = createApp({
  logger,
  readinessChecks,
  ...(identityModuleOpt ? { identityModule: identityModuleOpt } : {}),
  ...(walletModuleOpt && sequelizeOpt ? { walletModule: walletModuleOpt, sequelize: sequelizeOpt } : {}),
});
const server = app.listen(port, '0.0.0.0', () => {
  logger.info('服务已启动', { port });
});

// --- Socket.IO 握手鉴权基座（SDD §6.1 /platform 命名空间） ---
// identity 模块装配成功时才挂载（MySQL/Redis 缺失时降级：Socket 不挂）。
let socketAuth: ReturnType<typeof createSocketAuthServer> | undefined;
if (identityModuleOpt) {
  socketAuth = createSocketAuthServer(server, {
    module: identityModuleOpt,
    logger,
    namespace: '/platform',
  });
  logger.info('Socket.IO /platform 命名空间已挂载', { port });
}

async function shutdown(signal: string): Promise<void> {
  logger.info('收到关闭信号，开始优雅关闭', { signal });
  server.close(async (error) => {
    if (error) {
      logger.error('关闭时发生错误', { errorCode: error.name, cause: error.stack });
      process.exit(1);
      return;
    }
    // 关闭 Socket.IO（先断开所有连接）
    try {
      socketAuth?.io.close();
    } catch {
      /* socket 未初始化则跳过 */
    }
    // 关闭 Redis + Sequelize（身份会话 + 数据库连接池）
    try {
      await closeRedis();
    } catch {
      /* Redis 未初始化则跳过 */
    }
    const { closeSequelize } = await import('./infrastructure/database/sequelize.js');
    await closeSequelize();
    logger.info('服务已关闭');
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// 未捕获异常与未处理 rejection 必须落到日志再退出，不能让进程静默挂起。
process.on('uncaughtException', (error) => {
  logger.error('未捕获异常', { errorCode: error.name, cause: error.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise rejection', {
    errorCode: reason instanceof Error ? reason.name : 'UnknownError',
    cause: reason instanceof Error ? reason.stack : String(reason),
  });
  process.exit(1);
});
