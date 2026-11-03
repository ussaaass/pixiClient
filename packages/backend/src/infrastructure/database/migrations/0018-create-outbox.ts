import type { Sequelize } from 'sequelize';

/**
 * 0018 — 事务后任务队列 `outbox`。
 *
 * 字段与约束逐条对应 `docs/05_data/数据库设计SDD.md` §5.8。
 * outbox 与业务事实同事务写入，worker 负责至少一次投递；消费者以 `event_key` 幂等。
 *
 * 不可变：outbox 行是提交后通知/任务的事实记录，`status` 随投递生命周期变化
 * （OutboxStatus：PENDING=1/PROCESSING=2/SENT=3/DEAD=4），因此 `updated_at` 正常更新，
 * 不属于"不可变流水"（与 A.10 登记一致：outbox 状态可流转）；但事件本体不可删改，
 * `deleted_at` 恒为 NULL。
 *
 * 只建列不建外键的引用：`round_id` 目标表 0013 已建，直接建 RESTRICT 外键；
 * `asset_operation_id` 目标表 0004 已有，直接建 RESTRICT 外键。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`outbox\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '投递状态，取值见 OutboxStatus：PENDING=1/PROCESSING=2/SENT=3/DEAD=4',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；事务后事实禁止删除，恒为 NULL',
      \`event_key\` VARCHAR(160) NOT NULL COMMENT '消费者幂等事件值',
      \`topic\` VARCHAR(128) NOT NULL COMMENT '事件或任务主题',
      \`user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '玩家私有通知目标，引用 user.id',
      \`asset_operation_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '资金操作源，引用 asset_operation.id',
      \`round_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '公开牌局源，引用 round.id',
      \`payload\` JSON NOT NULL COMMENT '版本化最小负载，不含私牌和密钥',
      \`payload_version\` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '事件 schema 版本',
      \`available_at\` DATETIME(3) NOT NULL COMMENT '允许投递时间，UTC',
      \`attempts\` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '重试次数；普通计数，允许 0',
      \`locked_by\` VARCHAR(128) NULL DEFAULT NULL COMMENT '领取任务的进程',
      \`lease_until\` DATETIME(3) NULL DEFAULT NULL COMMENT '任务领取租约，UTC',
      \`sent_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '完成投递时间，UTC',
      \`last_error_code\` VARCHAR(64) NULL DEFAULT NULL COMMENT '脱敏失败代码',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_outbox_event_key\` (\`event_key\`),
      KEY \`ix_outbox_status_available\` (\`status\`, \`available_at\`, \`id\`),
      KEY \`ix_outbox_lease\` (\`lease_until\`, \`id\`),
      KEY \`ix_outbox_user\` (\`user_id\`, \`id\`),
      KEY \`ix_outbox_asset_operation\` (\`asset_operation_id\`),
      KEY \`ix_outbox_round\` (\`round_id\`),
      CONSTRAINT \`fk_outbox_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_outbox_asset_operation_id\` FOREIGN KEY (\`asset_operation_id\`) REFERENCES \`asset_operation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_outbox_round_id\` FOREIGN KEY (\`round_id\`) REFERENCES \`round\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_outbox_status\` CHECK (\`status\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_outbox_payload_version\` CHECK (\`payload_version\` >= 1),
      CONSTRAINT \`ck_outbox_attempts\` CHECK (\`attempts\` >= 0),
      CONSTRAINT \`ck_outbox_deleted_at\` CHECK (\`deleted_at\` IS NULL)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='数据库提交后的可靠通知与任务'
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS `outbox`');
}
