import type { Sequelize } from 'sequelize';

/**
 * 0004 — 记账操作与幂等根 `asset_operation`。
 *
 * 对应 `docs/05_data/数据库设计SDD.md` §5.3。一次跨账户资金操作是这里的一行，
 * 它的所有分录（含手续费、系统账户侧）挂在同一 operation 下，同事务提交。
 * 转账不建额外的 transfer/participant 表：双方由各自 `asset_entry.asset_account_id` 确定。
 *
 * 不可改写：`status` 固定 RECORDED=1，`deleted_at` 恒为 NULL，
 * 补偿通过新操作 + `reverses_asset_operation_id` 追加，不修改原行。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`asset_operation\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '操作状态，固定为 RecordStatus.RECORDED=1，已成立的资产事实不可改写',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间；不可变记录固定等于 created_at',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；账务事实禁止删除，恒为 NULL',
      \`operation_key\` VARCHAR(160) NOT NULL COMMENT '全局业务语义幂等键，不只是随机请求号',
      \`operation_type\` SMALLINT UNSIGNED NOT NULL COMMENT '资金用例类型，取值见 AssetOperationType（1~14）',
      \`request_hash\` BINARY(32) NOT NULL COMMENT '规范化请求摘要，防止同键不同内容的重放',
      \`initiated_by_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '玩家发起人，引用 user.id；系统任务为空',
      \`operated_by_admin_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT 'Admin 操作人，引用 user.id；人工资产调整时必填',
      \`approved_by_admin_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '双人复核审批人，引用 user.id；非复核操作为空',
      \`admin_session_key\` CHAR(36) NULL DEFAULT NULL COMMENT '发起操作的 Redis Admin 会话定位键，不存会话内容',
      \`reverses_asset_operation_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '本操作冲正或补偿的原操作，引用 asset_operation.id；可被多次部分补偿',
      \`reason\` VARCHAR(500) NULL DEFAULT NULL COMMENT '人工调整或补偿原因',
      \`extra\` JSON NULL DEFAULT NULL COMMENT '用例级不可变细节快照（费率、舍入规则、邀请链快照等），账务金额仍以分录为准',
      \`result_snapshot\` JSON NULL DEFAULT NULL COMMENT '提交后可重复返回的结果快照',
      \`committed_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '资金事务成功提交的业务时间，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_asset_operation_operation_key\` (\`operation_key\`),
      KEY \`ix_asset_operation_initiator\` (\`initiated_by_user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_asset_operation_operator\` (\`operated_by_admin_user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_asset_operation_approver\` (\`approved_by_admin_user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_asset_operation_reverses\` (\`reverses_asset_operation_id\`),
      KEY \`ix_asset_operation_status\` (\`status\`, \`created_at\`, \`id\`),
      CONSTRAINT \`fk_asset_operation_initiator\` FOREIGN KEY (\`initiated_by_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_asset_operation_operator\` FOREIGN KEY (\`operated_by_admin_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_asset_operation_approver\` FOREIGN KEY (\`approved_by_admin_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_asset_operation_reverses\` FOREIGN KEY (\`reverses_asset_operation_id\`) REFERENCES \`asset_operation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_asset_operation_status\` CHECK (\`status\` = 1),
      CONSTRAINT \`ck_asset_operation_deleted_at\` CHECK (\`deleted_at\` IS NULL),
      CONSTRAINT \`ck_asset_operation_type\` CHECK (\`operation_type\` BETWEEN 1 AND 14),
      CONSTRAINT \`ck_asset_operation_reviewer\` CHECK (\`approved_by_admin_user_id\` IS NULL OR \`operated_by_admin_user_id\` IS NULL OR \`approved_by_admin_user_id\` <> \`operated_by_admin_user_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='跨账户记账操作及幂等根，所有分录同事务归属此操作'
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS `asset_operation`');
}
