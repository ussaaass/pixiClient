import type { Sequelize } from 'sequelize';

/**
 * 0005 — 资产冻结/占款 `asset_hold`。
 *
 * 对应 `docs/05_data/数据库设计SDD.md` §5.3。冻结不是额外资产，而是 `asset_account.amount`
 * 里被锁住的一部分：所有有效占款之和必须等于账户的 `frozen_amount`，
 * 该不变量由 wallet 用例在同一事务内维护，数据库侧只保证单行边界。
 *
 * 提现"未知结果"不因到期自动释放——`expires_at` 只表达可释放时刻，不是自动释放定时器。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`asset_hold\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '占款状态，取值见 HoldStatus：OPEN=1/PARTIAL=2/CONSUMED=3/RELEASED=4',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；占款生命周期用 status/closed_at 表达，恒为 NULL',
      \`asset_account_id\` BIGINT UNSIGNED NOT NULL COMMENT '被占用账户，引用 asset_account.id',
      \`asset_operation_id\` BIGINT UNSIGNED NOT NULL COMMENT '创建本占款的操作，引用 asset_operation.id',
      \`hold_key\` VARCHAR(160) NOT NULL COMMENT '业务语义唯一的占款键，用于幂等创建',
      \`hold_type\` SMALLINT UNSIGNED NOT NULL COMMENT '占款类型：GAME=1/WITHDRAWAL=2/REWARD=3/CHANNEL_UNSETTLED=4/COIN_MARKET_LISTING=5',
      \`amount\` BIGINT NOT NULL COMMENT '创建时的占款金额，必须为正',
      \`remaining_amount\` BIGINT NOT NULL COMMENT '尚未释放或消耗的金额',
      \`expires_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '奖励可释放时刻或业务期限，UTC；NULL 表示无期限',
      \`closed_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '占款关闭（全部消耗或释放）时间，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_asset_hold_hold_key\` (\`hold_key\`),
      KEY \`ix_asset_hold_account\` (\`asset_account_id\`, \`status\`, \`id\`),
      KEY \`ix_asset_hold_operation\` (\`asset_operation_id\`),
      KEY \`ix_asset_hold_type\` (\`hold_type\`, \`status\`, \`expires_at\`, \`id\`),
      CONSTRAINT \`fk_asset_hold_account\` FOREIGN KEY (\`asset_account_id\`) REFERENCES \`asset_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_asset_hold_operation\` FOREIGN KEY (\`asset_operation_id\`) REFERENCES \`asset_operation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_asset_hold_status\` CHECK (\`status\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_asset_hold_type\` CHECK (\`hold_type\` IN (1, 2, 3, 4, 5)),
      CONSTRAINT \`ck_asset_hold_amount\` CHECK (\`amount\` > 0),
      CONSTRAINT \`ck_asset_hold_remaining\` CHECK (\`remaining_amount\` >= 0 AND \`remaining_amount\` <= \`amount\`),
      CONSTRAINT \`ck_asset_hold_deleted_at\` CHECK (\`deleted_at\` IS NULL)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='资产冻结占款及其释放生命周期'
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS `asset_hold`');
}
