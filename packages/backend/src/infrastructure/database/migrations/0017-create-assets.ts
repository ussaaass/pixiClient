import type { Sequelize } from 'sequelize';

/**
 * 0017 — AI 素材台账与统一资产：`asset`、`asset_release`、`asset_release_item`、
 * `ai_asset_job`、`ai_asset_artifact`、`ai_asset_reference`。
 *
 * 字段与约束逐条对应 `docs/05_data/数据库设计SDD.md` §5.10 与 §5.11。
 * 批次内顺序即依赖：`asset` 被其余各表引用，故在最前。
 *
 * 不可变：`ai_asset_reference` 为参考产物登记流水，`status` 固定 RECORDED=1、
 * `updated_at` 固定等于 `created_at`、`deleted_at` 恒为 NULL。
 *
 * 本批次 up 末尾统一补建前序批次"只建列不建外键"的 asset 引用列外键（RESTRICT）：
 * - 0002 `user.asset_id`；0008 `game.asset_id`；
 * - 0014 `social_topic.cover_asset_id`、`social_message.asset_id`；
 * - 0015 `support_message.asset_id`；
 * - 0016 `coin_market_trade.payment_proof_asset_id / buyer_evidence_asset_id / seller_evidence_asset_id`。
 * down 按相反顺序 DROP CONSTRAINT，再删表。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`asset\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '资产状态，取值见 AssetStatus：STORED=1/READY=2/QUARANTINED=3/RETIRED=4',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`asset_type\` SMALLINT UNSIGNED NOT NULL COMMENT '资产类型：IMAGE=1/ANIMATED_IMAGE=2/VIDEO=3/ATLAS=4/MANIFEST=5/BINARY=6',
      \`storage_provider\` SMALLINT UNSIGNED NOT NULL COMMENT '存储提供方：S3_COMPATIBLE=1/LOCAL_DEV=2',
      \`bucket_name\` VARCHAR(128) NOT NULL COMMENT '对象存储桶或环境内资源区',
      \`object_key\` VARCHAR(512) NOT NULL COMMENT '唯一对象定位键；只在 asset 存储',
      \`content_hash\` BINARY(32) NOT NULL COMMENT '内容 SHA-256，发布完整性校验',
      \`mime_type\` VARCHAR(128) NOT NULL COMMENT '明文可见资产的服务端检测 MIME；客户端加密资产仅记录客户端声明，不作为可信检测结果',
      \`byte_size\` BIGINT UNSIGNED NOT NULL COMMENT '文件大小字节',
      \`width\` INT UNSIGNED NULL DEFAULT NULL COMMENT '位图宽度',
      \`height\` INT UNSIGNED NULL DEFAULT NULL COMMENT '位图高度',
      \`duration_ms\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '音视频时长毫秒',
      \`codec\` VARCHAR(64) NULL DEFAULT NULL COMMENT 'WebP/AVIF/H.265 等编码',
      \`visibility\` SMALLINT UNSIGNED NOT NULL COMMENT '可见性：PRIVATE=1/PUBLIC=2',
      \`storage_metadata\` JSON NULL DEFAULT NULL COMMENT '非敏感对象存储元数据，不放凭证',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_asset_locator\` (\`storage_provider\`, \`bucket_name\`, \`object_key\`),
      UNIQUE KEY \`uq_asset_content\` (\`content_hash\`, \`byte_size\`),
      KEY \`ix_asset_type_status\` (\`asset_type\`, \`status\`, \`created_at\`, \`id\`),
      CONSTRAINT \`ck_asset_status\` CHECK (\`status\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_asset_type\` CHECK (\`asset_type\` IN (1, 2, 3, 4, 5, 6)),
      CONSTRAINT \`ck_asset_storage_provider\` CHECK (\`storage_provider\` IN (1, 2)),
      CONSTRAINT \`ck_asset_visibility\` CHECK (\`visibility\` IN (1, 2))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='统一文件资产元数据和对象存储定位'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`asset_release\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '发布状态，取值见 ReleaseStatus：DRAFT=1/REVIEW=2/PUBLISHED=3/RETIRED=4',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`game_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '子游戏发布，引用 game.id；NULL 表示大厅公共资源',
      \`release_key\` VARCHAR(128) NOT NULL COMMENT '发布版本业务编号',
      \`asset_id\` BIGINT UNSIGNED NOT NULL COMMENT '发布清单文件，引用 asset.id',
      \`manifest_hash\` BINARY(32) NOT NULL COMMENT '资源清单哈希',
      \`published_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '上线时间，UTC',
      \`review_note\` VARCHAR(1000) NOT NULL COMMENT '发布审核说明',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_asset_release_key\` (\`release_key\`),
      KEY \`ix_asset_release_asset\` (\`asset_id\`),
      KEY \`ix_asset_release_game_status\` (\`game_id\`, \`status\`, \`published_at\`, \`id\`),
      CONSTRAINT \`fk_asset_release_game_id\` FOREIGN KEY (\`game_id\`) REFERENCES \`game\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_asset_release_asset_id\` FOREIGN KEY (\`asset_id\`) REFERENCES \`asset\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_asset_release_status\` CHECK (\`status\` IN (1, 2, 3, 4))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='大厅和子游戏资源发布版本'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`asset_release_item\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '清单项状态，固定为 RecordStatus.RECORDED=1，发布清单项不可改写',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；清单项保留历史，恒为 NULL',
      \`asset_release_id\` BIGINT UNSIGNED NOT NULL COMMENT '发布版本，引用 asset_release.id',
      \`asset_id\` BIGINT UNSIGNED NOT NULL COMMENT '实际发布文件，引用 asset.id；只发布 READY 且审核通过的 asset',
      \`resource_key\` VARCHAR(128) NOT NULL COMMENT '前端资源语义键',
      \`load_phase\` SMALLINT UNSIGNED NOT NULL COMMENT '加载阶段：SHELL=1/ENTRY=2/BACKGROUND=3/OPTIONAL=4',
      \`priority\` INT NOT NULL DEFAULT 0 COMMENT '网络调度优先级；普通数值，允许 0',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_asset_release_item_resource_key\` (\`asset_release_id\`, \`resource_key\`),
      UNIQUE KEY \`uq_asset_release_item_asset\` (\`asset_release_id\`, \`asset_id\`),
      KEY \`ix_asset_release_item_asset\` (\`asset_id\`),
      CONSTRAINT \`fk_asset_release_item_release\` FOREIGN KEY (\`asset_release_id\`) REFERENCES \`asset_release\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_asset_release_item_asset\` FOREIGN KEY (\`asset_id\`) REFERENCES \`asset\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_asset_release_item_load_phase\` CHECK (\`load_phase\` IN (1, 2, 3, 4))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='资源发布包含的已审核产物'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`ai_asset_job\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '任务状态，取值见 AiJobStatus：QUEUED=1/RUNNING=2/SUCCEEDED=3/FAILED=4/CANCELLED=5/REVIEW_REQUIRED=6',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`job_key\` CHAR(36) NOT NULL COMMENT '素材任务定位值',
      \`asset_key\` VARCHAR(128) NOT NULL COMMENT '目标素材语义键',
      \`asset_kind\` SMALLINT UNSIGNED NOT NULL COMMENT '素材类型：BACKGROUND=1/CHARACTER=2/CARD=3/ICON=4/EFFECT=5',
      \`provider_code\` VARCHAR(32) NOT NULL DEFAULT 'OPENAI' COMMENT '服务商代码',
      \`main_model_code\` VARCHAR(128) NOT NULL COMMENT '实际有权限的 GPT-6 系列 API 主模型代码，不是本库 FK',
      \`image_model_code\` VARCHAR(128) NOT NULL COMMENT '独立图像生成模型代码，不是本库 FK',
      \`api_mode\` SMALLINT UNSIGNED NOT NULL COMMENT 'API 模式：RESPONSES_IMAGE_TOOL=1/IMAGES=2',
      \`prompt\` MEDIUMTEXT NOT NULL COMMENT '可审计生成指令',
      \`prompt_hash\` BINARY(32) NOT NULL COMMENT '指令内容摘要',
      \`style_version\` VARCHAR(64) NOT NULL COMMENT '卡通风格规范版本',
      \`generation_config\` JSON NOT NULL COMMENT '尺寸透明背景参考图策略等非秘密参数',
      \`provider_request_key\` VARCHAR(160) NULL DEFAULT NULL COMMENT 'API 请求或响应定位值',
      \`usage_snapshot\` JSON NULL DEFAULT NULL COMMENT 'Token 图像用量及实际计费依据',
      \`cost_micro_usd\` BIGINT NULL DEFAULT NULL COMMENT '实际或明确标识的估算费用，百万分之一美元',
      \`attempts\` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '受预算控制的重试次数；普通计数，允许 0',
      \`completed_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '生成结束时间，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_ai_asset_job_key\` (\`job_key\`),
      KEY \`ix_ai_asset_job_asset_status\` (\`asset_key\`, \`created_at\`, \`id\`),
      KEY \`ix_ai_asset_job_status_created\` (\`status\`, \`created_at\`, \`id\`),
      CONSTRAINT \`ck_ai_asset_job_status\` CHECK (\`status\` IN (1, 2, 3, 4, 5, 6)),
      CONSTRAINT \`ck_ai_asset_job_kind\` CHECK (\`asset_kind\` IN (1, 2, 3, 4, 5)),
      CONSTRAINT \`ck_ai_asset_job_api_mode\` CHECK (\`api_mode\` IN (1, 2))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='通过 OpenAI API 执行的素材任务'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`ai_asset_artifact\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '产物状态，取值见 ArtifactStatus：GENERATED=1/APPROVED=2/REJECTED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`ai_asset_job_id\` BIGINT UNSIGNED NOT NULL COMMENT '生成任务，引用 ai_asset_job.id',
      \`asset_id\` BIGINT UNSIGNED NOT NULL COMMENT '生成文件，引用 asset.id；对象键、hash、MIME、字节数和宽高只保存在 asset',
      \`artifact_type\` SMALLINT UNSIGNED NOT NULL COMMENT '产物类型：ORIGINAL=1/WEBP=2/AVIF=3/ATLAS=4/METADATA=5',
      \`license_snapshot\` JSON NOT NULL COMMENT '生成条款及引用素材来源',
      \`review_note\` VARCHAR(1000) NULL DEFAULT NULL COMMENT '质量审核与缺陷说明',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_ai_asset_artifact_asset_id\` (\`asset_id\`),
      KEY \`ix_ai_asset_artifact_job_type\` (\`ai_asset_job_id\`, \`artifact_type\`, \`id\`),
      CONSTRAINT \`fk_ai_asset_artifact_job\` FOREIGN KEY (\`ai_asset_job_id\`) REFERENCES \`ai_asset_job\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_ai_asset_artifact_asset\` FOREIGN KEY (\`asset_id\`) REFERENCES \`asset\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_ai_asset_artifact_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_ai_asset_artifact_type\` CHECK (\`artifact_type\` IN (1, 2, 3, 4, 5))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='生成原图及前端衍生资源版本'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`ai_asset_reference\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '参考登记状态，固定为 RecordStatus.RECORDED=1，参考登记不可改写',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间；不可变记录固定等于 created_at',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；参考登记禁止删除，恒为 NULL',
      \`ai_asset_job_id\` BIGINT UNSIGNED NOT NULL COMMENT '使用参考图的目标任务，引用 ai_asset_job.id',
      \`asset_id\` BIGINT UNSIGNED NOT NULL COMMENT '输入参考文件，引用 asset.id',
      \`reference_role\` SMALLINT UNSIGNED NOT NULL COMMENT '参考用途：STYLE=1/CHARACTER=2/EDIT_TARGET=3',
      \`sort_order\` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '参考顺序；普通计数，允许 0',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_ai_asset_reference_role\` (\`ai_asset_job_id\`, \`asset_id\`, \`reference_role\`),
      KEY \`ix_ai_asset_reference_asset\` (\`asset_id\`),
      CONSTRAINT \`fk_ai_asset_reference_job\` FOREIGN KEY (\`ai_asset_job_id\`) REFERENCES \`ai_asset_job\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_ai_asset_reference_asset\` FOREIGN KEY (\`asset_id\`) REFERENCES \`asset\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_ai_asset_reference_status\` CHECK (\`status\` = 1),
      CONSTRAINT \`ck_ai_asset_reference_deleted_at\` CHECK (\`deleted_at\` IS NULL),
      CONSTRAINT \`ck_ai_asset_reference_role\` CHECK (\`reference_role\` IN (1, 2, 3))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='素材生成任务的输入参考产物'
  `);

  // 前序批次"只建列不建外键"的 asset 引用列，在本批次建完 asset 表后统一补建 RESTRICT 外键。
  await context.query(`
    ALTER TABLE \`user\`
      ADD CONSTRAINT \`fk_user_asset_id\` FOREIGN KEY (\`asset_id\`) REFERENCES \`asset\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
  await context.query(`
    ALTER TABLE \`game\`
      ADD CONSTRAINT \`fk_game_asset_id\` FOREIGN KEY (\`asset_id\`) REFERENCES \`asset\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
  await context.query(`
    ALTER TABLE \`social_topic\`
      ADD CONSTRAINT \`fk_social_topic_cover_asset_id\` FOREIGN KEY (\`cover_asset_id\`) REFERENCES \`asset\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
  await context.query(`
    ALTER TABLE \`social_message\`
      ADD CONSTRAINT \`fk_social_message_asset_id\` FOREIGN KEY (\`asset_id\`) REFERENCES \`asset\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
  await context.query(`
    ALTER TABLE \`support_message\`
      ADD CONSTRAINT \`fk_support_message_asset_id\` FOREIGN KEY (\`asset_id\`) REFERENCES \`asset\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
  await context.query(`
    ALTER TABLE \`coin_market_trade\`
      ADD CONSTRAINT \`fk_coin_market_trade_payment_proof_asset_id\` FOREIGN KEY (\`payment_proof_asset_id\`) REFERENCES \`asset\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
  await context.query(`
    ALTER TABLE \`coin_market_trade\`
      ADD CONSTRAINT \`fk_coin_market_trade_buyer_evidence_asset_id\` FOREIGN KEY (\`buyer_evidence_asset_id\`) REFERENCES \`asset\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
  await context.query(`
    ALTER TABLE \`coin_market_trade\`
      ADD CONSTRAINT \`fk_coin_market_trade_seller_evidence_asset_id\` FOREIGN KEY (\`seller_evidence_asset_id\`) REFERENCES \`asset\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  // 先移除本批次补建的外键，再按 up 的相反顺序删表。
  await context.query('ALTER TABLE `coin_market_trade` DROP CONSTRAINT `fk_coin_market_trade_seller_evidence_asset_id`');
  await context.query('ALTER TABLE `coin_market_trade` DROP CONSTRAINT `fk_coin_market_trade_buyer_evidence_asset_id`');
  await context.query('ALTER TABLE `coin_market_trade` DROP CONSTRAINT `fk_coin_market_trade_payment_proof_asset_id`');
  await context.query('ALTER TABLE `support_message` DROP CONSTRAINT `fk_support_message_asset_id`');
  await context.query('ALTER TABLE `social_message` DROP CONSTRAINT `fk_social_message_asset_id`');
  await context.query('ALTER TABLE `social_topic` DROP CONSTRAINT `fk_social_topic_cover_asset_id`');
  await context.query('ALTER TABLE `game` DROP CONSTRAINT `fk_game_asset_id`');
  await context.query('ALTER TABLE `user` DROP CONSTRAINT `fk_user_asset_id`');
  await context.query('DROP TABLE IF EXISTS `ai_asset_reference`');
  await context.query('DROP TABLE IF EXISTS `ai_asset_artifact`');
  await context.query('DROP TABLE IF EXISTS `ai_asset_job`');
  await context.query('DROP TABLE IF EXISTS `asset_release_item`');
  await context.query('DROP TABLE IF EXISTS `asset_release`');
  await context.query('DROP TABLE IF EXISTS `asset`');
}
