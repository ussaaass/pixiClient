import type { Sequelize } from 'sequelize';

/**
 * 0008 — 大厅、规则与配置：`game`、`game_tier`、`system_config`、`game_config`、`game_event_instance`。
 *
 * 字段与约束逐条对应 `docs/05_data/数据库设计SDD.md` §5.2。
 *
 * 批次内顺序即依赖：`game` 被 `game_tier` 引用，故在前。
 * 只建列不建外键的引用（文件头注释标注补建批次）：
 * - `game.asset_id` 目标 `asset` 表 0017 才建，外键待 0017 补建；
 * - `game_config.agent_domain_id` / `game_event_instance.agent_domain_id` 目标 `agent_domain`
 *   0009 才建，外键由 0009 补建；
 * - `game_event_instance.source_round_id` 目标 `round` 0013 才建，外键待 0013 补建。
 *
 * `game_config` 唯一索引使用 COALESCE(agent_domain_id,0) 归一：MySQL 9 直接支持
 * 函数索引，按 SDD 原样写成 `UNIQUE KEY ... ((COALESCE(agent_domain_id,0)), ...)`；
 * 若目标 MySQL 版本不支持表达式唯一索引，退化方案为加生成列后建普通唯一索引。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`game\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '游戏行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`game_code\` VARCHAR(64) NOT NULL COMMENT '稳定游戏代码，如 thirteen',
      \`name\` VARCHAR(64) NOT NULL COMMENT '显示名称',
      \`integration_type\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '接入类型：INTERNAL=1/EXTERNAL_STUB=2',
      \`client_module_key\` VARCHAR(128) NULL DEFAULT NULL COMMENT '前端注册表模块键，不为任意执行 URL',
      \`asset_id\` BIGINT UNSIGNED NOT NULL COMMENT '大厅展示封面，引用 asset 表；外键待 0017 补建',
      \`sort_order\` INT NOT NULL DEFAULT 0 COMMENT '大厅排序，数值不是状态',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_game_game_code\` (\`game_code\`),
      KEY \`ix_game_asset\` (\`asset_id\`),
      KEY \`ix_game_status_sort\` (\`status\`, \`sort_order\`, \`id\`),
      CONSTRAINT \`ck_game_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_game_integration_type\` CHECK (\`integration_type\` IN (1, 2))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='大厅游戏目录与外接 Stub'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`game_tier\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '档位行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`game_id\` BIGINT UNSIGNED NOT NULL COMMENT '所属游戏，引用 game.id',
      \`tier_code\` VARCHAR(64) NOT NULL COMMENT '游戏内唯一档位代码',
      \`name\` VARCHAR(64) NOT NULL COMMENT '档位名称',
      \`min_coins\` BIGINT NOT NULL COMMENT '准入金币下限',
      \`max_coins\` BIGINT NULL DEFAULT NULL COMMENT '准入金币上限，NULL 表示无上限',
      \`sort_order\` INT NOT NULL DEFAULT 0 COMMENT '档位排序',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_game_tier_game_code\` (\`game_id\`, \`tier_code\`),
      KEY \`ix_game_tier_game_status\` (\`game_id\`, \`status\`, \`sort_order\`, \`id\`),
      CONSTRAINT \`fk_game_tier_game_id\` FOREIGN KEY (\`game_id\`) REFERENCES \`game\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_game_tier_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_game_tier_coin_range\` CHECK (\`min_coins\` >= 0 AND (\`max_coins\` IS NULL OR \`max_coins\` >= \`min_coins\`))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='游戏难度厅及金币准入范围'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`system_config\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '配置行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`config_key\` VARCHAR(128) NOT NULL COMMENT '配置键，如 wallet.exchange',
      \`config_type\` SMALLINT UNSIGNED NOT NULL COMMENT '配置值类型，取值见 ConfigType：STRING=1/BOOLEAN=2/INTEGER=3/DECIMAL=4/JSON=5，由对应 parser 安全转换',
      \`config_value\` TEXT NOT NULL COMMENT '原始字符串；按 config_type 与 config_key 对应的运行时 parser 严格转换',
      \`description\` VARCHAR(255) NOT NULL COMMENT '面向 Admin 的用途及单位说明',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_system_config_config_key\` (\`config_key\`),
      KEY \`ix_system_config_status_type\` (\`status\`, \`config_type\`),
      CONSTRAINT \`ck_system_config_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_system_config_type\` CHECK (\`config_type\` IN (1, 2, 3, 4, 5))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='当前全局配置项'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`game_config\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '配置行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`game_id\` BIGINT UNSIGNED NOT NULL COMMENT '配置所属游戏，引用 game.id',
      \`game_tier_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '档位配置引用；全游戏配置为空',
      \`agent_domain_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '配置所属代理域；NULL 表示平台基准配置；外键由 0009 补建',
      \`scope_type\` SMALLINT UNSIGNED NOT NULL COMMENT '配置范围：GAME=1/TIER=2',
      \`config_key\` VARCHAR(128) NOT NULL COMMENT '游戏配置键',
      \`config_type\` SMALLINT UNSIGNED NOT NULL COMMENT '配置值类型，取值见 ConfigType：STRING=1/BOOLEAN=2/INTEGER=3/DECIMAL=4/JSON=5，由对应 parser 安全转换',
      \`config_value\` TEXT NOT NULL COMMENT '按领域 parser 转换的原始字符串',
      \`description\` VARCHAR(255) NOT NULL COMMENT '配置用途与计量单位',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_game_config_scope_key\` ((COALESCE(\`agent_domain_id\`,0)), \`game_id\`, (COALESCE(\`game_tier_id\`,0)), \`config_key\`),
      KEY \`ix_game_config_domain_game\` (\`agent_domain_id\`, \`game_id\`, \`status\`, \`scope_type\`),
      KEY \`ix_game_config_tier\` (\`game_tier_id\`),
      CONSTRAINT \`fk_game_config_game_id\` FOREIGN KEY (\`game_id\`) REFERENCES \`game\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_game_config_game_tier_id\` FOREIGN KEY (\`game_tier_id\`) REFERENCES \`game_tier\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_game_config_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_game_config_type\` CHECK (\`config_type\` IN (1, 2, 3, 4, 5)),
      CONSTRAINT \`ck_game_config_scope\` CHECK (((\`scope_type\` = 1) AND (\`game_tier_id\` IS NULL)) OR ((\`scope_type\` = 2) AND (\`game_tier_id\` IS NOT NULL)))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='当前游戏及档位配置项'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`game_event_instance\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '活动状态，取值见 GameEventInstanceStatus：ACTIVE=1/ENDED=2/CANCELLED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`event_key\` CHAR(36) NOT NULL COMMENT '对外不透明活动 ID，不暴露自增主键',
      \`trigger_key\` VARCHAR(160) NOT NULL COMMENT '来源事实与触发规则组合出的幂等键',
      \`event_type\` SMALLINT UNSIGNED NOT NULL COMMENT '注册的平台事件类型常量，取值由共享代码维护',
      \`agent_domain_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '活动域；NULL 表示平台级，非空时仅限此域；外键待 0009 补建',
      \`audience_scope_type\` SMALLINT UNSIGNED NOT NULL COMMENT '公告主要展示范围：GLOBAL=1/GAME=2/GAME_TIER=3',
      \`game_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '主要影响游戏；GAME/GAME_TIER 范围必填',
      \`game_tier_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '主要影响难度厅；GAME_TIER 范围必填',
      \`source_round_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '触发活动的牌局，引用 round 表；非牌局来源为空；外键待 0013 补建',
      \`source_actor_type\` SMALLINT UNSIGNED NOT NULL COMMENT '活动来源角色：USER=1/BOT=2/SYSTEM=3，区分真实来源',
      \`subject_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '公告主体，引用 user.id；服务端向该用户及其设备排除本活动',
      \`state_version\` BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '活动状态每次变化递增的并发/客户端版本',
      \`starts_at\` DATETIME(3) NOT NULL COMMENT '活动开始时间，UTC',
      \`expires_at\` DATETIME(3) NOT NULL COMMENT '配置的自然到期时间，UTC',
      \`ended_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '实际结束时间，奖池耗尽/撤销/自然到期时填写，UTC',
      \`end_reason_type\` SMALLINT UNSIGNED NULL DEFAULT NULL COMMENT '结束原因：EXPIRED=1/POOL_EXHAUSTED=2/ADMIN_CANCELLED=3',
      \`config_snapshot\` JSON NOT NULL COMMENT '创建时生效的触发规则、配置版本和范围快照',
      \`effect_snapshot\` JSON NOT NULL COMMENT '有版本的影响档位、概率/派奖变更及目标列表；目标 ID 键遵守引用命名规则',
      \`runtime_snapshot\` JSON NULL DEFAULT NULL COMMENT '可重建的展示/运行投影，不作为资金账本或概率配置权威',
      \`announcement_snapshot\` JSON NOT NULL COMMENT '已校验的公告模板键、脱敏参数和详情路由快照',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_game_event_instance_event_key\` (\`event_key\`),
      UNIQUE KEY \`uq_game_event_instance_trigger_key\` (\`trigger_key\`),
      KEY \`ix_game_event_instance_status_time\` (\`status\`, \`starts_at\`, \`expires_at\`, \`id\`),
      KEY \`ix_game_event_instance_domain\` (\`agent_domain_id\`, \`status\`, \`expires_at\`, \`id\`),
      KEY \`ix_game_event_instance_game_scope\` (\`game_id\`, \`game_tier_id\`, \`status\`, \`expires_at\`, \`id\`),
      KEY \`ix_game_event_instance_subject\` (\`subject_user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_game_event_instance_source_round\` (\`source_round_id\`),
      CONSTRAINT \`fk_game_event_instance_game_id\` FOREIGN KEY (\`game_id\`) REFERENCES \`game\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_game_event_instance_game_tier_id\` FOREIGN KEY (\`game_tier_id\`) REFERENCES \`game_tier\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_game_event_instance_subject_user_id\` FOREIGN KEY (\`subject_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_game_event_instance_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_game_event_instance_scope\` CHECK (((\`audience_scope_type\` = 1) AND (\`game_id\` IS NULL AND \`game_tier_id\` IS NULL)) OR ((\`audience_scope_type\` = 2) AND (\`game_id\` IS NOT NULL AND \`game_tier_id\` IS NULL)) OR ((\`audience_scope_type\` = 3) AND (\`game_id\` IS NOT NULL AND \`game_tier_id\` IS NOT NULL))),
      CONSTRAINT \`ck_game_event_instance_end_reason\` CHECK ((\`status\` = 1 AND \`ended_at\` IS NULL AND \`end_reason_type\` IS NULL) OR ((\`status\` IN (2, 3)) AND \`ended_at\` IS NOT NULL AND \`end_reason_type\` IN (1, 2, 3)))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='跨牌局持续的平台活动状态及其安全公告快照'
  `);

  // `game_event_instance.source_round_id` 引用 round 表（0013 建），本批次只建列，
  // 外键由 0013 批次 up 末尾补建（RESTRICT），down 在 0013 对应 DROP。
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS `game_event_instance`');
  await context.query('DROP TABLE IF EXISTS `game_config`');
  await context.query('DROP TABLE IF EXISTS `system_config`');
  await context.query('DROP TABLE IF EXISTS `game_tier`');
  await context.query('DROP TABLE IF EXISTS `game`');
}
