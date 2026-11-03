import type { Sequelize } from 'sequelize';

/**
 * 0002 — 统一身份表 `user`。
 *
 * 字段与约束逐条对应 `docs/05_data/数据库设计SDD.md` §5.1 `user`。
 * 注意：`user` 在 MySQL 里是保留字风险对象，全部标识符使用反引号。
 *
 * `asset_id`（头像文件引用）在此只建列不建外键——目标表 `asset` 属于文件资产域，
 * 尚未在本次迁移批次建立；外键在其后的资产迁移中补，避免指向不存在的表。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`user\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '账号状态，取值见 UserStatus：ACTIVE=1/DISABLED=2/CLOSED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`role_type\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '角色位标记：PLAYER=1/AGENT=2/ADMIN=4/SYSTEM=8，合法组合为 1、3、4、8',
      \`reward_type\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '本用户作为上级时的返点模式：RECHARGE=1/LOSS=2',
      \`public_code\` VARCHAR(32) NOT NULL COMMENT '随机不透明的公开好友码，可编码为二维码查找，不作登录凭证',
      \`username\` VARCHAR(64) NULL DEFAULT NULL COMMENT '规范化用户名，设置后可用于账号登录',
      \`password_hash\` VARCHAR(255) NULL DEFAULT NULL COMMENT '可选用户名密码的 Argon2id/bcrypt 哈希，不保存明文',
      \`password_set_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '首次设置密码的时间，UTC',
      \`email\` VARCHAR(254) NULL DEFAULT NULL COMMENT '用户邮箱，规范化后唯一',
      \`email_verified_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '邮箱验证成功时间；绑定/换绑不写此字段',
      \`phone\` VARCHAR(32) NULL DEFAULT NULL COMMENT '规范化 E.164 手机号，唯一',
      \`phone_verified_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '手机验证成功时间；绑定/换绑不写此字段',
      \`totp_secret_ciphertext\` VARBINARY(512) NULL DEFAULT NULL COMMENT '可选 TOTP 共享密钥的认证加密密文，不得明文存储或写日志',
      \`totp_enabled_at\` DATETIME(3) NULL DEFAULT NULL COMMENT 'TOTP 完成二次验证并启用的时间；NULL 表示未启用',
      \`totp_last_accepted_counter\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '最近成功使用的时间步，原子拒绝同一时间步重放',
      \`totp_recovery_code_hashes\` JSON NULL DEFAULT NULL COMMENT 'TOTP 备用码哈希数组；消费后原子移除，不存明文',
      \`nickname\` VARCHAR(64) NOT NULL COMMENT '玩家昵称',
      \`asset_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '用户头像文件引用，指向 asset 表；外键待文件资产迁移补建',
      \`auth_version\` BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '身份权限撤销版本，会话建立时绑定并比对',
      \`permissions\` JSON NOT NULL COMMENT '仅 Admin 使用：获授的 permission_code 字符串数组，由应用写入，非 Admin 必须为空数组',
      \`last_login_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '最后一次成功登录时间，UTC',
      \`invite_code\` VARCHAR(32) NULL DEFAULT NULL COMMENT '普通玩家邀请代码；SYSTEM 与 ADMIN 账号必须为空',
      \`invite_code_expires_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '邀请链接/代码失效时间，默认生成后 2 年',
      \`system_marker\` TINYINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN ((\`role_type\` & 8) = 8) AND (\`status\` = 1) AND (\`deleted_at\` IS NULL) THEN 1 ELSE NULL END) STORED NULL COMMENT '有效系统身份生成为 1，其余为 NULL；以唯一索引限制全库仅一个系统用户',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_user_public_code\` (\`public_code\`),
      UNIQUE KEY \`uq_user_username\` (\`username\`),
      UNIQUE KEY \`uq_user_email\` (\`email\`),
      UNIQUE KEY \`uq_user_phone\` (\`phone\`),
      UNIQUE KEY \`uq_user_invite_code\` (\`invite_code\`),
      UNIQUE KEY \`uq_user_system_marker\` (\`system_marker\`),
      KEY \`ix_user_status_created_at\` (\`status\`, \`created_at\`, \`id\`),
      CONSTRAINT \`ck_user_role_type\` CHECK (\`role_type\` IN (1, 3, 4, 8)),
      CONSTRAINT \`ck_user_reward_type\` CHECK (\`reward_type\` IN (1, 2)),
      CONSTRAINT \`ck_user_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_user_totp_pair\` CHECK ((\`totp_secret_ciphertext\` IS NULL AND \`totp_enabled_at\` IS NULL) OR (\`totp_secret_ciphertext\` IS NOT NULL AND \`totp_enabled_at\` IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='全平台统一账号身份，含玩家、代理、系统与 Admin'
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS `user`');
}
