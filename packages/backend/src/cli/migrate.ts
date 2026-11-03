import { closeSequelize } from '../infrastructure/database/sequelize.js';
import { createMigrator } from '../infrastructure/database/migrator.js';

/**
 * 迁移任务 CLI（@gameing/backend）。
 *
 * 用法（在 Docker dev 容器或已注入 MYSQL_* 的宿主机环境）：
 *   pnpm --filter @gameing/backend migrate           # 等价于 up
 *   pnpm --filter @gameing/backend migrate down      # 回滚一步
 *   pnpm --filter @gameing/backend migrate status    # 查看已应用/待应用
 *
 * 迁移由独立任务执行，不与服务进程启动耦合：DDL 失败需要人工核对真实结构后再前滚，
 * 不能靠进程重启自动重试。
 *
 * 说明：本包暂不引入 apps/server 的结构化 logger（后续轮次随领域模块落地），
 * 迁移结果以单行 JSON 写到 stdout/stderr，保持输出可被容器日志采集按字段检索。
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const migrator = createMigrator();
  // Umzug 返回的 MigrationItem 形状（name 为注册名）；显式注解避免在依赖未解析
  // 的类型环境下隐式 any。
  const names = (migrations: Array<{ name: string }>): string[] => migrations.map((m) => m.name);

  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      process.stdout.write(JSON.stringify({ event: 'migrate-up', count: applied.length, migrations: names(applied) }) + '\n');
      break;
    }
    case 'down': {
      const reverted = await migrator.down();
      process.stdout.write(JSON.stringify({ event: 'migrate-down', count: reverted.length, migrations: names(reverted) }) + '\n');
      break;
    }
    case 'status': {
      const executed = await migrator.executed();
      const pending = await migrator.pending();
      process.stdout.write(
        JSON.stringify({
          event: 'migrate-status',
          executed: names(executed),
          pending: names(pending),
        }) + '\n',
      );
      break;
    }
    default:
      throw new Error(`未知迁移命令：${command}（可用 up / down / status）`);
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify({
        event: 'migrate-failed',
        errorCode: error instanceof Error ? error.name : 'UnknownError',
        cause: error instanceof Error ? error.stack : String(error),
      }) + '\n',
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSequelize();
  });
