import type { Sequelize } from 'sequelize';

/**
 * 0014 — 社交：`social_topic`、`social_post`、`social_post_reply`、`social_friendship`、
 * `social_conversation`、`social_message`、`social_content_interaction`、`social_block`、`social_report`。
 *
 * 字段与约束逐条对应 `docs/05_data/数据库设计SDD.md` §5.12。
 * 批次内顺序即依赖：`social_topic`/`social_post` 被回复与互动表引用，故在前。
 *
 * 只建列不建外键的引用（目标表 0017 才建）：
 * - 各表的 `cover_asset_id` / `asset_id` 引用 `asset` 表，只建列不建外键，注释标注"外键待 0017 补建"。
 * `agent_domain_id` 目标表 0009 已建，直接建 RESTRICT 外键。
 *
 * `social_topic` 唯一索引使用 COALESCE(agent_domain_id,0) 归一：MySQL 9 直接支持
 * 函数索引，按 SDD 原样写成 `UNIQUE KEY ... ((COALESCE(agent_domain_id,0)), topic_key)`。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`social_topic\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '话题行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`agent_domain_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '话题所属代理域；NULL 表示平台公共话题，引用 agent_domain.id',
      \`topic_key\` VARCHAR(64) NOT NULL COMMENT 'scope 内稳定话题键',
      \`name\` VARCHAR(100) NOT NULL COMMENT '展示名称',
      \`description\` VARCHAR(1000) NULL DEFAULT NULL COMMENT '话题说明',
      \`cover_asset_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '话题封面，引用 asset 表；外键待 0017 补建',
      \`sort_order\` INT NOT NULL DEFAULT 0 COMMENT '同域展示排序；数值不是状态常量',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_social_topic_scope_key\` ((COALESCE(\`agent_domain_id\`,0)), \`topic_key\`),
      KEY \`ix_social_topic_domain_status\` (\`agent_domain_id\`, \`status\`, \`sort_order\`, \`id\`),
      KEY \`ix_social_topic_cover_asset\` (\`cover_asset_id\`),
      CONSTRAINT \`fk_social_topic_agent_domain_id\` FOREIGN KEY (\`agent_domain_id\`) REFERENCES \`agent_domain\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_social_topic_status\` CHECK (\`status\` IN (1, 2, 3))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='平台公共或代理域专属的社区话题目录'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`social_post\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '帖子状态，取值见 SocialPostStatus：PENDING_REVIEW=1/PUBLISHED=2/HIDDEN=3/REDACTED=4',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`agent_domain_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '帖子 scope；NULL 表示平台公共社区，引用 agent_domain.id',
      \`social_topic_id\` BIGINT UNSIGNED NOT NULL COMMENT '帖子主话题，引用 social_topic.id',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '作者，引用 user.id',
      \`post_key\` VARCHAR(160) NOT NULL COMMENT '创建/重试幂等键',
      \`title\` VARCHAR(160) NULL DEFAULT NULL COMMENT '可选标题',
      \`body_text\` MEDIUMTEXT NULL DEFAULT NULL COMMENT '正文；脱敏/删除时清空',
      \`asset_ids\` JSON NOT NULL COMMENT '帖子图片对应的 asset.id 数组；不存文件 URL 或密钥；写时逐个校验归属/READY/图片 MIME',
      \`pinned_until\` DATETIME(3) NULL DEFAULT NULL COMMENT '运营置顶失效时间，UTC',
      \`pinned_by_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '执行置顶的 Admin/代理 user，引用 user.id',
      \`moderated_by_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '最近处理内容的 Admin/代理 user，引用 user.id',
      \`moderated_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '最近审核时间，UTC',
      \`moderation_note\` VARCHAR(500) NULL DEFAULT NULL COMMENT '脱敏审核理由，不记录私密凭证',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_social_post_post_key\` (\`post_key\`),
      KEY \`ix_social_post_domain_status\` (\`agent_domain_id\`, \`status\`, \`created_at\`, \`id\`),
      KEY \`ix_social_post_topic_status\` (\`social_topic_id\`, \`status\`, \`created_at\`, \`id\`),
      KEY \`ix_social_post_user_status\` (\`user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_social_post_pinned\` (\`pinned_until\`, \`status\`, \`id\`),
      KEY \`ix_social_post_pinned_by\` (\`pinned_by_user_id\`),
      KEY \`ix_social_post_moderated_by\` (\`moderated_by_user_id\`),
      CONSTRAINT \`fk_social_post_agent_domain_id\` FOREIGN KEY (\`agent_domain_id\`) REFERENCES \`agent_domain\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_post_social_topic_id\` FOREIGN KEY (\`social_topic_id\`) REFERENCES \`social_topic\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_post_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_post_pinned_by_user_id\` FOREIGN KEY (\`pinned_by_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_post_moderated_by_user_id\` FOREIGN KEY (\`moderated_by_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_social_post_status\` CHECK (\`status\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_social_post_redacted\` CHECK ((\`status\` = 4) = (\`body_text\` IS NULL AND (\`asset_ids\` = JSON_ARRAY())))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='社区公开帖子及其可见范围/审核状态'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`social_post_reply\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '回复状态，取值见 SocialPostReplyStatus：PENDING_REVIEW=1/PUBLISHED=2/HIDDEN=3/REDACTED=4',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`social_post_id\` BIGINT UNSIGNED NOT NULL COMMENT '所属帖子，引用 social_post.id；scope 继承自帖子',
      \`parent_social_post_reply_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '被回复的一级回复；NULL 表示直接回复帖子；回复深度最多一层',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '作者，引用 user.id',
      \`reply_key\` VARCHAR(160) NOT NULL COMMENT '创建/重试幂等键',
      \`body_text\` TEXT NULL DEFAULT NULL COMMENT '回复正文；脱敏/删除时清空',
      \`moderated_by_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '最近处理内容的 Admin/代理 user，引用 user.id',
      \`moderated_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '最近审核时间，UTC',
      \`moderation_note\` VARCHAR(500) NULL DEFAULT NULL COMMENT '脱敏审核理由',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_social_post_reply_reply_key\` (\`reply_key\`),
      KEY \`ix_social_post_reply_post_status\` (\`social_post_id\`, \`status\`, \`created_at\`, \`id\`),
      KEY \`ix_social_post_reply_parent\` (\`parent_social_post_reply_id\`, \`created_at\`, \`id\`),
      KEY \`ix_social_post_reply_user_status\` (\`user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_social_post_reply_moderated_by\` (\`moderated_by_user_id\`),
      CONSTRAINT \`fk_social_post_reply_social_post_id\` FOREIGN KEY (\`social_post_id\`) REFERENCES \`social_post\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_post_reply_parent_reply\` FOREIGN KEY (\`parent_social_post_reply_id\`) REFERENCES \`social_post_reply\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_post_reply_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_post_reply_moderated_by_user_id\` FOREIGN KEY (\`moderated_by_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_social_post_reply_status\` CHECK (\`status\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_social_post_reply_redacted\` CHECK ((\`status\` = 4) = (\`body_text\` IS NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='社区帖子下的一级回复与跟帖'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`social_friendship\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '好友关系状态，取值见 SocialFriendshipStatus：PENDING=1/ACCEPTED=2/REJECTED=3/REMOVED=4',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`agent_domain_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '当前关系 scope，引用 agent_domain.id；仅同一有效 scope 可建立关系',
      \`low_user_id\` BIGINT UNSIGNED NOT NULL COMMENT 'pair 中较小 user ID，引用 user.id',
      \`high_user_id\` BIGINT UNSIGNED NOT NULL COMMENT 'pair 中较大 user ID，引用 user.id',
      \`requester_user_id\` BIGINT UNSIGNED NOT NULL COMMENT '发起好友申请的 user，引用 user.id；必须是 pair 成员',
      \`responded_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '接受或拒绝时间，UTC',
      \`ended_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '删除好友关系时间，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_social_friendship_pair\` (\`low_user_id\`, \`high_user_id\`),
      KEY \`ix_social_friendship_domain_status\` (\`agent_domain_id\`, \`status\`, \`updated_at\`, \`id\`),
      KEY \`ix_social_friendship_requester_status\` (\`requester_user_id\`, \`status\`, \`created_at\`, \`id\`),
      CONSTRAINT \`fk_social_friendship_agent_domain_id\` FOREIGN KEY (\`agent_domain_id\`) REFERENCES \`agent_domain\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_friendship_low_user_id\` FOREIGN KEY (\`low_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_friendship_high_user_id\` FOREIGN KEY (\`high_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_friendship_requester_user_id\` FOREIGN KEY (\`requester_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_social_friendship_status\` CHECK (\`status\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_social_friendship_order\` CHECK (\`low_user_id\` < \`high_user_id\`),
      CONSTRAINT \`ck_social_friendship_requester_in_pair\` CHECK (\`requester_user_id\` IN (\`low_user_id\`, \`high_user_id\`))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='两位用户之间的好友申请和关系状态'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`social_conversation\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '会话状态，取值见 SocialConversationStatus：ACTIVE=1/READ_ONLY=2/CLOSED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`agent_domain_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '会话当前 scope，引用 agent_domain.id',
      \`low_user_id\` BIGINT UNSIGNED NOT NULL COMMENT 'pair 中较小 user ID，引用 user.id；首版仅一对一，禁止 self-chat',
      \`high_user_id\` BIGINT UNSIGNED NOT NULL COMMENT 'pair 中较大 user ID，引用 user.id',
      \`last_message_no\` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '当前会话消息序号高水位；普通计数，允许 0',
      \`user_low_read_through_no\` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'low 用户已读消息序号；只能单调递增且不得超过高水位',
      \`user_high_read_through_no\` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'high 用户已读消息序号；只能单调递增且不得超过高水位',
      \`last_message_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '最近消息时间，UTC',
      \`pending_first_message_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '陌生人首句发送方；等待另一方回复时记录，好友关系建立后忽略',
      \`open_messaging_day\` DATE NULL DEFAULT NULL COMMENT '收到首句回复后允许陌生人双方继续发送的上海自然日',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_social_conversation_pair\` (\`low_user_id\`, \`high_user_id\`),
      KEY \`ix_social_conversation_domain_status\` (\`agent_domain_id\`, \`status\`, \`updated_at\`, \`id\`),
      CONSTRAINT \`fk_social_conversation_agent_domain_id\` FOREIGN KEY (\`agent_domain_id\`) REFERENCES \`agent_domain\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_conversation_low_user_id\` FOREIGN KEY (\`low_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_conversation_high_user_id\` FOREIGN KEY (\`high_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_conversation_pending_user_id\` FOREIGN KEY (\`pending_first_message_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_social_conversation_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_social_conversation_order\` CHECK (\`low_user_id\` < \`high_user_id\`),
      CONSTRAINT \`ck_social_conversation_read_through\` CHECK (\`user_low_read_through_no\` <= \`last_message_no\` AND \`user_high_read_through_no\` <= \`last_message_no\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='固定一对一私聊会话及双方阅读游标'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`social_message\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '消息状态，取值见 SocialMessageStatus：SENT=1/REDACTED=2',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；脱敏保留行位，不硬删除，恒为 NULL',
      \`social_conversation_id\` BIGINT UNSIGNED NOT NULL COMMENT '所属会话及 scope 权威来源，引用 social_conversation.id',
      \`message_no\` BIGINT UNSIGNED NOT NULL COMMENT '会话内单调递增序号',
      \`sender_user_id\` BIGINT UNSIGNED NOT NULL COMMENT '发送者，必须是会话成员，引用 user.id',
      \`client_message_id\` VARCHAR(160) NOT NULL COMMENT '发送端幂等键',
      \`message_type\` SMALLINT UNSIGNED NOT NULL COMMENT '消息类型：TEXT=1/IMAGE=2',
      \`body_text\` TEXT NULL DEFAULT NULL COMMENT '文本内容；加密附件不放正文',
      \`asset_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '单个私有加密附件，引用 asset 表；外键待 0017 补建',
      \`redacted_by_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '执行脱敏的 Admin/获授权代理，引用 user.id',
      \`redacted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '脱敏时间，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_social_message_conversation_no\` (\`social_conversation_id\`, \`message_no\`),
      UNIQUE KEY \`uq_social_message_sender_client_id\` (\`sender_user_id\`, \`client_message_id\`),
      KEY \`ix_social_message_conversation\` (\`social_conversation_id\`, \`id\`),
      KEY \`ix_social_message_sender_status\` (\`sender_user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_social_message_asset\` (\`asset_id\`),
      KEY \`ix_social_message_redacted_by\` (\`redacted_by_user_id\`),
      CONSTRAINT \`fk_social_message_conversation\` FOREIGN KEY (\`social_conversation_id\`) REFERENCES \`social_conversation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_message_sender_user_id\` FOREIGN KEY (\`sender_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_message_redacted_by_user_id\` FOREIGN KEY (\`redacted_by_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_social_message_status\` CHECK (\`status\` IN (1, 2)),
      CONSTRAINT \`ck_social_message_type\` CHECK (\`message_type\` IN (1, 2)),
      CONSTRAINT \`ck_social_message_content_pair\` CHECK (((\`message_type\` = 1) AND \`body_text\` IS NOT NULL AND \`asset_id\` IS NULL) OR ((\`message_type\` = 2) AND \`asset_id\` IS NOT NULL)),
      CONSTRAINT \`ck_social_message_redacted\` CHECK ((\`status\` = 2) = (\`body_text\` IS NULL AND \`asset_id\` IS NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='一对一社交消息、游标补拉与发送幂等'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`social_content_interaction\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '互动状态，取值见 SocialContentInteractionStatus：ACTIVE=1/REMOVED=2',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；互动可撤销但保留记录，恒为 NULL',
      \`interaction_key\` VARCHAR(160) NOT NULL COMMENT '服务端生成的 actor/target/action 稳定组合键，保证同一互动只有一条当前状态',
      \`actor_user_id\` BIGINT UNSIGNED NOT NULL COMMENT '执行互动的 user，引用 user.id',
      \`target_type\` SMALLINT UNSIGNED NOT NULL COMMENT '互动目标类型：POST=1/POST_REPLY=2/USER=3',
      \`social_post_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT 'target_type=POST 时填写，引用 social_post.id',
      \`social_post_reply_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT 'target_type=POST_REPLY 时填写，引用 social_post_reply.id',
      \`target_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT 'target_type=USER 时填写；FOLLOW_AUTHOR 的目标作者，引用 user.id',
      \`action_type\` SMALLINT UNSIGNED NOT NULL COMMENT '互动类型：DISLIKE=1/FOLLOW_AUTHOR=2；举报独立记录在 social_report',
      \`ended_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '取消 dislike/关注时记录结束时间，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_social_content_interaction_key\` (\`interaction_key\`),
      KEY \`ix_social_content_interaction_actor_status\` (\`actor_user_id\`, \`status\`, \`updated_at\`, \`id\`),
      KEY \`ix_social_content_interaction_post\` (\`target_type\`, \`social_post_id\`, \`status\`, \`id\`),
      KEY \`ix_social_content_interaction_reply\` (\`target_type\`, \`social_post_reply_id\`, \`status\`, \`id\`),
      KEY \`ix_social_content_interaction_target_user\` (\`target_user_id\`, \`status\`, \`id\`),
      CONSTRAINT \`fk_social_content_interaction_actor_user_id\` FOREIGN KEY (\`actor_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_content_interaction_social_post_id\` FOREIGN KEY (\`social_post_id\`) REFERENCES \`social_post\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_content_interaction_social_post_reply_id\` FOREIGN KEY (\`social_post_reply_id\`) REFERENCES \`social_post_reply\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_content_interaction_target_user_id\` FOREIGN KEY (\`target_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_social_content_interaction_status\` CHECK (\`status\` IN (1, 2)),
      CONSTRAINT \`ck_social_content_interaction_type\` CHECK (\`target_type\` IN (1, 2, 3)),
      CONSTRAINT \`ck_social_content_interaction_action\` CHECK (\`action_type\` IN (1, 2)),
      CONSTRAINT \`ck_social_content_interaction_single_target\` CHECK (((\`social_post_id\` IS NOT NULL) + (\`social_post_reply_id\` IS NOT NULL) + (\`target_user_id\` IS NOT NULL)) = 1),
      CONSTRAINT \`ck_social_content_interaction_target_matches_type\` CHECK (((\`target_type\` = 1) = (\`social_post_id\` IS NOT NULL)) AND ((\`target_type\` = 2) = (\`social_post_reply_id\` IS NOT NULL)) AND ((\`target_type\` = 3) = (\`target_user_id\` IS NOT NULL))),
      CONSTRAINT \`ck_social_content_interaction_no_self_follow\` CHECK ((\`action_type\` = 2) = (\`target_user_id\` IS NOT NULL) OR (\`actor_user_id\` <> \`target_user_id\`))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户对帖子或回复的轻量互动状态'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`social_block\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '屏蔽状态，取值见 SocialBlockStatus：ACTIVE=1/REMOVED=2',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；解除时更新状态不删除历史，恒为 NULL',
      \`agent_domain_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '屏蔽关系 scope，引用 agent_domain.id',
      \`blocker_user_id\` BIGINT UNSIGNED NOT NULL COMMENT '发起屏蔽的 user，引用 user.id',
      \`blocked_user_id\` BIGINT UNSIGNED NOT NULL COMMENT '被屏蔽的 user，引用 user.id',
      \`ended_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '解除屏蔽时间，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_social_block_pair\` (\`blocker_user_id\`, \`blocked_user_id\`),
      KEY \`ix_social_block_blocked_status\` (\`blocked_user_id\`, \`status\`, \`created_at\`, \`id\`),
      KEY \`ix_social_block_domain_status\` (\`agent_domain_id\`, \`status\`, \`created_at\`, \`id\`),
      CONSTRAINT \`fk_social_block_agent_domain_id\` FOREIGN KEY (\`agent_domain_id\`) REFERENCES \`agent_domain\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_block_blocker_user_id\` FOREIGN KEY (\`blocker_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_block_blocked_user_id\` FOREIGN KEY (\`blocked_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_social_block_status\` CHECK (\`status\` IN (1, 2)),
      CONSTRAINT \`ck_social_block_no_self\` CHECK (\`blocker_user_id\` <> \`blocked_user_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='单向用户屏蔽关系'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`social_report\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '举报状态，取值见 SocialReportStatus：OPEN=1/RESOLVED=2/DISMISSED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；举报审计保留，恒为 NULL',
      \`agent_domain_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '举报审核 scope；按目标内容归属，引用 agent_domain.id',
      \`report_key\` VARCHAR(160) NOT NULL COMMENT '举报创建幂等键',
      \`reporter_user_id\` BIGINT UNSIGNED NOT NULL COMMENT '举报人，引用 user.id',
      \`target_type\` SMALLINT UNSIGNED NOT NULL COMMENT '举报目标类型：POST=1/POST_REPLY=2/MESSAGE=3/USER=4',
      \`social_post_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '帖子目标；仅对应 POST，引用 social_post.id',
      \`social_post_reply_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '回复目标；仅对应 POST_REPLY，引用 social_post_reply.id',
      \`social_message_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '私聊消息目标；仅对应 MESSAGE，引用 social_message.id',
      \`reported_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '仅 target_type=USER 时的举报目标，引用 user.id；内容作者从目标实体读取',
      \`reason_code\` SMALLINT UNSIGNED NOT NULL COMMENT '已登记举报原因常量，取值由共享代码维护',
      \`details\` VARCHAR(1000) NULL DEFAULT NULL COMMENT '举报补充说明，不复制整段私聊/帖子作为证据',
      \`handled_by_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '处理举报的 Admin/获授权代理，引用 user.id',
      \`handled_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '处理时间，UTC',
      \`resolution_code\` SMALLINT UNSIGNED NULL DEFAULT NULL COMMENT '处理结果常量；未结案为空',
      \`resolution_note\` VARCHAR(1000) NULL DEFAULT NULL COMMENT '处理说明',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_social_report_report_key\` (\`report_key\`),
      KEY \`ix_social_report_domain_status\` (\`agent_domain_id\`, \`status\`, \`created_at\`, \`id\`),
      KEY \`ix_social_report_reporter_status\` (\`reporter_user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_social_report_post\` (\`social_post_id\`),
      KEY \`ix_social_report_reply\` (\`social_post_reply_id\`),
      KEY \`ix_social_report_message\` (\`social_message_id\`),
      KEY \`ix_social_report_reported_user\` (\`reported_user_id\`),
      KEY \`ix_social_report_handled_by\` (\`handled_by_user_id\`),
      CONSTRAINT \`fk_social_report_agent_domain_id\` FOREIGN KEY (\`agent_domain_id\`) REFERENCES \`agent_domain\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_report_reporter_user_id\` FOREIGN KEY (\`reporter_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_report_social_post_id\` FOREIGN KEY (\`social_post_id\`) REFERENCES \`social_post\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_report_social_post_reply_id\` FOREIGN KEY (\`social_post_reply_id\`) REFERENCES \`social_post_reply\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_report_social_message_id\` FOREIGN KEY (\`social_message_id\`) REFERENCES \`social_message\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_report_reported_user_id\` FOREIGN KEY (\`reported_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_social_report_handled_by_user_id\` FOREIGN KEY (\`handled_by_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_social_report_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_social_report_target_type\` CHECK (\`target_type\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_social_report_single_target\` CHECK (((\`social_post_id\` IS NOT NULL) + (\`social_post_reply_id\` IS NOT NULL) + (\`social_message_id\` IS NOT NULL) + (\`reported_user_id\` IS NOT NULL)) = 1),
      CONSTRAINT \`ck_social_report_target_matches_type\` CHECK (((\`target_type\` = 1) = (\`social_post_id\` IS NOT NULL)) AND ((\`target_type\` = 2) = (\`social_post_reply_id\` IS NOT NULL)) AND ((\`target_type\` = 3) = (\`social_message_id\` IS NOT NULL)) AND ((\`target_type\` = 4) = (\`reported_user_id\` IS NOT NULL)))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='社交内容/账号举报及其审核处理状态'
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS `social_report`');
  await context.query('DROP TABLE IF EXISTS `social_block`');
  await context.query('DROP TABLE IF EXISTS `social_content_interaction`');
  await context.query('DROP TABLE IF EXISTS `social_message`');
  await context.query('DROP TABLE IF EXISTS `social_conversation`');
  await context.query('DROP TABLE IF EXISTS `social_friendship`');
  await context.query('DROP TABLE IF EXISTS `social_post_reply`');
  await context.query('DROP TABLE IF EXISTS `social_post`');
  await context.query('DROP TABLE IF EXISTS `social_topic`');
}
