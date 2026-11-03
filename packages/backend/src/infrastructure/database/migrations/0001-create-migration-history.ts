import type { Sequelize } from 'sequelize';

/**
 * 0001 — 建立迁移执行历史表。
 *
 * 这张表是迁移框架自身的基础设施（`docs/05_data/数据库设计SDD.md` §5.8）。
 * 刻意不放在 `sequelize-cli` 的 `SequelizeMeta` 里：后者没有 id、status、
 * 三个 DATETIME 和字段注释，不满足全表规范，也不记录 DOWN 事件。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`migration_history\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '此行工作状态，取值见 MigrationStatus：RUNNING=1/SUCCEEDED=2/FAILED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；迁移历史为审计事实，恒为 NULL',
      \`name\` VARCHAR(255) NOT NULL COMMENT '迁移文件名称，与源文件名一致',
      \`checksum\` CHAR(64) NOT NULL COMMENT '迁移源文件内容的 SHA256，用于发现同名校验和被改写',
      \`action_type\` SMALLINT UNSIGNED NOT NULL COMMENT '执行方向：UP=1/DOWN=2',
      \`execution_no\` BIGINT UNSIGNED NOT NULL COMMENT '同一迁移的递增执行序号，从 1 开始',
      \`started_at\` DATETIME(3) NOT NULL COMMENT '本次执行开始时间，UTC',
      \`finished_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '本次执行结束时间，UTC；未结束时为 NULL',
      \`executor_key\` VARCHAR(128) NOT NULL COMMENT '执行迁移的任务身份，用于区分多个部署任务',
      \`error_code\` VARCHAR(64) NULL DEFAULT NULL COMMENT '失败时的错误代码，成功为 NULL',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_migration_history_name_execution_no\` (\`name\`, \`execution_no\`),
      KEY \`ix_migration_history_name_status\` (\`name\`, \`status\`, \`action_type\`, \`id\`),
      CONSTRAINT \`ck_migration_history_action_type\` CHECK (\`action_type\` IN (1, 2)),
      CONSTRAINT \`ck_migration_history_execution_no\` CHECK (\`execution_no\` >= 1),
      CONSTRAINT \`ck_migration_history_status\` CHECK (\`status\` IN (1, 2, 3))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='符合全表规范的迁移执行历史'
  `);
}

/**
 * 回滚不删除历史表。
 *
 * 原因：Umzug 在 `down()` 返回后还要往 `migration_history` 追加 DOWN 记录，
 * 表若在此处被删掉，框架自身的收尾就会失败。迁移历史是审计事实，
 * 按规范"不靠物理删历史来表达撤销"，因此这里刻意留空。
 */
export async function down(_params: { context: Sequelize }): Promise<void> {
  return Promise.resolve();
}
