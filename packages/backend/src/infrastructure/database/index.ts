/**
 * `@gameing/backend` 数据库基础设施入口（供 apps/server 等传输装配层复用）。
 *
 * 依据 `docs/02_architecture/后端实施SDD.md` §1：Sequelize/Umzug/迁移链 0001~0018
 * 统一在 backend 包维护，`apps/server` 仅保留传输装配与进程健康探针。
 * 本 index 聚合导出迁移器、Sequelize 实例与连接配置，调用方按需取用。
 */

export { createMigrator, MIGRATIONS_DIR, type MigratorOptions, type LoggerLike } from './migrator.js';
export { getSequelize, closeSequelize } from './sequelize.js';
export { buildSequelizeOptions, readDatabaseConfig, readDatabaseConfigPermissive, type DatabaseConfig } from './config.js';
export { MigrationActionType, MigrationStatus } from './migration-constants.js';
export { MigrationHistoryStorage } from './migration-history-storage.js';
export { probeMysql } from './mysql-probe.js';
export { addModels, allModels, type AllModels } from './models/index.js';
