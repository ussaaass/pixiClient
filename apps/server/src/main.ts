import { createApp, type ReadinessCheck } from './app.js';
import { probeMysql } from './infrastructure/database/mysql-probe.js';
import { probeRedis } from './infrastructure/redis/redis-probe.js';
import { createLogger } from './infrastructure/logging/logger.js';

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
const app = createApp({ logger, readinessChecks });
const server = app.listen(port, '0.0.0.0', () => {
  logger.info('服务已启动', { port });
});

function shutdown(signal: string): void {
  logger.info('收到关闭信号，开始优雅关闭', { signal });
  server.close((error) => {
    if (error) {
      logger.error('关闭时发生错误', { errorCode: error.name, cause: error.stack });
      process.exit(1);
    }
    logger.info('服务已关闭');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

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
