import type { Sequelize } from 'sequelize';

/**
 * 0016 — 金币集市：`coin_market_listing`、`coin_market_trade`。
 *
 * 字段与约束逐条对应 `docs/05_data/数据库设计SDD.md` §5.13。
 * 挂牌库存恒等式与各数量非负约束逐条落 DDL；`coin_market_trade` 有自身状态机
 * （CoinMarketTradeStatus），不是不可变表；其 `asset_operation_id` 是普通引用列。
 *
 * 只建列不建外键的引用：
 * - `payment_event.coin_market_trade_id`、`external_settlement.coin_market_trade_id`
 *   （0010 已建列）在本批次 up 末尾以 ALTER TABLE 补建 RESTRICT 外键；
 * - `coin_market_trade.support_conversation_id` 目标表 0015 已建，直接建 RESTRICT 外键；
 * - `payment_proof_asset_id` 等引用 `asset` 表（0017 才建）：只建列不建外键，外键待 0017 补建。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`coin_market_listing\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '挂牌状态，取值见 CoinMarketListingStatus：ACTIVE=1/PAUSED=2/COMPLETED=3/CANCELLED=4/SUSPENDED=5',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；挂牌不可软删，恒为 NULL',
      \`seller_user_id\` BIGINT UNSIGNED NOT NULL COMMENT '挂牌卖家，引用 user.id',
      \`listing_key\` VARCHAR(160) NOT NULL COMMENT '创建/重试幂等键',
      \`asset_hold_id\` BIGINT UNSIGNED NOT NULL COMMENT '本挂牌唯一金币占款，引用 asset_hold.id；hold_type=COIN_MARKET_LISTING=5',
      \`listed_coins\` BIGINT NOT NULL COMMENT '挂牌总量，必须大于 0',
      \`available_coins\` BIGINT NOT NULL COMMENT '当前可成交量',
      \`reserved_coins\` BIGINT NOT NULL DEFAULT 0 COMMENT '尚未完成的交易预占量',
      \`filled_coins\` BIGINT NOT NULL DEFAULT 0 COMMENT '已完成成交量',
      \`cancelled_coins\` BIGINT NOT NULL DEFAULT 0 COMMENT '挂牌关闭后释放的剩余量',
      \`price_cents_per_1000_coins\` BIGINT UNSIGNED NOT NULL COMMENT '每 1000 金币的挂牌价，单位为人民币分；正整数',
      \`receive_method\` SMALLINT UNSIGNED NOT NULL COMMENT '已登记收款方式常量；首版支持方式沿用支付渠道/USDT 目录',
      \`receive_snapshot\` JSON NULL DEFAULT NULL COMMENT '加密或脱敏的卖家收款方式快照；仅交易参与方按权限读取',
      \`platform_payment_opt_in\` TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0/1 仅为普通布尔值，不是状态或枚举；默认不允许平台通道，卖家是否主动开放该挂牌的平台支付路径',
      \`cancelled_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '撤销时间，UTC',
      \`suspended_by_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '暂停/冻结挂牌的 Admin 或有权运营者，引用 user.id',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_coin_market_listing_key\` (\`listing_key\`),
      UNIQUE KEY \`uq_coin_market_listing_hold\` (\`asset_hold_id\`),
      KEY \`ix_coin_market_listing_status_created\` (\`status\`, \`created_at\`, \`id\`),
      KEY \`ix_coin_market_listing_seller_status\` (\`seller_user_id\`, \`status\`, \`created_at\`, \`id\`),
      KEY \`ix_coin_market_listing_receive_method\` (\`receive_method\`, \`status\`, \`created_at\`, \`id\`),
      KEY \`ix_coin_market_listing_suspended_by\` (\`suspended_by_user_id\`),
      CONSTRAINT \`fk_coin_market_listing_seller_user_id\` FOREIGN KEY (\`seller_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_coin_market_listing_hold\` FOREIGN KEY (\`asset_hold_id\`) REFERENCES \`asset_hold\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_coin_market_listing_suspended_by_user_id\` FOREIGN KEY (\`suspended_by_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_coin_market_listing_status\` CHECK (\`status\` IN (1, 2, 3, 4, 5)),
      CONSTRAINT \`ck_coin_market_listing_stock_identity\` CHECK (\`listed_coins\` = \`available_coins\` + \`reserved_coins\` + \`filled_coins\` + \`cancelled_coins\`),
      CONSTRAINT \`ck_coin_market_listing_nonnegative\` CHECK (\`available_coins\` >= 0 AND \`reserved_coins\` >= 0 AND \`filled_coins\` >= 0 AND \`cancelled_coins\` >= 0 AND \`listed_coins\` > 0),
      CONSTRAINT \`ck_coin_market_listing_price\` CHECK (\`price_cents_per_1000_coins\` > 0),
      CONSTRAINT \`ck_coin_market_listing_opt_in\` CHECK (\`platform_payment_opt_in\` IN (0, 1)),
      CONSTRAINT \`ck_coin_market_listing_deleted_at\` CHECK (\`deleted_at\` IS NULL)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='卖家发布的一张金币挂牌及可被多个买家部分成交的库存状态'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`coin_market_trade\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '成交状态，取值见 CoinMarketTradeStatus：PAYMENT_PENDING=1/SELLER_CONFIRMATION_PENDING=2/DISPUTED=3/BUYER_EVIDENCE_PENDING=4/SELLER_EVIDENCE_PENDING=5/PLATFORM_REVIEW=6/RELEASED=7/AUTO_RELEASED=8/PAYMENT_EXPIRED=9/RESOLVED_RETURN=10/CANCELLED=11',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；成交事实不软删，恒为 NULL',
      \`coin_market_listing_id\` BIGINT UNSIGNED NOT NULL COMMENT '来源挂牌，引用 coin_market_listing.id',
      \`buyer_user_id\` BIGINT UNSIGNED NOT NULL COMMENT '本笔买家，引用 user.id',
      \`trade_key\` VARCHAR(160) NOT NULL COMMENT '接受挂牌幂等键',
      \`coins\` BIGINT NOT NULL COMMENT '本笔预占金币数量，必须大于 0',
      \`gross_cents\` BIGINT NOT NULL COMMENT '本笔买家应付人民币分，按挂牌报价 ceil(price × coins ÷ 1000)',
      \`payment_mode\` SMALLINT UNSIGNED NOT NULL COMMENT '付款方式：DIRECT=1/PLATFORM_CHANNEL=2/USDT=3',
      \`payment_channel_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '平台通道成交所选支付方式，引用 payment_channel.id',
      \`fee_rate_bps\` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '本笔平台通道费率快照；默认配置 2000 bps，非平台通道为 0',
      \`fee_cents\` BIGINT NOT NULL DEFAULT 0 COMMENT '从卖家应收中扣除的费用，按统一货币舍入规则',
      \`seller_net_cents\` BIGINT NOT NULL DEFAULT 0 COMMENT '平台通道成交卖家净收金额；直接场外付款为 0（不经平台钱包）',
      \`payment_proof_asset_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '买家付款凭证；私有加密 asset，引用 asset 表；外键待 0017 补建',
      \`chain_tx_id\` VARCHAR(160) NULL DEFAULT NULL COMMENT 'USDT 链上交易标识，唯一性由 TRON payment handler 校验',
      \`usdt_rate_snapshot\` DECIMAL(20,8) NULL DEFAULT NULL COMMENT '该笔交易锁定的每日 CNY/USDT 汇率',
      \`payment_deadline_at\` DATETIME(3) NOT NULL COMMENT '接受挂牌后 48h 截止，UTC',
      \`seller_response_deadline_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '凭证提交后 48h 截止；USDT 核验路径可空，UTC',
      \`buyer_evidence_deadline_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '卖家申诉后买家补证截止（48h），UTC',
      \`buyer_evidence_asset_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '买家针对申诉提交的补充银行付款凭证；外键待 0017 补建',
      \`buyer_evidence_submitted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '买家补充证据提交时间；开始卖家回应举证窗口，UTC',
      \`seller_evidence_deadline_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '买家补证后卖家回应证据截止（48h），UTC',
      \`seller_evidence_asset_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '卖家针对买家补证提交的回应凭证；外键待 0017 补建',
      \`seller_evidence_submitted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '卖家回应证据提交时间，UTC',
      \`platform_decision_deadline_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '卖家提交回应或回应期届满后，平台默认 48h 裁定截止；手动延期时更新并审计，UTC',
      \`seller_dispute_note\` VARCHAR(1000) NULL DEFAULT NULL COMMENT '卖家申诉说明；不得填写完整支付账号或敏感凭证',
      \`paid_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '买家付款凭证/链上交易提交时间，UTC',
      \`support_conversation_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '关联本笔争议客服会话，引用 support_conversation.id；会话内容仍由客服领域管理',
      \`adjudicated_by_user_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '普通工作人员裁决人员，引用 user.id',
      \`resolution_code\` SMALLINT UNSIGNED NULL DEFAULT NULL COMMENT '裁定结果：RELEASE_TO_BUYER=1/RETURN_TO_SELLER=2；未裁决为空',
      \`resolution_note\` VARCHAR(1000) NULL DEFAULT NULL COMMENT '裁决理由，禁止写入支付凭证明文',
      \`adjudicated_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '普通工作人员作出裁定的时间，UTC',
      \`asset_operation_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '成交放币/返还对应的钱包操作，引用 asset_operation.id；仅由 wallet 用例写入',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_coin_market_trade_key\` (\`trade_key\`),
      UNIQUE KEY \`uq_coin_market_trade_chain_tx\` (\`chain_tx_id\`),
      UNIQUE KEY \`uq_coin_market_trade_operation\` (\`asset_operation_id\`),
      KEY \`ix_coin_market_trade_listing_status\` (\`coin_market_listing_id\`, \`status\`, \`created_at\`, \`id\`),
      KEY \`ix_coin_market_trade_buyer_status\` (\`buyer_user_id\`, \`status\`, \`created_at\`, \`id\`),
      KEY \`ix_coin_market_trade_status_payment_deadline\` (\`status\`, \`payment_deadline_at\`, \`id\`),
      KEY \`ix_coin_market_trade_status_seller_response\` (\`status\`, \`seller_response_deadline_at\`, \`id\`),
      KEY \`ix_coin_market_trade_status_buyer_evidence\` (\`status\`, \`buyer_evidence_deadline_at\`, \`id\`),
      KEY \`ix_coin_market_trade_status_seller_evidence\` (\`status\`, \`seller_evidence_deadline_at\`, \`id\`),
      KEY \`ix_coin_market_trade_status_platform_decision\` (\`status\`, \`platform_decision_deadline_at\`, \`id\`),
      KEY \`ix_coin_market_trade_payment_channel\` (\`payment_channel_id\`),
      KEY \`ix_coin_market_trade_payment_proof\` (\`payment_proof_asset_id\`),
      KEY \`ix_coin_market_trade_buyer_evidence\` (\`buyer_evidence_asset_id\`),
      KEY \`ix_coin_market_trade_seller_evidence\` (\`seller_evidence_asset_id\`),
      KEY \`ix_coin_market_trade_support_conversation\` (\`support_conversation_id\`),
      KEY \`ix_coin_market_trade_adjudicated_by\` (\`adjudicated_by_user_id\`),
      CONSTRAINT \`fk_coin_market_trade_listing\` FOREIGN KEY (\`coin_market_listing_id\`) REFERENCES \`coin_market_listing\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_coin_market_trade_buyer_user_id\` FOREIGN KEY (\`buyer_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_coin_market_trade_payment_channel_id\` FOREIGN KEY (\`payment_channel_id\`) REFERENCES \`payment_channel\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_coin_market_trade_support_conversation\` FOREIGN KEY (\`support_conversation_id\`) REFERENCES \`support_conversation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_coin_market_trade_adjudicated_by_user_id\` FOREIGN KEY (\`adjudicated_by_user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_coin_market_trade_operation\` FOREIGN KEY (\`asset_operation_id\`) REFERENCES \`asset_operation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_coin_market_trade_status\` CHECK (\`status\` IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)),
      CONSTRAINT \`ck_coin_market_trade_payment_mode\` CHECK (\`payment_mode\` IN (1, 2, 3)),
      CONSTRAINT \`ck_coin_market_trade_coins\` CHECK (\`coins\` > 0 AND \`gross_cents\` >= 0),
      CONSTRAINT \`ck_coin_market_trade_fees\` CHECK (\`fee_rate_bps\` >= 0 AND \`fee_cents\` >= 0 AND \`seller_net_cents\` >= 0),
      CONSTRAINT \`ck_coin_market_trade_net_identity\` CHECK ((\`payment_mode\` = 2) = (\`seller_net_cents\` = GREATEST(\`gross_cents\` - \`fee_cents\`, 0))),
      CONSTRAINT \`ck_coin_market_trade_resolution\` CHECK (\`resolution_code\` IS NULL OR \`resolution_code\` IN (1, 2)),
      CONSTRAINT \`ck_coin_market_trade_deleted_at\` CHECK (\`deleted_at\` IS NULL)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='买家对一张金币挂牌的一笔独立部分成交及其付款、争议和结算过程'
  `);

  // 0010 中已建列待本批次补建的外键：payment_event / external_settlement 引用 coin_market_trade。
  await context.query(`
    ALTER TABLE \`payment_event\`
      ADD CONSTRAINT \`fk_payment_event_coin_market_trade\` FOREIGN KEY (\`coin_market_trade_id\`) REFERENCES \`coin_market_trade\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
  await context.query(`
    ALTER TABLE \`external_settlement\`
      ADD CONSTRAINT \`fk_external_settlement_coin_market_trade\` FOREIGN KEY (\`coin_market_trade_id\`) REFERENCES \`coin_market_trade\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);

  // 0009 中"只建列不建外键"的 admin_audit_event 引用列，补建 RESTRICT 外键：
  // referral_binding_event（0012 已建）、coin_market_trade（本批次已建）、
  // support_conversation（0015 已建）。
  await context.query(`
    ALTER TABLE \`admin_audit_event\`
      ADD CONSTRAINT \`fk_admin_audit_event_referral_binding_event_id\` FOREIGN KEY (\`referral_binding_event_id\`) REFERENCES \`referral_binding_event\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
  await context.query(`
    ALTER TABLE \`admin_audit_event\`
      ADD CONSTRAINT \`fk_admin_audit_event_coin_market_trade_id\` FOREIGN KEY (\`coin_market_trade_id\`) REFERENCES \`coin_market_trade\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
  await context.query(`
    ALTER TABLE \`admin_audit_event\`
      ADD CONSTRAINT \`fk_admin_audit_event_support_conversation_id\` FOREIGN KEY (\`support_conversation_id\`) REFERENCES \`support_conversation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  // 先移除本批次补建的外键，再按 up 的相反顺序删表。
  await context.query('ALTER TABLE `admin_audit_event` DROP CONSTRAINT `fk_admin_audit_event_support_conversation_id`');
  await context.query('ALTER TABLE `admin_audit_event` DROP CONSTRAINT `fk_admin_audit_event_coin_market_trade_id`');
  await context.query('ALTER TABLE `admin_audit_event` DROP CONSTRAINT `fk_admin_audit_event_referral_binding_event_id`');
  await context.query('ALTER TABLE `external_settlement` DROP CONSTRAINT `fk_external_settlement_coin_market_trade`');
  await context.query('ALTER TABLE `payment_event` DROP CONSTRAINT `fk_payment_event_coin_market_trade`');
  await context.query('DROP TABLE IF EXISTS `coin_market_trade`');
  await context.query('DROP TABLE IF EXISTS `coin_market_listing`');
}
