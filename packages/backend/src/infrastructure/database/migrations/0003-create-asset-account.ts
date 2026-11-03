import type { Sequelize } from 'sequelize';

/**
 * 0003 — 分资产余额账户 `asset_account`。
 *
 * 对应 `docs/05_data/数据库设计SDD.md` §5.3。系统账户不是独立表：
 * 它只是 `account_type=SYSTEM` 的行，每种资产一行，归属于 `user` 里的 SYSTEM 身份。
 *
 * 有符号金额的边界在这里用 CHECK 表达，而不是只靠应用层：
 * - 任意账户 `frozen_amount >= 0` 且不超过 `GREATEST(amount, 0)`；
 * - 系统人民币不得为负；系统金币与玩家资产允许因已审计操作变负。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`asset_account\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '账户状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；资金账户不软删，恒为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '账户主体，引用 user.id',
      \`account_type\` SMALLINT UNSIGNED NOT NULL COMMENT '账户类型：PLAYER=1/SYSTEM=2，开户时由 user.role_type 推导且禁止修改',
      \`asset_type\` SMALLINT UNSIGNED NOT NULL COMMENT '资产类型：COIN=1/CNY_BALANCE=2',
      \`currency\` CHAR(3) NOT NULL COMMENT '币种：金币为 COI，人民币余额为 CNY，必须与 asset_type 对应',
      \`amount\` BIGINT NOT NULL DEFAULT 0 COMMENT '有符号资产总额：金币为枚，人民币为分',
      \`frozen_amount\` BIGINT NOT NULL DEFAULT 0 COMMENT '有效占款总额，是 amount 的一部分而非额外资产',
      \`version\` BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '每次资产或冻结变更递增的版本号，用于分录对账与乐观并发',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_asset_account_user_asset\` (\`user_id\`, \`asset_type\`, \`currency\`),
      KEY \`ix_asset_account_type\` (\`account_type\`, \`asset_type\`),
      CONSTRAINT \`fk_asset_account_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_asset_account_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_asset_account_account_type\` CHECK (\`account_type\` IN (1, 2)),
      CONSTRAINT \`ck_asset_account_asset_type\` CHECK (\`asset_type\` IN (1, 2)),
      CONSTRAINT \`ck_asset_account_currency\` CHECK ((\`asset_type\` = 1 AND \`currency\` = 'COI') OR (\`asset_type\` = 2 AND \`currency\` = 'CNY')),
      CONSTRAINT \`ck_asset_account_frozen_range\` CHECK (\`frozen_amount\` >= 0 AND \`frozen_amount\` <= GREATEST(\`amount\`, 0)),
      CONSTRAINT \`ck_asset_account_system_cny\` CHECK (NOT (\`account_type\` = 2 AND \`asset_type\` = 2) OR \`amount\` >= 0),
      CONSTRAINT \`ck_asset_account_version\` CHECK (\`version\` >= 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='系统和玩家的分资产余额账户'
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS `asset_account`');
}
