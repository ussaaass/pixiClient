import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Sequelize } from 'sequelize';
import { Umzug } from 'umzug';
import { MigrationHistoryStorage } from './migration-history-storage.js';
import * as createMigrationHistory from './migrations/0001-create-migration-history.js';
import * as createUser from './migrations/0002-create-user.js';
import * as createAssetAccount from './migrations/0003-create-asset-account.js';
import * as createAssetOperation from './migrations/0004-create-asset-operation.js';
import * as createAssetHold from './migrations/0005-create-asset-hold.js';
import * as createAssetEntry from './migrations/0006-create-asset-entry.js';
import * as createIdentityExtensions from './migrations/0007-create-identity-extensions.js';
import * as createLobbyConfig from './migrations/0008-create-lobby-config.js';
import * as createAdminAudit from './migrations/0009-create-admin-audit.js';
import * as createAssetPayments from './migrations/0010-create-asset-payments.js';
import * as createChain from './migrations/0011-create-chain.js';
import * as createReferral from './migrations/0012-create-referral.js';
import * as createRooms from './migrations/0013-create-rooms.js';
import * as createSocial from './migrations/0014-create-social.js';
import * as createSupport from './migrations/0015-create-support.js';
import * as createCoinMarket from './migrations/0016-create-coin-market.js';
import * as createAssets from './migrations/0017-create-assets.js';
import * as createOutbox from './migrations/0018-create-outbox.js';
import * as seedSupportAdminPermissions from './migrations/0019-seed-support-admin-permissions.js';
import * as uniqueAdminAuditRequestKey from './migrations/0020-unique-admin-audit-request-key.js';
import * as createRegistrationOperation from './migrations/0021-create-registration-operation.js';
import * as registrationReplaySessionFence from './migrations/0022-registration-replay-session-fence.js';
import { getSequelize } from './sequelize.js';

/**
 * 迁移目录的绝对路径。
 *
 * 用于计算每个迁移源文件的 SHA256 摘要（`migration_history.checksum`）。
 * 注意：迁移只在开发镜像与独立迁移任务里执行，不进入生产运行产物，
 * 因此打包后的产物不依赖这个路径。
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * 迁移注册表（显式顺序）。
 *
 * 不用 glob 动态发现：显式列表让执行顺序可读、可 review，并且每个迁移的
 * `up`/`down` 签名都会被 TypeScript 检查；新增迁移必须改这里，不会出现
 * "文件放进目录但顺序错了"的静默问题。
 *
 * 顺序即依赖（批次划分见 `docs/02_architecture/后端实施SDD.md` §3.1）：
 * 0001~0006 为 P0 基础（迁移历史/身份/资产账本），0007~0018 为领域扩展批次。
 * 批次内被引用表在前；跨批次"只建列不建外键"的引用（asset 域等）由
 * 0016/0017 的 ALTER TABLE 补建，down 对应 DROP CONSTRAINT。
 */
const MIGRATIONS = [
  { name: '0001-create-migration-history', up: createMigrationHistory.up, down: createMigrationHistory.down },
  { name: '0002-create-user', up: createUser.up, down: createUser.down },
  { name: '0003-create-asset-account', up: createAssetAccount.up, down: createAssetAccount.down },
  { name: '0004-create-asset-operation', up: createAssetOperation.up, down: createAssetOperation.down },
  { name: '0005-create-asset-hold', up: createAssetHold.up, down: createAssetHold.down },
  { name: '0006-create-asset-entry', up: createAssetEntry.up, down: createAssetEntry.down },
  { name: '0007-create-identity-extensions', up: createIdentityExtensions.up, down: createIdentityExtensions.down },
  { name: '0008-create-lobby-config', up: createLobbyConfig.up, down: createLobbyConfig.down },
  { name: '0009-create-admin-audit', up: createAdminAudit.up, down: createAdminAudit.down },
  { name: '0010-create-asset-payments', up: createAssetPayments.up, down: createAssetPayments.down },
  { name: '0011-create-chain', up: createChain.up, down: createChain.down },
  { name: '0012-create-referral', up: createReferral.up, down: createReferral.down },
  { name: '0013-create-rooms', up: createRooms.up, down: createRooms.down },
  { name: '0014-create-social', up: createSocial.up, down: createSocial.down },
  { name: '0015-create-support', up: createSupport.up, down: createSupport.down },
  { name: '0016-create-coin-market', up: createCoinMarket.up, down: createCoinMarket.down },
  { name: '0017-create-assets', up: createAssets.up, down: createAssets.down },
  { name: '0018-create-outbox', up: createOutbox.up, down: createOutbox.down },
  {
    name: '0019-seed-support-admin-permissions',
    up: seedSupportAdminPermissions.up,
    down: seedSupportAdminPermissions.down,
  },
  {
    name: '0020-unique-admin-audit-request-key',
    up: uniqueAdminAuditRequestKey.up,
    down: uniqueAdminAuditRequestKey.down,
  },
  {
    name: '0021-create-registration-operation',
    up: createRegistrationOperation.up,
    down: createRegistrationOperation.down,
  },
  {
    name: '0022-registration-replay-session-fence',
    up: registrationReplaySessionFence.up,
    down: registrationReplaySessionFence.down,
  },
];

export interface MigratorOptions {
  /** 迁移任务身份，写入 `migration_history.executor_key`。 */
  executorKey?: string;
  /**
   * 结构化 logger，被适配成 Umzug 期望的 `{ debug, info, warn, error }` 形状。
   * 适配规则与 `apps/server` 历史实现一致：把回调对象的 `event` 提成日志主题、
   * 其余键作为结构化字段。不传则关闭 Umzug 内置日志（CLI 以单行 JSON 输出结果）。
   */
  logger?: LoggerLike;
}

/** Umzug logger 适配所需的最小结构化 logger 形状（不依赖 apps/server 的 logger 实现）。 */
export interface LoggerLike {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

function adaptLoggerForUmzug(logger: LoggerLike): Record<'debug' | 'info' | 'warn' | 'error', (message: Record<string, unknown>) => void> {
  const adapt = (level: 'debug' | 'info' | 'warn' | 'error') => {
    return (message: Record<string, unknown>): void => {
      const { event, ...fields } = message;
      const label = typeof event === 'string' && event.length > 0 ? event : 'umzug';
      logger[level](`迁移事件：${label}`, fields);
    };
  };
  return { debug: adapt('debug'), info: adapt('info'), warn: adapt('warn'), error: adapt('error') };
}

export function createMigrator(sequelize: Sequelize = getSequelize(), options: MigratorOptions = {}): Umzug<Sequelize> {
  const executorKey = options.executorKey ?? process.env.MIGRATION_EXECUTOR_KEY ?? hostname();

  return new Umzug<Sequelize>({
    migrations: MIGRATIONS,
    context: sequelize,
    storage: new MigrationHistoryStorage(sequelize, MIGRATIONS_DIR, executorKey),
    // 本包暂不内置结构化 logger；调用方（如 apps/server CLI）可注入自己的 logger。
    // 未注入时显式传 undefined 关闭 Umzug 内置日志，避免默认 console 输出。
    logger: options.logger ? adaptLoggerForUmzug(options.logger) : undefined,
  });
}
