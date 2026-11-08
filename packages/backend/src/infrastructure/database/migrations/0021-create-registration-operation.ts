import type { Sequelize } from 'sequelize';

/** 0021 — registration request idempotency and encrypted replay ledger. */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`registration_operation\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '注册操作状态：PENDING=1/COMPLETED=2/FAILED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '保留用删除时间；幂等墓碑永不删除，恒为 NULL',
      \`key\` VARCHAR(160) NOT NULL COMMENT '注册请求唯一幂等键，不含可复用秘密',
      \`request_hash\` BINARY(32) NOT NULL COMMENT '注册请求规范化内容的 SHA-256 摘要，不保存请求明文',
      \`user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '注册成功创建的用户，引用 user.id',
      \`device_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '注册成功建立的设备，引用 device.id',
      \`replay_ciphertext\` TEXT NULL DEFAULT NULL COMMENT '注册响应认证加密密文；只存密文，不存明文，24 小时后重试时惰性清空',
      \`replay_expires_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '响应密文过期时间，UTC；与 replay_ciphertext 同时置空，成功时设为创建后 24 小时',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_registration_operation_key\` (\`key\`),
      KEY \`ix_registration_operation_user_id\` (\`user_id\`),
      KEY \`ix_registration_operation_device_id\` (\`device_id\`),
      CONSTRAINT \`fk_registration_operation_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_registration_operation_device_id\` FOREIGN KEY (\`device_id\`) REFERENCES \`device\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_registration_operation_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_registration_operation_deleted_at\` CHECK (\`deleted_at\` IS NULL),
      CONSTRAINT \`ck_registration_operation_replay_pair\` CHECK ((\`replay_ciphertext\` IS NULL AND \`replay_expires_at\` IS NULL) OR (\`replay_ciphertext\` IS NOT NULL AND \`replay_expires_at\` IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='注册幂等操作账本；永久保留键与请求摘要，响应仅短期加密保留'
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  // Rollback removes the ledger table; migration_history remains append-only.
  await context.query('DROP TABLE IF EXISTS `registration_operation`');
}
