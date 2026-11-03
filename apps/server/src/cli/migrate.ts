import { createLogger } from '../infrastructure/logging/logger.js';
import { createMigrator } from '@gameing/backend/infrastructure/database/migrations';
import { closeSequelize, getSequelize } from '../infrastructure/database/sequelize.js';

/**
 * 迁移任务 CLI（委托 `@gameing/backend` 的全量迁移链 0001~0018）。
 *
 * 依据 `docs/02_architecture/后端实施SDD.md` §1：数据库基础设施（Sequelize/Umzug/迁移）
 * 迁入 `packages/backend`；`apps/server` 仅保留传输装配与进程健康探针。本 CLI 作为
 * server 侧入口薄壳，复用 backend 的 18 项迁移注册表，保证 `down({to:0})` 能回滚全部
 * 领域批次而不被跨表外键卡住。
 *
 * 用法（在 Docker dev 容器或已注入 MYSQL_* 的宿主机环境）：
 *   pnpm --filter @gameing/server migrate           # 等价于 up
 *   pnpm --filter @gameing/server migrate down      # 回滚一步
 *   pnpm --filter @gameing/server migrate status    # 查看已应用/待应用
 *
 * 迁移由独立任务执行，不与服务进程启动耦合：DDL 失败需要人工核对真实结构后再前滚，
 * 不能靠进程重启自动重试。
 */
const logger = createLogger({ base: { service: 'gameing-hall-migrate' } });

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const sequelize = getSequelize();
  const migrator = createMigrator(sequelize, { logger });

  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      logger.info('迁移已应用', {
        count: applied.length,
        migrations: applied.map((migration) => migration.name),
      });
      break;
    }
    case 'down': {
      const reverted = await migrator.down();
      logger.info('迁移已回滚', {
        count: reverted.length,
        migrations: reverted.map((migration) => migration.name),
      });
      break;
    }
    case 'status': {
      const executed = await migrator.executed();
      const pending = await migrator.pending();
      logger.info('迁移状态', {
        executed: executed.map((migration) => migration.name),
        pending: pending.map((migration) => migration.name),
      });
      break;
    }
    default:
      throw new Error(`未知迁移命令：${command}（可用 up / down / status）`);
  }
}

main()
  .catch((error: unknown) => {
    logger.error('迁移失败', {
      errorCode: error instanceof Error ? error.name : 'UnknownError',
      cause: error instanceof Error ? error.stack : String(error),
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSequelize();
  });
