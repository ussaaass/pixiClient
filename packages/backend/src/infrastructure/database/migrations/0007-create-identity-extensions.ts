import type { Sequelize } from 'sequelize';

/**
 * 0007 — 身份与会话扩展：`device`、`recovery_credential`、`user_security_event`。
 *
 * 字段与约束逐条对应 `docs/05_data/数据库设计SDD.md` §5.1 与 §5.8 `user_security_event`。
 * `user` 表由 0002 建立，本批次不改动。
 *
 * 不可变：`user_security_event` 为安全事实流水，`status` 固定 RECORDED=1、
 * `updated_at` 固定等于 `created_at`、`deleted_at` 恒为 NULL（写法见 0004）。
 *
 * 批次内顺序即依赖：`device` 被 `user_security_event.device_id` 引用，故在前。
 * `user_security_event.support_conversation_id` 目标表 0015 才建，本批次只建列不建外键。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`device\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '设备行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '所属用户，引用 user.id',
      \`fingerprint_hash\` BINARY(32) NOT NULL COMMENT '规范化设备指纹摘要，不作为认证凭证',
      \`device_digest\` BINARY(32) NOT NULL COMMENT '设备摘要，允许指纹相似但凭证不同',
      \`credential_key\` CHAR(36) NULL DEFAULT NULL COMMENT '当前设备登录凭证的公开随机定位号；撤销后置空',
      \`credential_secret_hash\` BINARY(32) NULL DEFAULT NULL COMMENT '当前高熵设备秘密的服务端验证摘要；撤销后置空',
      \`credential_status\` SMALLINT UNSIGNED NULL DEFAULT NULL COMMENT '当前凭证状态，取值见 CredentialStatus：ACTIVE=1/REVOKED=2/EXPIRED=3；NULL 表示从未签发，失效状态保留在此字段',
      \`credential_expires_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '当前设备凭证到期时间，UTC',
      \`credential_revoked_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '当前凭证撤销或轮换时间，UTC',
      \`platform_type\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '平台：WEB=1/IOS=2/ANDROID=3/WINDOWS=4/MACOS=5/LINUX=6',
      \`last_seen_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '最后访问时间，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_device_credential_key\` (\`credential_key\`),
      KEY \`ix_device_user_status\` (\`user_id\`, \`status\`, \`id\`),
      KEY \`ix_device_fingerprint\` (\`fingerprint_hash\`),
      KEY \`ix_device_digest\` (\`device_digest\`),
      KEY \`ix_device_credential_status\` (\`credential_status\`, \`credential_expires_at\`),
      CONSTRAINT \`fk_device_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_device_platform_type\` CHECK (\`platform_type\` IN (1, 2, 3, 4, 5, 6)),
      CONSTRAINT \`ck_device_credential_status\` CHECK (\`credential_status\` IS NULL OR \`credential_status\` IN (1, 2, 3))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='设备识别及账号归属'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`recovery_credential\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '凭证状态，取值见 RecoveryStatus：ISSUED=1/REVOKED=2/EXPIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '被恢复的账号，引用 user.id',
      \`credential_key\` CHAR(36) NOT NULL COMMENT '二维码的随机定位值',
      \`secret_hash\` BINARY(32) NOT NULL COMMENT '恢复秘密哈希，不保存明文',
      \`active_marker\` TINYINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN (\`status\` = 1) AND (\`deleted_at\` IS NULL) THEN 1 ELSE NULL END) STORED NULL COMMENT '有效二维码恢复凭证生成为 1，其余为 NULL；以唯一索引限制每用户至多一条有效凭证',
      \`expires_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '过期时间，UTC；默认签发后 2 年',
      \`last_used_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '最近一次成功使用时间，UTC；使用不消费或撤销二维码',
      \`revoked_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '被新二维码替换或由用户/管理员撤销的时间，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_recovery_credential_credential_key\` (\`credential_key\`),
      UNIQUE KEY \`uq_recovery_credential_active\` (\`user_id\`, \`active_marker\`),
      KEY \`ix_recovery_credential_user_status\` (\`user_id\`, \`status\`, \`id\`),
      KEY \`ix_recovery_credential_expires\` (\`expires_at\`, \`id\`),
      CONSTRAINT \`fk_recovery_credential_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_recovery_credential_status\` CHECK (\`status\` IN (1, 2, 3))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='密码保护二维码恢复凭证的当前及历史记录'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`user_security_event\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '事件状态，固定为 RecordStatus.RECORDED=1，安全事实不可改写',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间；不可变记录固定等于 created_at',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；安全事实禁止删除，恒为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '被操作用户，引用 user.id',
      \`session_key\` CHAR(36) NULL DEFAULT NULL COMMENT 'Redis 玩家会话定位键，不是数据库外键',
      \`admin_session_key\` CHAR(36) NULL DEFAULT NULL COMMENT 'Redis 管理会话定位键，不是数据库外键',
      \`admin_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '由 Admin 处理时的身份，引用 user.id',
      \`device_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '本事件涉及的设备，引用 device.id；设备凭证轮换/撤销时填写',
      \`support_conversation_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '人工客服参与的账号恢复或安全处置会话，引用 support_conversation.id；外键由 0015 补建',
      \`event_key\` VARCHAR(160) NOT NULL COMMENT '安全事件去重键',
      \`action_type\` SMALLINT UNSIGNED NOT NULL COMMENT '事件动作：LOGIN=1/CONTACT=2/PASSWORD=3/RECOVERY=4/REVOKE=5/TOTP=6',
      \`result_type\` SMALLINT UNSIGNED NOT NULL COMMENT '事件结果：SUCCESS=1/DENIED=2/FAILED=3',
      \`snapshot\` JSON NOT NULL COMMENT '脱敏安全事件快照，不含密码秘密和验证码',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_user_security_event_event_key\` (\`event_key\`),
      KEY \`ix_user_security_event_user_status\` (\`user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_user_security_event_session\` (\`session_key\`),
      KEY \`ix_user_security_event_admin_session\` (\`admin_session_key\`),
      KEY \`ix_user_security_event_admin_user\` (\`admin_user_id\`),
      KEY \`ix_user_security_event_device\` (\`device_id\`, \`created_at\`, \`id\`),
      KEY \`ix_user_security_event_support_conversation\` (\`support_conversation_id\`, \`created_at\`, \`id\`),
      CONSTRAINT \`fk_user_security_event_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_user_security_event_admin_user_id\` FOREIGN KEY (\`admin_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_user_security_event_device_id\` FOREIGN KEY (\`device_id\`) REFERENCES \`device\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_user_security_event_status\` CHECK (\`status\` = 1),
      CONSTRAINT \`ck_user_security_event_deleted_at\` CHECK (\`deleted_at\` IS NULL),
      CONSTRAINT \`ck_user_security_event_action_type\` CHECK (\`action_type\` IN (1, 2, 3, 4, 5, 6)),
      CONSTRAINT \`ck_user_security_event_result_type\` CHECK (\`result_type\` IN (1, 2, 3))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='账号凭证及联系绑定安全历史'
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS `user_security_event`');
  await context.query('DROP TABLE IF EXISTS `recovery_credential`');
  await context.query('DROP TABLE IF EXISTS `device`');
}
