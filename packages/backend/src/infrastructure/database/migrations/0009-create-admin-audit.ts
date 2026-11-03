import type { Sequelize } from 'sequelize';

/**
 * 0009 — 管理与审计：`agent_domain`、`admin_permission`、`admin_audit_event`、`agent_audit_event`。
 *
 * 字段与约束逐条对应 `docs/05_data/数据库设计SDD.md` §5.2.1 与 §5.8。
 *
 * 不可变：两张审计事件表均为审计事实，`status` 固定 RECORDED=1、
 * `updated_at` 固定等于 `created_at`、`deleted_at` 恒为 NULL（写法见 0004/0006）。
 *
 * 目标表在同批次或更早批次的引用直接建 RESTRICT 外键：
 * - `admin_audit_event.system_config_id / game_config_id` → 0008（已建）；
 * 只建列不建外键的引用（目标表在后批次建立）：
 * - `admin_audit_event.withdrawal_id` → 0010（由 0015 补建）；
 * - `admin_audit_event.referral_binding_event_id` → 0012；`support_conversation_id` → 0015；
 *   `coin_market_trade_id` → 0016（均由 0016 补建）。
 * - `user_security_event.support_conversation_id` → 0015（由 0015 补建，见 0007）。
 * 资金引用 asset_operation_id 目标表已有，直接建 RESTRICT 外键。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`agent_domain\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '代理域状态，取值见 AgentDomainStatus：PENDING_REVIEW=1/ACTIVE=2/SUSPENDED=3/REVOKED=4/WITHDRAWN=5',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '代理域所有者，关联统一 user；该用户仍使用原 user ID 登录',
      \`capabilities\` JSON NOT NULL COMMENT 'Admin 已授予的 capability code 字符串数组，不存任意 path/script',
      \`approved_at\` DATETIME(3) NULL DEFAULT NULL COMMENT 'Admin 批准时间，UTC',
      \`suspended_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '最近一次暂停时间，UTC',
      \`revoked_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '撤销时间；实体保留供审计，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_agent_domain_user_id\` (\`user_id\`),
      KEY \`ix_agent_domain_status_created\` (\`status\`, \`created_at\`, \`id\`),
      CONSTRAINT \`fk_agent_domain_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_agent_domain_status\` CHECK (\`status\` IN (1, 2, 3, 4, 5))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='已获批普通用户拥有的运营权限与数据隔离范围，不表示独立账号'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`admin_permission\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '权限行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`permission_code\` VARCHAR(128) NOT NULL COMMENT '权限码，如 wallet.adjust',
      \`name\` VARCHAR(100) NOT NULL COMMENT '权限名称',
      \`http_method\` VARCHAR(12) NOT NULL COMMENT '路由方法，如 GET、POST、PATCH、DELETE',
      \`path_pattern\` VARCHAR(255) NOT NULL COMMENT '后台 API 路由模板，如 /api/admin/users/:user_id；不含 query string',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_admin_permission_code\` (\`permission_code\`),
      UNIQUE KEY \`uq_admin_permission_route\` (\`http_method\`, \`path_pattern\`),
      CONSTRAINT \`ck_admin_permission_status\` CHECK (\`status\` IN (1, 2, 3))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='后台操作权限'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`admin_audit_event\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '事件状态，固定为 RecordStatus.RECORDED=1，审计事实不可改写',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间；不可变记录固定等于 created_at',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；审计事实禁止删除，恒为 NULL',
      \`admin_user_id\` BIGINT UNSIGNED NOT NULL COMMENT '管理操作人，引用 user.id',
      \`admin_session_key\` CHAR(36) NULL DEFAULT NULL COMMENT 'Redis 后台会话的不透明审计关联键，不作为外键',
      \`user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '涉及的玩家，引用 user.id',
      \`target_admin_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '本次权限/账号管理操作的目标管理员，引用 user.id',
      \`asset_operation_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '资产操作，引用 asset_operation.id',
      \`withdrawal_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '审核提现；外键待 0010 补建',
      \`system_config_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '本次改动的全局配置记录，引用 system_config.id',
      \`game_config_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '本次改动的游戏配置记录，引用 game_config.id',
      \`agent_domain_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '涉及的代理域；代理域授权、广播或域配置操作使用',
      \`referral_binding_event_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '管理换绑事件；外键待 0012 补建',
      \`support_conversation_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '客服分派、消息管理或人工账号恢复对应的客服会话；外键待 0015 补建',
      \`coin_market_trade_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '集市争议裁决、延期或复核对应的成交；外键待 0016 补建',
      \`request_key\` VARCHAR(160) NOT NULL COMMENT '请求与操作关联值',
      \`action_code\` VARCHAR(128) NOT NULL COMMENT '权限对应动作码',
      \`result_type\` SMALLINT UNSIGNED NOT NULL COMMENT '操作结果：SUCCESS=1/DENIED=2/FAILED=3',
      \`reason\` VARCHAR(500) NOT NULL COMMENT '操作理由及失败说明',
      \`snapshot\` JSON NOT NULL COMMENT '脱敏前后数据与关联对象',
      \`ip_hash\` BINARY(32) NOT NULL COMMENT '访问 IP 带密钥摘要',
      PRIMARY KEY (\`id\`),
      KEY \`ix_admin_audit_event_admin_user\` (\`admin_user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_admin_audit_event_admin_session\` (\`admin_session_key\`),
      KEY \`ix_admin_audit_event_user\` (\`user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_admin_audit_event_target_admin\` (\`target_admin_user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_admin_audit_event_request_key\` (\`request_key\`),
      KEY \`ix_admin_audit_event_asset_operation\` (\`asset_operation_id\`),
      KEY \`ix_admin_audit_event_withdrawal\` (\`withdrawal_id\`),
      KEY \`ix_admin_audit_event_system_config\` (\`system_config_id\`),
      KEY \`ix_admin_audit_event_game_config\` (\`game_config_id\`),
      KEY \`ix_admin_audit_event_agent_domain\` (\`agent_domain_id\`, \`created_at\`, \`id\`),
      KEY \`ix_admin_audit_event_referral_event\` (\`referral_binding_event_id\`),
      KEY \`ix_admin_audit_event_support_conversation\` (\`support_conversation_id\`),
      KEY \`ix_admin_audit_event_coin_market_trade\` (\`coin_market_trade_id\`, \`created_at\`, \`id\`),
      CONSTRAINT \`fk_admin_audit_event_admin_user_id\` FOREIGN KEY (\`admin_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_admin_audit_event_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_admin_audit_event_target_admin_user_id\` FOREIGN KEY (\`target_admin_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_admin_audit_event_asset_operation_id\` FOREIGN KEY (\`asset_operation_id\`) REFERENCES \`asset_operation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_admin_audit_event_agent_domain_id\` FOREIGN KEY (\`agent_domain_id\`) REFERENCES \`agent_domain\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_admin_audit_event_system_config_id\` FOREIGN KEY (\`system_config_id\`) REFERENCES \`system_config\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_admin_audit_event_game_config_id\` FOREIGN KEY (\`game_config_id\`) REFERENCES \`game_config\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_admin_audit_event_status\` CHECK (\`status\` = 1),
      CONSTRAINT \`ck_admin_audit_event_deleted_at\` CHECK (\`deleted_at\` IS NULL),
      CONSTRAINT \`ck_admin_audit_event_result_type\` CHECK (\`result_type\` IN (1, 2, 3)),
      CONSTRAINT \`ck_admin_audit_event_single_config\` CHECK (\`system_config_id\` IS NULL OR \`game_config_id\` IS NULL)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='后台不可变操作审计'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`agent_audit_event\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '事件状态，固定为 RecordStatus.RECORDED=1，审计事实不可改写',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间；不可变记录固定等于 created_at',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；审计事实禁止删除，恒为 NULL',
      \`agent_domain_id\` BIGINT UNSIGNED NOT NULL COMMENT '操作所属代理域，引用 agent_domain.id',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '代理操作者，关联统一 user',
      \`action_code\` VARCHAR(128) NOT NULL COMMENT '已登记动作，如 DOWNLINE_DETAIL_READ/PRIVATE_MESSAGE_READ/CONFIG_PUBLISH',
      \`resource_type\` VARCHAR(64) NOT NULL COMMENT '目标资源类型，如 SOCIAL_CONVERSATION/ASSET_OPERATION/ROUND',
      \`resource_key\` VARCHAR(160) NOT NULL COMMENT '目标资源标识；不作为任意表外键',
      \`purpose\` VARCHAR(255) NOT NULL COMMENT '读取私聊/导出等敏感操作的业务目的或工单引用',
      \`request_key\` VARCHAR(160) NOT NULL COMMENT '一次后台请求的幂等审计键',
      \`result_type\` SMALLINT UNSIGNED NOT NULL COMMENT '操作结果：SUCCESS=1/DENIED=2/FAILED=3',
      \`snapshot\` JSON NOT NULL COMMENT '脱敏查询条件/影响计数；不得含消息正文或认证秘密',
      \`ip_hash\` BINARY(32) NOT NULL COMMENT '操作来源 IP 的带密钥摘要',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_agent_audit_event_request_key\` (\`request_key\`),
      KEY \`ix_agent_audit_event_domain\` (\`agent_domain_id\`, \`created_at\`, \`id\`),
      KEY \`ix_agent_audit_event_user\` (\`user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_agent_audit_event_resource\` (\`resource_type\`, \`resource_key\`, \`created_at\`, \`id\`),
      CONSTRAINT \`fk_agent_audit_event_agent_domain_id\` FOREIGN KEY (\`agent_domain_id\`) REFERENCES \`agent_domain\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_agent_audit_event_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_agent_audit_event_status\` CHECK (\`status\` = 1),
      CONSTRAINT \`ck_agent_audit_event_deleted_at\` CHECK (\`deleted_at\` IS NULL),
      CONSTRAINT \`ck_agent_audit_event_result_type\` CHECK (\`result_type\` IN (1, 2, 3))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='代理后台敏感数据读取与运营操作的不可变审计'
  `);

  // 0008 中已建列待本批次补建的外键：agent_domain 建完后，game_config / game_event_instance
  // 的 agent_domain_id 补建 RESTRICT 外键。
  await context.query(`
    ALTER TABLE \`game_config\`
      ADD CONSTRAINT \`fk_game_config_agent_domain_id\` FOREIGN KEY (\`agent_domain_id\`) REFERENCES \`agent_domain\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
  await context.query(`
    ALTER TABLE \`game_event_instance\`
      ADD CONSTRAINT \`fk_game_event_instance_agent_domain_id\` FOREIGN KEY (\`agent_domain_id\`) REFERENCES \`agent_domain\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('ALTER TABLE `game_event_instance` DROP CONSTRAINT `fk_game_event_instance_agent_domain_id`');
  await context.query('ALTER TABLE `game_config` DROP CONSTRAINT `fk_game_config_agent_domain_id`');
  await context.query('DROP TABLE IF EXISTS `agent_audit_event`');
  await context.query('DROP TABLE IF EXISTS `admin_audit_event`');
  await context.query('DROP TABLE IF EXISTS `admin_permission`');
  await context.query('DROP TABLE IF EXISTS `agent_domain`');
}
