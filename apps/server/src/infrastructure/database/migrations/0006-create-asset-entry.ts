import type { Sequelize } from 'sequelize';

/**
 * 0006 — 不可变资产分录 `asset_entry`。
 *
 * 对应 `docs/05_data/数据库设计SDD.md` §5.3。每条分录是账户的一次版本变更：
 * 同一账户同一 `account_version` 只允许一条，`U(asset_account_id, account_version)`
 * 因此天然阻断"两个并发操作写出同一版本"的错账。
 *
 * `delta` 与 `frozen_delta` 都是精确有符号整数（BIGINT），不是 UNSIGNED：
 * 扣减、冻结释放、审计冲正都靠符号表达，不靠额外的方向字段。
 *
 * 占款一致性用 CHECK 固定：`entry_type=HOLD(3)` 当且仅当带 `asset_hold_id`，
 * 其余分录的 `asset_hold_id` 必须为空。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`asset_entry\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '分录状态，固定为 RecordStatus.RECORDED=1，已入账不可改写',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间；不可变记录固定等于 created_at',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；账务事实禁止删除，恒为 NULL',
      \`asset_operation_id\` BIGINT UNSIGNED NOT NULL COMMENT '所属记账操作，引用 asset_operation.id',
      \`asset_account_id\` BIGINT UNSIGNED NOT NULL COMMENT '对应资产账户，引用 asset_account.id',
      \`asset_hold_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '此分录创建、消耗或释放的占款，引用 asset_hold.id；非占款分录为空',
      \`entry_seq\` INT UNSIGNED NOT NULL COMMENT '同一操作内的分录序号，从 1 开始',
      \`entry_type\` SMALLINT UNSIGNED NOT NULL COMMENT '分录类型：INTERNAL=1/EXTERNAL=2/HOLD=3/COMPENSATION=4',
      \`delta\` BIGINT NOT NULL COMMENT '资产总额变动，有符号整数（金币为枚，人民币为分）',
      \`frozen_delta\` BIGINT NOT NULL DEFAULT 0 COMMENT '冻结额变动，有符号整数；冻结释放不增加总额',
      \`amount_after\` BIGINT NOT NULL COMMENT '变更后的资产总额，用于逐笔对账',
      \`frozen_after\` BIGINT NOT NULL COMMENT '变更后的冻结额',
      \`account_version\` BIGINT UNSIGNED NOT NULL COMMENT '变更后的账户版本号，与 asset_account.version 对应',
      \`memo\` VARCHAR(500) NOT NULL COMMENT '分录含义及人工调整原因，必须可读',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_asset_entry_operation_seq\` (\`asset_operation_id\`, \`entry_seq\`),
      UNIQUE KEY \`uq_asset_entry_account_version\` (\`asset_account_id\`, \`account_version\`),
      KEY \`ix_asset_entry_account_created\` (\`asset_account_id\`, \`created_at\`, \`id\`),
      KEY \`ix_asset_entry_hold\` (\`asset_hold_id\`, \`created_at\`, \`id\`),
      CONSTRAINT \`fk_asset_entry_operation\` FOREIGN KEY (\`asset_operation_id\`) REFERENCES \`asset_operation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_asset_entry_account\` FOREIGN KEY (\`asset_account_id\`) REFERENCES \`asset_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_asset_entry_hold\` FOREIGN KEY (\`asset_hold_id\`) REFERENCES \`asset_hold\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_asset_entry_status\` CHECK (\`status\` = 1),
      CONSTRAINT \`ck_asset_entry_deleted_at\` CHECK (\`deleted_at\` IS NULL),
      CONSTRAINT \`ck_asset_entry_type\` CHECK (\`entry_type\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_asset_entry_seq\` CHECK (\`entry_seq\` >= 1),
      CONSTRAINT \`ck_asset_entry_nonzero\` CHECK (\`delta\` <> 0 OR \`frozen_delta\` <> 0),
      CONSTRAINT \`ck_asset_entry_hold_pair\` CHECK ((\`entry_type\` = 3) = (\`asset_hold_id\` IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='不可变资产变动及冻结分录，逐笔对应账户版本'
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS `asset_entry`');
}
