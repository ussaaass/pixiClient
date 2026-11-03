import type { Sequelize } from 'sequelize';

/**
 * 0015 — 客服 IM：`support_conversation`、`support_message`。
 *
 * 字段与约束逐条对应 `docs/05_data/数据库设计SDD.md` §5.9。
 * `support_message` 为持久化消息记录（不硬删除，脱敏保留行位），
 * 按普通表处理（状态可 VISIBLE→REDACTED，`updated_at` 正常更新），不属于不可变表。
 *
 * 只建列不建外键的引用：
 * - `support_message.asset_id` 引用 `asset` 表，0017 才建，外键待 0017 补建；
 * - `support_conversation.order_id / withdrawal_id` 引用 0010 已有表，直接建 RESTRICT 外键。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`support_conversation\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '会话状态，取值见 SupportConversationStatus：WAITING_SUPPORT=1/WAITING_USER=2/CLOSED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '发起咨询的用户，引用 user.id；一个用户可创建多个独立问题会话',
      \`assigned_admin_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '当前负责的客服 Admin；NULL 表示待领取，引用 user.id',
      \`category_type\` SMALLINT UNSIGNED NOT NULL COMMENT '问题分类，取值见 SupportCategoryType：ACCOUNT=1/PAYMENT=2/WITHDRAWAL=3/GAME=4/OTHER=5',
      \`subject\` VARCHAR(160) NOT NULL COMMENT '用户提交的问题标题',
      \`order_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '关联的商城订单（如适用），引用 order.id',
      \`withdrawal_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '关联的提现申请（如适用），引用 withdrawal.id',
      \`last_message_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '最近一条消息时间，用于队列排序，UTC',
      \`user_unread_count\` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '用户侧未读消息计数；与消息写入同事务更新',
      \`support_unread_count\` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '客服侧未读消息计数；与消息写入同事务更新',
      \`closed_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '会话关闭时间，UTC；关闭后不可继续追加消息',
      PRIMARY KEY (\`id\`),
      KEY \`ix_support_conversation_user_status\` (\`user_id\`, \`status\`, \`updated_at\`, \`id\`),
      KEY \`ix_support_conversation_queue\` (\`status\`, \`assigned_admin_user_id\`, \`updated_at\`, \`id\`),
      KEY \`ix_support_conversation_order\` (\`order_id\`),
      KEY \`ix_support_conversation_withdrawal\` (\`withdrawal_id\`),
      CONSTRAINT \`fk_support_conversation_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_support_conversation_assigned_admin_user_id\` FOREIGN KEY (\`assigned_admin_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_support_conversation_order_id\` FOREIGN KEY (\`order_id\`) REFERENCES \`order\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_support_conversation_withdrawal_id\` FOREIGN KEY (\`withdrawal_id\`) REFERENCES \`withdrawal\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_support_conversation_status\` CHECK (\`status\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_support_conversation_category\` CHECK (\`category_type\` IN (1, 2, 3, 4, 5))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户与客服之间的一次服务会话'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`support_message\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '消息状态，取值见 SupportMessageStatus：VISIBLE=1/REDACTED=2',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；消息不硬删除，撤回/隐私清理以 REDACTED 状态保留，恒为 NULL',
      \`support_conversation_id\` BIGINT UNSIGNED NOT NULL COMMENT '所属客服会话，引用 support_conversation.id',
      \`message_key\` CHAR(36) NOT NULL COMMENT '客户端生成的幂等键，弱网重试不得重复发消息',
      \`sender_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '发信 user；SYSTEM 通知为空，其他消息指向统一 user',
      \`sender_type\` SMALLINT UNSIGNED NOT NULL COMMENT '发信方类型，取值见 SupportSenderType：CUSTOMER=1/ADMIN=2/SYSTEM=3',
      \`message_type\` SMALLINT UNSIGNED NOT NULL COMMENT '消息类型，取值见 SupportMessageType：TEXT=1/IMAGE=2/ATTACHMENT=3/SYSTEM_NOTICE=4',
      \`body_text\` TEXT NULL DEFAULT NULL COMMENT '文本内容；不得包含密码、OTP、TOTP secret 或支付密钥',
      \`asset_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '图片/附件消息必填，必须是私有且 READY 的 asset；TEXT/SYSTEM_NOTICE 为空；外键待 0017 补建',
      \`redacted_by_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '执行脱敏/撤回的客服 Admin，引用 user.id',
      \`redacted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '消息被脱敏时间，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_support_message_message_key\` (\`message_key\`),
      KEY \`ix_support_message_conversation\` (\`support_conversation_id\`, \`id\`),
      KEY \`ix_support_message_sender_status\` (\`sender_user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_support_message_asset\` (\`asset_id\`),
      CONSTRAINT \`fk_support_message_conversation\` FOREIGN KEY (\`support_conversation_id\`) REFERENCES \`support_conversation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_support_message_sender_user_id\` FOREIGN KEY (\`sender_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_support_message_redacted_by_user_id\` FOREIGN KEY (\`redacted_by_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_support_message_status\` CHECK (\`status\` IN (1, 2)),
      CONSTRAINT \`ck_support_message_sender_type\` CHECK (\`sender_type\` IN (1, 2, 3)),
      CONSTRAINT \`ck_support_message_type\` CHECK (\`message_type\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_support_message_sender_pair\` CHECK (((\`sender_type\` = 3) AND \`sender_user_id\` IS NULL) OR ((\`sender_type\` IN (1, 2)) AND \`sender_user_id\` IS NOT NULL)),
      CONSTRAINT \`ck_support_message_asset_pair\` CHECK (((\`message_type\` IN (2, 3)) = (\`asset_id\` IS NOT NULL)))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='持久化客服会话消息'
  `);

  // 前序批次"只建列不建外键"的引用列，在本批次建完 support_conversation 后补建 RESTRICT 外键。
  await context.query(`
    ALTER TABLE \`user_security_event\`
      ADD CONSTRAINT \`fk_user_security_event_support_conversation_id\` FOREIGN KEY (\`support_conversation_id\`) REFERENCES \`support_conversation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
  await context.query(`
    ALTER TABLE \`admin_audit_event\`
      ADD CONSTRAINT \`fk_admin_audit_event_withdrawal_id\` FOREIGN KEY (\`withdrawal_id\`) REFERENCES \`withdrawal\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  // 先移除本批次补建的外键，再按 up 的相反顺序删表。
  await context.query('ALTER TABLE `admin_audit_event` DROP CONSTRAINT `fk_admin_audit_event_withdrawal_id`');
  await context.query('ALTER TABLE `user_security_event` DROP CONSTRAINT `fk_user_security_event_support_conversation_id`');
  await context.query('DROP TABLE IF EXISTS `support_message`');
  await context.query('DROP TABLE IF EXISTS `support_conversation`');
}
