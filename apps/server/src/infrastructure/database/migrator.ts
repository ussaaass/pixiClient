import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Sequelize } from 'sequelize';
import { Umzug } from 'umzug';
import { createLogger, type Logger } from '../logging/logger.js';
import { MigrationHistoryStorage } from './migration-history-storage.js';
import * as createMigrationHistory from './migrations/0001-create-migration-history.js';
import * as createUser from './migrations/0002-create-user.js';
import * as createAssetAccount from './migrations/0003-create-asset-account.js';
import * as createAssetOperation from './migrations/0004-create-asset-operation.js';
import * as createAssetHold from './migrations/0005-create-asset-hold.js';
import * as createAssetEntry from './migrations/0006-create-asset-entry.js';
import { getSequelize } from './sequelize.js';

/**
 * 迁移目录的绝对路径。
 *
 * 用于计算每个迁移源文件的 SHA256 摘要（`migration_history.checksum`）。
 * 注意：迁移只在开发镜像与独立迁移任务里执行，不进入生产运行产物，
 * 因此打包后的 `dist/server.js` 不依赖这个路径。
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * 迁移注册表（显式顺序）。
 *
 * 不用 glob 动态发现：显式列表让执行顺序可读、可 review，并且每个迁移的
 * `up`/`down` 签名都会被 TypeScript 检查；新增迁移必须改这里，不会出现
 * "文件放进目录但顺序错了"的静默问题。
 *
 * 顺序即依赖：user → asset_account → asset_operation → asset_hold → asset_entry。
 */
const MIGRATIONS = [
  { name: '0001-create-migration-history', up: createMigrationHistory.up, down: createMigrationHistory.down },
  { name: '0002-create-user', up: createUser.up, down: createUser.down },
  { name: '0003-create-asset-account', up: createAssetAccount.up, down: createAssetAccount.down },
  { name: '0004-create-asset-operation', up: createAssetOperation.up, down: createAssetOperation.down },
  { name: '0005-create-asset-hold', up: createAssetHold.up, down: createAssetHold.down },
  { name: '0006-create-asset-entry', up: createAssetEntry.up, down: createAssetEntry.down },
];

export interface MigratorOptions {
  /** 迁移任务身份，写入 `migration_history.executor_key`。 */
  executorKey?: string;
  logger?: Logger;
}

export function createMigrator(sequelize: Sequelize = getSequelize(), options: MigratorOptions = {}): Umzug<Sequelize> {
  const logger = options.logger ?? createLogger({ base: { service: 'gameing-hall-migrate' } });
  const executorKey = options.executorKey ?? process.env.MIGRATION_EXECUTOR_KEY ?? hostname();

  return new Umzug<Sequelize>({
    migrations: MIGRATIONS,
    context: sequelize,
    storage: new MigrationHistoryStorage(sequelize, MIGRATIONS_DIR, executorKey),
    logger,
  });
}
