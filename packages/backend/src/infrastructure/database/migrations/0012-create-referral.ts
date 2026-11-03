import type { Sequelize } from 'sequelize';

/**
 * 0012 — 邀请关系与返佣：`referral_binding`、`referral_binding_event`、`referral_reward_allocation`。
 *
 * 字段与约束逐条对应 `docs/05_data/数据库设计SDD.md` §5.5。
 *
 * 不可变：`referral_binding_event` 为绑定证据流水，`status` 固定 RECORDED=1、
 * `updated_at` 固定等于 `created_at`、`deleted_at` 恒为 NULL。
 *
 * 只建列不建外键的引用：
 * - `referral_reward_allocation.order_id` 目标 `order` 表 0010 已建 → 直接建 RESTRICT 外键；
 * - `referral_reward_allocation.asset_hold_id` 引用 0005 已有表 → RESTRICT 外键。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`referral_binding\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '绑定行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '当前被邀请用户，引用 user.id；每人至多一行',
      \`parent_1_user_id\` BIGINT UNSIGNED NOT NULL COMMENT '直属上级，奖励层级1，引用 user.id',
      \`parent_2_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '上上级，奖励层级2，引用 user.id',
      \`parent_3_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '第三级上级，引用 user.id',
      \`parent_4_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '第四级上级，奖励层级4，引用 user.id',
      \`parent_1_benefit_cents\` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '当前绑定关系有效期间，此用户为直属上级累计产生的已发人民币返点分；查询投影',
      \`parent_2_benefit_cents\` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '当前绑定关系有效期间，此用户为第二级上级累计产生的已发返点分；查询投影',
      \`parent_3_benefit_cents\` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '当前绑定关系有效期间，此用户为第三级上级累计产生的已发返点分；查询投影',
      \`parent_4_benefit_cents\` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '当前绑定关系有效期间，此用户为第四级上级累计产生的已发返点分；查询投影',
      \`bound_at\` DATETIME(3) NOT NULL COMMENT '当前上级链生效时间，UTC',
      \`binding_source\` SMALLINT UNSIGNED NOT NULL COMMENT '绑定来源：IP_ATTRIBUTION=1/INVITE_CODE=2/ADMIN=3',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_referral_binding_user_id\` (\`user_id\`),
      KEY \`ix_referral_binding_parent_1\` (\`parent_1_user_id\`, \`parent_1_benefit_cents\`, \`user_id\`),
      KEY \`ix_referral_binding_parent_2\` (\`parent_2_user_id\`, \`parent_2_benefit_cents\`, \`user_id\`),
      KEY \`ix_referral_binding_parent_3\` (\`parent_3_user_id\`, \`parent_3_benefit_cents\`, \`user_id\`),
      KEY \`ix_referral_binding_parent_4\` (\`parent_4_user_id\`, \`parent_4_benefit_cents\`, \`user_id\`),
      CONSTRAINT \`fk_referral_binding_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_referral_binding_parent_1_user_id\` FOREIGN KEY (\`parent_1_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_referral_binding_parent_2_user_id\` FOREIGN KEY (\`parent_2_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_referral_binding_parent_3_user_id\` FOREIGN KEY (\`parent_3_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_referral_binding_parent_4_user_id\` FOREIGN KEY (\`parent_4_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_referral_binding_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_referral_binding_source\` CHECK (\`binding_source\` IN (1, 2, 3)),
      CONSTRAINT \`ck_referral_binding_chain_continuous\` CHECK ((\`parent_2_user_id\` IS NULL) OR (\`parent_1_user_id\` IS NOT NULL)),
      CONSTRAINT \`ck_referral_binding_chain_continuous_3\` CHECK ((\`parent_3_user_id\` IS NULL) OR (\`parent_2_user_id\` IS NOT NULL)),
      CONSTRAINT \`ck_referral_binding_chain_continuous_4\` CHECK ((\`parent_4_user_id\` IS NULL) OR (\`parent_3_user_id\` IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户当前邀请上级链快照，最多保存直属上级至第四级上级'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`referral_binding_event\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '事件状态，固定为 RecordStatus.RECORDED=1，绑定证据不可改写',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间；不可变记录固定等于 created_at',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；绑定证据禁止删除，恒为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '被绑定或换绑用户，引用 user.id',
      \`previous_parent_1_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '换绑前直属上级，引用 user.id',
      \`new_parent_1_user_id\` BIGINT UNSIGNED NOT NULL COMMENT '新绑定或换绑后的直属上级，引用 user.id',
      \`admin_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '仅 Admin 换绑操作人，引用 user.id',
      \`binding_key\` VARCHAR(160) NOT NULL COMMENT '绑定操作幂等键',
      \`request_key\` VARCHAR(160) NOT NULL COMMENT '同一批子树重算事件的关联请求键',
      \`source_type\` SMALLINT UNSIGNED NOT NULL COMMENT '归因来源：IP_ATTRIBUTION=1/INVITE_CODE=2/ADMIN=3',
      \`invite_code_used\` VARCHAR(32) NULL DEFAULT NULL COMMENT '本次归因使用的邀请码快照',
      \`ip_lookup_hash\` BINARY(32) NULL DEFAULT NULL COMMENT '成功归因时 IP 的限期带密钥摘要',
      \`attribution_version\` VARCHAR(64) NULL DEFAULT NULL COMMENT 'Redis 中最后有效邀请版本',
      \`relation_snapshot\` JSON NOT NULL COMMENT 'before/after 两份链快照；键为 parent_1_user_id 至 parent_4_user_id',
      \`reason\` VARCHAR(500) NOT NULL COMMENT '绑定或换绑原因',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_referral_binding_event_binding_key\` (\`binding_key\`),
      KEY \`ix_referral_binding_event_request_key\` (\`request_key\`),
      KEY \`ix_referral_binding_event_user_status\` (\`user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_referral_binding_event_previous_parent\` (\`previous_parent_1_user_id\`),
      KEY \`ix_referral_binding_event_new_parent\` (\`new_parent_1_user_id\`),
      KEY \`ix_referral_binding_event_admin_user\` (\`admin_user_id\`),
      CONSTRAINT \`fk_referral_binding_event_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_referral_binding_event_previous_parent_1_user_id\` FOREIGN KEY (\`previous_parent_1_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_referral_binding_event_new_parent_1_user_id\` FOREIGN KEY (\`new_parent_1_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_referral_binding_event_admin_user_id\` FOREIGN KEY (\`admin_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_referral_binding_event_status\` CHECK (\`status\` = 1),
      CONSTRAINT \`ck_referral_binding_event_deleted_at\` CHECK (\`deleted_at\` IS NULL),
      CONSTRAINT \`ck_referral_binding_event_source\` CHECK (\`source_type\` IN (1, 2, 3))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='初绑及管理换绑不可变证据'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`referral_reward_allocation\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '奖励状态，取值见 RewardStatus：POSTED=1/SKIPPED=2',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；奖励结论不可软删，恒为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '领取奖励的上级，引用 user.id',
      \`ancestry_snapshot\` JSON NOT NULL COMMENT '奖励计算时的四级上级 ID 快照，键为 parent_1_user_id 至 parent_4_user_id',
      \`order_id\` BIGINT UNSIGNED NOT NULL COMMENT '金币购买返点评估来源订单，引用 order.id',
      \`asset_operation_id\` BIGINT UNSIGNED NOT NULL COMMENT '履约或审核资金操作，引用 asset_operation.id',
      \`asset_hold_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '正金额返点的余额冻结，引用 asset_hold.id；reward_cents=0 不建 hold',
      \`reward_type\` SMALLINT UNSIGNED NOT NULL COMMENT '上级模式快照：RECHARGE=1/LOSS=2；本表只记录充值返点',
      \`ancestor_depth\` SMALLINT UNSIGNED NOT NULL COMMENT '上级层级，1 到 4；1 为直属',
      \`rate_bps\` INT UNSIGNED NOT NULL COMMENT '本级比例快照，默认 1000/800/500/300 bps',
      \`basis_subcents\` DECIMAL(38,12) NOT NULL COMMENT '精确人民币分基数',
      \`exact_reward_subcents\` DECIMAL(38,12) NOT NULL COMMENT '舍入前人民币分奖励',
      \`reward_cents\` BIGINT NOT NULL COMMENT '实际入账人民币分',
      \`rounding_snapshot\` JSON NOT NULL COMMENT '舍入方式与余数',
      \`unlock_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '充值返点入账后 2 天可解冻时刻，UTC',
      \`skip_reason\` VARCHAR(255) NULL DEFAULT NULL COMMENT '模式不符或不足一分等原因',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_referral_reward_order_user\` (\`order_id\`, \`user_id\`),
      UNIQUE KEY \`uq_referral_reward_hold\` (\`asset_hold_id\`),
      KEY \`ix_referral_reward_user_status\` (\`user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_referral_reward_operation\` (\`asset_operation_id\`),
      CONSTRAINT \`fk_referral_reward_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_referral_reward_order_id\` FOREIGN KEY (\`order_id\`) REFERENCES \`order\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_referral_reward_operation\` FOREIGN KEY (\`asset_operation_id\`) REFERENCES \`asset_operation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_referral_reward_hold\` FOREIGN KEY (\`asset_hold_id\`) REFERENCES \`asset_hold\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_referral_reward_status\` CHECK (\`status\` IN (1, 2)),
      CONSTRAINT \`ck_referral_reward_deleted_at\` CHECK (\`deleted_at\` IS NULL),
      CONSTRAINT \`ck_referral_reward_depth\` CHECK (\`ancestor_depth\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_referral_reward_skip_pair\` CHECK (((\`status\` = 1) AND \`skip_reason\` IS NULL) OR ((\`status\` = 2) AND \`skip_reason\` IS NOT NULL)),
      CONSTRAINT \`ck_referral_reward_nonnegative\` CHECK (\`reward_cents\` >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='每个来源每个上级的奖励或跳过记录'
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS `referral_reward_allocation`');
  await context.query('DROP TABLE IF EXISTS `referral_binding_event`');
  await context.query('DROP TABLE IF EXISTS `referral_binding`');
}
