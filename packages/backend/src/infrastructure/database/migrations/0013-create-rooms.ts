import type { Sequelize } from 'sequelize';

/**
 * 0013 — 房间、牌局与恢复：`room`、`room_membership`、`round`、`round_player`、
 * `round_event`、`settlement`、`game_entry`。
 *
 * 字段与约束逐条对应 `docs/05_data/数据库设计SDD.md` §5.7 与 §5.2.1 `game_entry`。
 * 批次内顺序即依赖：`room` → `room_membership` / `round` → `round_player` →
 * `round_event` / `settlement`；`game_entry` 依赖 0008 的 `game`/`game_tier`。
 *
 * 不可变：`round_event` 为可恢复牌局事件流水，`status` 固定 RECORDED=1、
 * `updated_at` 固定等于 `created_at`、`deleted_at` 恒为 NULL。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`room\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '房间状态，取值见 RoomStatus：WAITING=1/ACTIVE=2/RECOVERING=3/CLOSED=4',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`game_id\` BIGINT UNSIGNED NOT NULL COMMENT '游戏，引用 game.id',
      \`game_tier_id\` BIGINT UNSIGNED NOT NULL COMMENT '难度厅，引用 game_tier.id',
      \`room_key\` VARCHAR(64) NOT NULL COMMENT '公开房号',
      \`room_type\` SMALLINT UNSIGNED NOT NULL COMMENT '房间类型：PRIVATE=1/MATCHED=2',
      \`capacity\` SMALLINT UNSIGNED NOT NULL COMMENT '游戏/档位配置的最大玩家数快照',
      \`rules_snapshot\` JSON NOT NULL COMMENT '创建时解析规则快照，发布配置不改当前局',
      \`version\` BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '房间持久事件版本',
      \`owner_key\` VARCHAR(128) NULL DEFAULT NULL COMMENT '当前持有房间的游戏进程实例标识',
      \`fencing_token\` BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '每次进程接管递增，拒绝旧进程写入',
      \`checkpoint_version\` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '当前已持久化房间检查点版本',
      \`closed_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '关闭时间，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_room_room_key\` (\`room_key\`),
      KEY \`ix_room_tier_status\` (\`game_tier_id\`, \`status\`, \`created_at\`, \`id\`),
      CONSTRAINT \`fk_room_game_id\` FOREIGN KEY (\`game_id\`) REFERENCES \`game\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_room_game_tier_id\` FOREIGN KEY (\`game_tier_id\`) REFERENCES \`game_tier\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_room_status\` CHECK (\`status\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_room_type\` CHECK (\`room_type\` IN (1, 2)),
      CONSTRAINT \`ck_room_fencing_token\` CHECK (\`fencing_token\` >= 1),
      CONSTRAINT \`ck_room_checkpoint_version\` CHECK (\`checkpoint_version\` >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='房间生命周期、规则快照及当前游戏进程接管栅栏'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`room_membership\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '成员状态，取值见 MembershipStatus：SEATED=1/LEFT=2',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`room_id\` BIGINT UNSIGNED NOT NULL COMMENT '房间，引用 room.id',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '玩家，引用 user.id；同一用户不能跨房重复入座',
      \`seat_no\` SMALLINT UNSIGNED NOT NULL COMMENT '座位编号 1 到 4',
      \`joined_at\` DATETIME(3) NOT NULL COMMENT '入座时间，UTC',
      \`left_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '离座时间，UTC',
      \`game_state_ciphertext\` MEDIUMBLOB NULL DEFAULT NULL COMMENT '当前这次房间成员关系的游戏专属累积状态密文；用于可跨 round 恢复的积分进度等，平台不解释其内部字段',
      \`game_state_version\` BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '当前成员游戏状态的并发版本；每次成功更新或清空递增，不使用 0',
      \`active_marker\` TINYINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN (\`status\` = 1) AND (\`deleted_at\` IS NULL) THEN 1 ELSE NULL END) STORED NULL COMMENT '有效入座且未删除为 1，否则 NULL；以唯一索引限制每个用户至多一个有效入座',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_room_membership_active_user\` (\`user_id\`, \`active_marker\`),
      UNIQUE KEY \`uq_room_membership_active_seat\` (\`room_id\`, \`seat_no\`, \`active_marker\`),
      KEY \`ix_room_membership_room_status\` (\`room_id\`, \`status\`, \`id\`),
      CONSTRAINT \`fk_room_membership_room_id\` FOREIGN KEY (\`room_id\`) REFERENCES \`room\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_room_membership_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_room_membership_status\` CHECK (\`status\` IN (1, 2)),
      CONSTRAINT \`ck_room_membership_seat\` CHECK (\`seat_no\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_room_membership_state_version\` CHECK (\`game_state_version\` >= 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='房间座位及用户有效归属'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`round\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '牌局状态，取值见 RoundStatus：PREPARING=1/ACTIVE=2/SETTLING=3/SETTLED=4/CANCELLED=5/RECOVERING=6',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`room_id\` BIGINT UNSIGNED NOT NULL COMMENT '所属房间，引用 room.id',
      \`round_no\` BIGINT UNSIGNED NOT NULL COMMENT '房间内局号',
      \`round_key\` CHAR(36) NOT NULL COMMENT '全局牌局业务编号',
      \`fencing_token\` BIGINT UNSIGNED NOT NULL COMMENT '本局所有权版本；关键写入须与 room.fencing_token 一致',
      \`handler_version\` VARCHAR(64) NOT NULL COMMENT '创建本局时使用的游戏 handler 版本，保证历史局可回放',
      \`rules_snapshot\` JSON NOT NULL COMMENT '游戏 handler 提供的完整规则快照，平台不解释其内部字段',
      \`rules_hash\` BINARY(32) NOT NULL COMMENT '规则快照摘要',
      \`game_state_ciphertext\` MEDIUMBLOB NULL DEFAULT NULL COMMENT 'handler 私有的随机/状态恢复数据，平台不解释内容',
      \`playing_started_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '本局可交互阶段开始时间，UTC',
      \`playing_deadline_at\` DATETIME(3) NULL DEFAULT NULL COMMENT 'handler 规定的本局操作截止时间，UTC',
      \`settlement_input\` JSON NULL DEFAULT NULL COMMENT '已封存的 handler 结算输入与超时结果',
      \`settlement_input_hash\` BINARY(32) NULL DEFAULT NULL COMMENT '不可变结算意图摘要',
      \`settled_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '资金与战绩提交时间，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_round_room_no\` (\`room_id\`, \`round_no\`),
      UNIQUE KEY \`uq_round_round_key\` (\`round_key\`),
      KEY \`ix_round_status_deadline\` (\`status\`, \`playing_deadline_at\`, \`id\`),
      CONSTRAINT \`fk_round_room_id\` FOREIGN KEY (\`room_id\`) REFERENCES \`room\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_round_status\` CHECK (\`status\` IN (1, 2, 3, 4, 5, 6))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='一局通用生命周期、handler 版本和恢复输入'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`round_player\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '玩家状态，取值见 RoundPlayerStatus：ACTIVE=1/SUBMITTED=2/SETTLED=3/ABORTED=4',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`round_id\` BIGINT UNSIGNED NOT NULL COMMENT '牌局，引用 round.id',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '玩家，引用 user.id',
      \`room_membership_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '房间局开局时锁定的成员关系；非房间运行模式为空',
      \`seat_no\` SMALLINT UNSIGNED NOT NULL COMMENT '本局座次，1 到 4',
      \`asset_hold_id\` BIGINT UNSIGNED NOT NULL COMMENT '开局最大赔付金币占款，引用 asset_hold.id；本局内不可变',
      \`player_state_ciphertext\` MEDIUMBLOB NULL DEFAULT NULL COMMENT 'handler 私有的玩家状态加密数据',
      \`submission_snapshot\` JSON NULL DEFAULT NULL COMMENT 'handler 定义的玩家提交内容，平台不解释内部字段',
      \`submission_key\` CHAR(36) NULL DEFAULT NULL COMMENT '提交命令幂等定位值；重复提交返回原结果',
      \`submission_hash\` BINARY(32) NULL DEFAULT NULL COMMENT '提交内容摘要',
      \`submitted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '成功持久化提交时间，UTC',
      \`submission_type\` SMALLINT UNSIGNED NULL DEFAULT NULL COMMENT '提交类型：MANUAL=1/TIMEOUT_AUTO=2',
      \`wager_coins\` BIGINT NOT NULL COMMENT '本局规则定义的有效下注额，流水计算基数',
      \`max_loss_hold_coins\` BIGINT NOT NULL COMMENT '赔付上限，独立于 wager',
      \`net_coin_delta\` BIGINT NULL DEFAULT NULL COMMENT '实际金币净变化，有符号整数',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_round_player_round_user\` (\`round_id\`, \`user_id\`),
      UNIQUE KEY \`uq_round_player_round_seat\` (\`round_id\`, \`seat_no\`),
      UNIQUE KEY \`uq_round_player_hold\` (\`asset_hold_id\`),
      UNIQUE KEY \`uq_round_player_submission_key\` (\`submission_key\`),
      KEY \`ix_round_player_user_status\` (\`user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_round_player_membership\` (\`room_membership_id\`, \`round_id\`),
      CONSTRAINT \`fk_round_player_round_id\` FOREIGN KEY (\`round_id\`) REFERENCES \`round\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_round_player_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_round_player_membership\` FOREIGN KEY (\`room_membership_id\`) REFERENCES \`room_membership\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_round_player_hold\` FOREIGN KEY (\`asset_hold_id\`) REFERENCES \`asset_hold\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_round_player_status\` CHECK (\`status\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_round_player_seat\` CHECK (\`seat_no\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_round_player_submission_type\` CHECK (\`submission_type\` IS NULL OR \`submission_type\` IN (1, 2)),
      CONSTRAINT \`ck_round_player_coins\` CHECK (\`wager_coins\` >= 0 AND \`max_loss_hold_coins\` >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='通用牌局参与人、资产风险和结算结果'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`round_event\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '事件状态，固定为 RecordStatus.RECORDED=1，可恢复牌局事件不可改写',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间；不可变记录固定等于 created_at',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；牌局恢复事实禁止删除，恒为 NULL',
      \`round_id\` BIGINT UNSIGNED NOT NULL COMMENT '牌局，引用 round.id',
      \`round_player_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '涉及某玩家时引用 round_player.id',
      \`seq\` BIGINT UNSIGNED NOT NULL COMMENT '局内连续事件序号',
      \`event_key\` VARCHAR(160) NOT NULL COMMENT '命令或事件幂等语义键',
      \`event_type\` SMALLINT UNSIGNED NOT NULL COMMENT '事件类型：START=1/SUBMIT=2/INTENT=3/SETTLE=4/RECOVER=5/CANCEL=6',
      \`fencing_token\` BIGINT UNSIGNED NOT NULL COMMENT '写入 owner 版本',
      \`payload_ciphertext\` MEDIUMBLOB NOT NULL COMMENT '可恢复事件加密负载',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_round_event_round_seq\` (\`round_id\`, \`seq\`),
      UNIQUE KEY \`uq_round_event_event_key\` (\`event_key\`),
      KEY \`ix_round_event_player\` (\`round_player_id\`),
      CONSTRAINT \`fk_round_event_round_id\` FOREIGN KEY (\`round_id\`) REFERENCES \`round\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_round_event_round_player_id\` FOREIGN KEY (\`round_player_id\`) REFERENCES \`round_player\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_round_event_status\` CHECK (\`status\` = 1),
      CONSTRAINT \`ck_round_event_deleted_at\` CHECK (\`deleted_at\` IS NULL),
      CONSTRAINT \`ck_round_event_type\` CHECK (\`event_type\` IN (1, 2, 3, 4, 5, 6)),
      CONSTRAINT \`ck_round_event_seq\` CHECK (\`seq\` >= 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='低频可恢复牌局事件'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`settlement\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '结算状态，取值见 SettlementStatus：PREPARED=1/COMMITTED=2/CANCELLED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；结算结论不可软删，恒为 NULL',
      \`round_id\` BIGINT UNSIGNED NOT NULL COMMENT '被结算牌局，引用 round.id；每局至多一条',
      \`asset_operation_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '完成资产操作，引用 asset_operation.id；作废局可为空',
      \`input_hash\` BINARY(32) NOT NULL COMMENT '匹配牌局封存输入',
      \`result_hash\` BINARY(32) NOT NULL COMMENT '最终结果摘要',
      \`result_snapshot\` JSON NOT NULL COMMENT '游戏 handler 生成的完整结算结果，含其 schema/version 和展示数据',
      \`completed_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '结算完成时刻，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_settlement_round_id\` (\`round_id\`),
      UNIQUE KEY \`uq_settlement_asset_operation\` (\`asset_operation_id\`),
      CONSTRAINT \`fk_settlement_round_id\` FOREIGN KEY (\`round_id\`) REFERENCES \`round\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_settlement_asset_operation_id\` FOREIGN KEY (\`asset_operation_id\`) REFERENCES \`asset_operation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_settlement_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_settlement_deleted_at\` CHECK (\`deleted_at\` IS NULL)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='唯一牌局资产结算与战绩'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`game_entry\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '入局状态，取值见 EntryStatus：QUEUED=1/SEATED=2/FINISHED=3/CANCELLED=4/EXPIRED=5',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '入局玩家，引用 user.id；一个用户全平台最多一个有效准入',
      \`game_id\` BIGINT UNSIGNED NOT NULL COMMENT '目标游戏，引用 game.id',
      \`game_tier_id\` BIGINT UNSIGNED NOT NULL COMMENT '目标难度厅，引用 game_tier.id',
      \`entry_key\` CHAR(36) NOT NULL COMMENT '准入请求幂等定位值',
      \`rules_snapshot\` JSON NOT NULL COMMENT '解析后的准入和规则配置快照',
      \`room_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '匹配成功后的房间，引用 room.id',
      \`expires_at\` DATETIME(3) NOT NULL COMMENT '待匹配资格有效期，UTC',
      \`active_marker\` TINYINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN (\`status\` IN (1, 2)) AND (\`deleted_at\` IS NULL) THEN 1 ELSE NULL END) STORED NULL COMMENT '有效未删除入局资格为 1，否则 NULL；以唯一索引限制每个用户至多一个有效准入',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_game_entry_entry_key\` (\`entry_key\`),
      UNIQUE KEY \`uq_game_entry_active_user\` (\`user_id\`, \`active_marker\`),
      KEY \`ix_game_entry_tier_status\` (\`game_tier_id\`, \`status\`, \`created_at\`, \`id\`),
      KEY \`ix_game_entry_room\` (\`room_id\`),
      CONSTRAINT \`fk_game_entry_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_game_entry_game_id\` FOREIGN KEY (\`game_id\`) REFERENCES \`game\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_game_entry_game_tier_id\` FOREIGN KEY (\`game_tier_id\`) REFERENCES \`game_tier\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_game_entry_status\` CHECK (\`status\` IN (1, 2, 3, 4, 5))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='游戏准入及当前入局资格'
  `);

  // round 表建完后，补建 0008 中 game_event_instance.source_round_id 的外键（RESTRICT）。
  await context.query(`
    ALTER TABLE \`game_event_instance\`
      ADD CONSTRAINT \`fk_game_event_instance_source_round_id\` FOREIGN KEY (\`source_round_id\`) REFERENCES \`round\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('ALTER TABLE `game_event_instance` DROP CONSTRAINT `fk_game_event_instance_source_round_id`');
  await context.query('DROP TABLE IF EXISTS `game_entry`');
  await context.query('DROP TABLE IF EXISTS `settlement`');
  await context.query('DROP TABLE IF EXISTS `round_event`');
  await context.query('DROP TABLE IF EXISTS `round_player`');
  await context.query('DROP TABLE IF EXISTS `round`');
  await context.query('DROP TABLE IF EXISTS `room_membership`');
  await context.query('DROP TABLE IF EXISTS `room`');
}
