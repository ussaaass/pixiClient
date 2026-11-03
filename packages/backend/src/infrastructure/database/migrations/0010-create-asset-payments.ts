import type { Sequelize } from 'sequelize';

/**
 * 0010 — 资产与支付：`coin_exchange`、`gift_grant`、`turnover_state`、
 * `payment_provider`、`payment_channel`、`product`、`order`、`payment_event`、
 * `external_settlement`、`payout_account`、`withdrawal`、`payout_attempt`。
 *
 * 字段与约束逐条对应 `docs/05_data/数据库设计SDD.md` §5.3 与 §5.4。
 * 批次内顺序即依赖（被引用表在前）。
 *
 * 不可变：`coin_exchange`、`gift_grant`、`payment_event` 为账务/支付事实，
 * `status` 固定 RECORDED=1、`updated_at` 固定等于 `created_at`、`deleted_at` 恒为 NULL。
 *
 * 只建列不建外键的引用（目标表在后批次建立）：
 * - `gift_grant.order_id`、`payment_event.order_id / coin_market_trade_id`、
 *   `external_settlement.order_id / coin_market_trade_id` 中指向 `order` / `coin_market_trade`
 *   的：`order` 在本批次内建完，补上外键；`coin_market_trade` 0016 才建，只建列并注释；
 * - `withdrawal` 对 `payout_attempt` 无反向引用；`payout_attempt.payment_channel_id`
 *   在本批次内建外键。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`coin_exchange\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '兑换记录状态，固定为 RecordStatus.RECORDED=1，已入账不可改写',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间；不可变记录固定等于 created_at',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；账务事实禁止删除，恒为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '兑换用户，引用 user.id',
      \`asset_operation_id\` BIGINT UNSIGNED NOT NULL COMMENT '兑换操作，引用 asset_operation.id',
      \`coins\` BIGINT NOT NULL COMMENT '用户扣除金币，有符号整数',
      \`cash_cents\` BIGINT NOT NULL COMMENT '用户增加人民币分，有符号整数',
      \`fee_cents\` BIGINT NOT NULL DEFAULT 0 COMMENT '独立兑换费用，默认无新增费用',
      \`rate_coin_units\` BIGINT NOT NULL COMMENT '比例金币整数分子，默认 10',
      \`rate_cash_cents\` BIGINT NOT NULL COMMENT '比例人民币分分母，默认 100',
      \`rounding_type\` SMALLINT UNSIGNED NOT NULL DEFAULT 2 COMMENT '舍入模式，取值见 RoundingMode：CEIL_CHARGE=1/FLOOR_CREDIT=2；兑入人民币余额不足 1 分向下取整到分',
      \`preview_key\` CHAR(36) NOT NULL COMMENT '用户确认的报价定位值',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_coin_exchange_operation\` (\`asset_operation_id\`),
      UNIQUE KEY \`uq_coin_exchange_preview_key\` (\`preview_key\`),
      KEY \`ix_coin_exchange_user_status\` (\`user_id\`, \`created_at\`, \`id\`),
      CONSTRAINT \`fk_coin_exchange_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_coin_exchange_operation\` FOREIGN KEY (\`asset_operation_id\`) REFERENCES \`asset_operation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_coin_exchange_status\` CHECK (\`status\` = 1),
      CONSTRAINT \`ck_coin_exchange_deleted_at\` CHECK (\`deleted_at\` IS NULL),
      CONSTRAINT \`ck_coin_exchange_rounding\` CHECK (\`rounding_type\` IN (1, 2))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='金币兑人民币余额'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`gift_grant\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '赠币记录状态，固定为 RecordStatus.RECORDED=1，已入账不可改写',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间；不可变记录固定等于 created_at',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；账务事实禁止删除，恒为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '领取用户，引用 user.id',
      \`asset_operation_id\` BIGINT UNSIGNED NOT NULL COMMENT '赠币操作，引用 asset_operation.id',
      \`order_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '商品附赠金币的来源订单，引用 order 表；外键随批次内建',
      \`grant_key\` VARCHAR(160) NOT NULL COMMENT '注册或活动发奖语义键',
      \`coins\` BIGINT NOT NULL COMMENT '实际赠送金币',
      \`turnover_multiplier\` DECIMAL(12,4) NOT NULL DEFAULT 5 COMMENT '流水倍数快照；默认 5 倍，场景配置在发放时固化',
      \`required_turnover_coins\` BIGINT NOT NULL COMMENT '实际增加的整数流水要求',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_gift_grant_operation\` (\`asset_operation_id\`),
      UNIQUE KEY \`uq_gift_grant_grant_key\` (\`grant_key\`),
      KEY \`ix_gift_grant_user_status\` (\`user_id\`, \`created_at\`, \`id\`),
      CONSTRAINT \`fk_gift_grant_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_gift_grant_operation\` FOREIGN KEY (\`asset_operation_id\`) REFERENCES \`asset_operation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_gift_grant_status\` CHECK (\`status\` = 1),
      CONSTRAINT \`ck_gift_grant_deleted_at\` CHECK (\`deleted_at\` IS NULL)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='赠币及配置快照'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`turnover_state\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '流水资格状态，取值见 TurnoverStatus：ACTIVE=1/COMPLETE=2/REVERSED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '用户，引用 user.id；每人至多一行',
      \`remaining_coins\` BIGINT NOT NULL DEFAULT 0 COMMENT '用户所有赠币要求合计后仍须完成的有效下注额；只扣到 0，超出部分不结转',
      \`version\` BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '每次流水要求变更递增的版本号',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_turnover_state_user_id\` (\`user_id\`),
      CONSTRAINT \`fk_turnover_state_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_turnover_state_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_turnover_state_remaining\` CHECK (\`remaining_coins\` >= 0),
      CONSTRAINT \`ck_turnover_state_version\` CHECK (\`version\` >= 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='每用户金币提现/转出资格的累计流水汇总'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`payment_provider\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '提供商状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`provider_code\` VARCHAR(64) NOT NULL COMMENT '稳定提供商代码',
      \`provider_type\` SMALLINT UNSIGNED NOT NULL COMMENT '提供商类型，取值见 PaymentProviderType：AGGREGATOR=1/SELF_TRON=2/MOCK=3',
      \`name\` VARCHAR(100) NOT NULL COMMENT '提供商名称',
      \`adapter_key\` VARCHAR(64) NOT NULL COMMENT '服务器适配器注册表键',
      \`secret_reference\` VARCHAR(255) NULL DEFAULT NULL COMMENT '非 Mock provider 的密钥管理器引用，非密钥值；MOCK 无需配置',
      \`capability_snapshot\` JSON NOT NULL COMMENT '下单查询对账及出款能力声明',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_payment_provider_code\` (\`provider_code\`),
      CONSTRAINT \`ck_payment_provider_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_payment_provider_type\` CHECK (\`provider_type\` IN (1, 2, 3)),
      CONSTRAINT \`ck_payment_provider_secret\` CHECK ((\`provider_type\` = 3 AND \`secret_reference\` IS NULL) OR (\`provider_type\` IN (1, 2) AND \`secret_reference\` IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='代理商和自建支付适配器'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`payment_channel\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '渠道状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`payment_provider_id\` BIGINT UNSIGNED NOT NULL COMMENT '所属提供商，引用 payment_provider.id',
      \`channel_code\` VARCHAR(64) NOT NULL COMMENT '渠道唯一代码',
      \`method_type\` SMALLINT UNSIGNED NOT NULL COMMENT '支付方式：ALIPAY=1/WECHAT=2/BANK=3/UNIONPAY_QR=4/ECNY=5/USDT_TRON=6',
      \`channel_config\` JSON NOT NULL COMMENT '非秘密商户路由及计费配置',
      \`fee_config\` JSON NOT NULL COMMENT '手续费算法、费率和舍入规则',
      \`priority\` INT NOT NULL DEFAULT 0 COMMENT '玩家支付方式列表展示顺序；按 priority、id 稳定排序',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_payment_channel_provider_code\` (\`payment_provider_id\`, \`channel_code\`),
      KEY \`ix_payment_channel_method_status\` (\`method_type\`, \`status\`, \`priority\`, \`id\`),
      CONSTRAINT \`fk_payment_channel_provider\` FOREIGN KEY (\`payment_provider_id\`) REFERENCES \`payment_provider\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_payment_channel_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_payment_channel_method\` CHECK (\`method_type\` IN (1, 2, 3, 4, 5, 6))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='支付方法与提供商路由'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`product\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '商品状态，取值见 ProductStatus：DRAFT=1/ON_SALE=2/OFF_SALE=3/RETIRED=4',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`product_code\` VARCHAR(64) NOT NULL COMMENT '稳定商品代码',
      \`product_type\` SMALLINT UNSIGNED NOT NULL COMMENT '商品类型：COIN_TOP_UP=1；其他商品类型由商城领域常量扩展',
      \`version\` BIGINT UNSIGNED NOT NULL COMMENT '商品版本；在售版本不改价或履约内容，修改新建版本',
      \`name\` VARCHAR(100) NOT NULL COMMENT '显示名称',
      \`price_amount\` DECIMAL(36,12) NOT NULL COMMENT '商品价格数量',
      \`price_currency\` VARCHAR(16) NOT NULL COMMENT '标价币种，如 CNY',
      \`fulfillment_spec\` JSON NOT NULL COMMENT '商品履约定义；金币商品含购买金币、赠币及流水要求',
      \`active_marker\` TINYINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN (\`status\` = 2) AND (\`deleted_at\` IS NULL) THEN 1 ELSE NULL END) STORED NULL COMMENT '在售未删除取 1，否则 NULL；以唯一索引限制每商品至多一个在售版本',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_product_code_version\` (\`product_code\`, \`version\`),
      UNIQUE KEY \`uq_product_active\` (\`product_code\`, \`active_marker\`),
      CONSTRAINT \`ck_product_status\` CHECK (\`status\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_product_type\` CHECK (\`product_type\` IN (1)),
      CONSTRAINT \`ck_product_version\` CHECK (\`version\` >= 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='商城可售商品目录及版本'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`order\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '订单状态，取值见 OrderStatus：CREATED=1/PAYING=2/PAID=3/FULFILLED=4/EXPIRED=5/EXCEPTION=6/CANCELLED=7',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；订单不可软删，恒为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '购买用户，引用 user.id',
      \`product_id\` BIGINT UNSIGNED NOT NULL COMMENT '下单时商品版本，引用 product.id',
      \`payment_channel_id\` BIGINT UNSIGNED NOT NULL COMMENT '固定支付路由，引用 payment_channel.id；创建后不可切换',
      \`order_key\` CHAR(36) NOT NULL COMMENT '内部订单号及下单幂等定位值',
      \`provider_order_key\` VARCHAR(160) NULL DEFAULT NULL COMMENT '外部渠道订单号',
      \`payment_currency\` VARCHAR(16) NOT NULL COMMENT '实际支付币种',
      \`requested_amount\` DECIMAL(36,12) NOT NULL COMMENT '请求原币支付金额',
      \`actual_amount\` DECIMAL(36,12) NULL DEFAULT NULL COMMENT '确认实付原币金额',
      \`actual_cny_cents\` BIGINT NULL DEFAULT NULL COMMENT '商业订单的实际支付人民币金额/锁定人民币等值，充值返点基数；USDT 识别尾数不计入商品价格',
      \`extra\` JSON NOT NULL COMMENT '商品履约快照、USDT 汇率来源/汇率/采样时间、赠送要求及返点政策；支付币种金额仍以列保存',
      \`asset_operation_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '成功履约资金操作，引用 asset_operation.id',
      \`expires_at\` DATETIME(3) NOT NULL COMMENT '订单超时时间，UTC',
      \`paid_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '验证支付成功时间，UTC',
      \`fulfilled_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '金币和返点履约完成时间，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_order_order_key\` (\`order_key\`),
      UNIQUE KEY \`uq_order_channel_provider_key\` (\`payment_channel_id\`, \`provider_order_key\`),
      UNIQUE KEY \`uq_order_asset_operation\` (\`asset_operation_id\`),
      KEY \`ix_order_user_status\` (\`user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_order_status_expires\` (\`status\`, \`expires_at\`, \`id\`),
      CONSTRAINT \`fk_order_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_order_product_id\` FOREIGN KEY (\`product_id\`) REFERENCES \`product\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_order_payment_channel_id\` FOREIGN KEY (\`payment_channel_id\`) REFERENCES \`payment_channel\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_order_asset_operation_id\` FOREIGN KEY (\`asset_operation_id\`) REFERENCES \`asset_operation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_order_status\` CHECK (\`status\` IN (1, 2, 3, 4, 5, 6, 7)),
      CONSTRAINT \`ck_order_deleted_at\` CHECK (\`deleted_at\` IS NULL)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='通用商城订单、支付及商品履约状态'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`payment_event\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '事件状态，固定为 RecordStatus.RECORDED=1，支付证据不可改写',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间；不可变记录固定等于 created_at',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；支付证据禁止删除，恒为 NULL',
      \`payment_provider_id\` BIGINT UNSIGNED NOT NULL COMMENT '消息提供商，引用 payment_provider.id',
      \`order_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '可定位的商城订单，引用 order.id',
      \`payout_attempt_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '可定位的出款尝试，引用 payout_attempt.id；外键随批次内建',
      \`coin_market_trade_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '可定位的平台通道集市成交；外键待 0016 补建',
      \`event_key\` VARCHAR(160) NOT NULL COMMENT '提供商事件号或规范化语义去重键',
      \`event_type\` SMALLINT UNSIGNED NOT NULL COMMENT '事件类型：CALLBACK=1/QUERY=2/RECONCILIATION=3',
      \`verification_result\` SMALLINT UNSIGNED NOT NULL COMMENT '验签结果：VERIFIED=1/REJECTED=2',
      \`payload_hash\` BINARY(32) NOT NULL COMMENT '规范化原消息哈希',
      \`payload_ciphertext\` MEDIUMBLOB NOT NULL COMMENT '必要审计消息的加密密文',
      \`occurred_at\` DATETIME(3) NOT NULL COMMENT '渠道事件时间，UTC',
      \`received_at\` DATETIME(3) NOT NULL COMMENT '服务端接收时间，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_payment_event_provider_key\` (\`payment_provider_id\`, \`event_key\`),
      KEY \`ix_payment_event_order\` (\`order_id\`, \`id\`),
      KEY \`ix_payment_event_payout_attempt\` (\`payout_attempt_id\`, \`id\`),
      KEY \`ix_payment_event_coin_market_trade\` (\`coin_market_trade_id\`, \`id\`),
      CONSTRAINT \`fk_payment_event_provider\` FOREIGN KEY (\`payment_provider_id\`) REFERENCES \`payment_provider\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_payment_event_order\` FOREIGN KEY (\`order_id\`) REFERENCES \`order\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_payment_event_status\` CHECK (\`status\` = 1),
      CONSTRAINT \`ck_payment_event_deleted_at\` CHECK (\`deleted_at\` IS NULL),
      CONSTRAINT \`ck_payment_event_type\` CHECK (\`event_type\` IN (1, 2, 3)),
      CONSTRAINT \`ck_payment_event_verification\` CHECK (\`verification_result\` IN (1, 2)),
      CONSTRAINT \`ck_payment_event_single_target\` CHECK (((\`order_id\` IS NOT NULL) + (\`payout_attempt_id\` IS NOT NULL) + (\`coin_market_trade_id\` IS NOT NULL)) = 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='不可变支付回调及查询证据'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`external_settlement\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '对账状态，取值见 ExternalStatus：OPEN=1/RECONCILED=2/DISPUTED=3/REVERSED=4',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；外部资金事实禁止删除，恒为 NULL',
      \`payment_provider_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '渠道提供商，自有资金注入可为空，引用 payment_provider.id',
      \`order_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '入款订单，引用 order.id',
      \`payout_attempt_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '出款尝试，引用 payout_attempt.id；外键随批次内建',
      \`coin_market_trade_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '平台通道集市成交；外键待 0016 补建',
      \`related_external_settlement_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '手续费调整所对应的原外部资金记录，引用 external_settlement.id',
      \`asset_operation_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '内部收支记账操作，引用 asset_operation.id',
      \`settlement_key\` VARCHAR(160) NOT NULL COMMENT '外部收支语义键',
      \`external_transaction_key\` VARCHAR(160) NOT NULL COMMENT '渠道流水或链交易定位',
      \`flow_type\` SMALLINT UNSIGNED NOT NULL COMMENT '资金流向，取值见 ExternalFlowType：IN=1/OUT=2/FEE_ADJUSTMENT=3/FUNDING=4',
      \`original_currency\` VARCHAR(16) NOT NULL COMMENT '实际外部币种',
      \`original_amount\` DECIMAL(36,12) NOT NULL COMMENT '原币有符号收支数量',
      \`gross_cny_cents\` BIGINT NOT NULL COMMENT '人民币等值毛额，有符号',
      \`fee_cny_cents\` BIGINT NOT NULL DEFAULT 0 COMMENT '有符号费用分；正数增加费用，负数表示费用退回/冲减',
      \`net_cny_cents\` BIGINT NOT NULL COMMENT '内部人民币净变动',
      \`valuation_snapshot\` JSON NOT NULL COMMENT '计价、是否实换汇和费用证据',
      \`settled_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '渠道实际结算完成时刻，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_external_settlement_key\` (\`settlement_key\`),
      KEY \`ix_external_settlement_provider_status\` (\`payment_provider_id\`, \`status\`, \`settled_at\`, \`id\`),
      KEY \`ix_external_settlement_order\` (\`order_id\`),
      KEY \`ix_external_settlement_payout_attempt\` (\`payout_attempt_id\`),
      KEY \`ix_external_settlement_coin_market_trade\` (\`coin_market_trade_id\`),
      KEY \`ix_external_settlement_related\` (\`related_external_settlement_id\`),
      KEY \`ix_external_settlement_asset_operation\` (\`asset_operation_id\`),
      CONSTRAINT \`fk_external_settlement_provider\` FOREIGN KEY (\`payment_provider_id\`) REFERENCES \`payment_provider\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_external_settlement_order\` FOREIGN KEY (\`order_id\`) REFERENCES \`order\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_external_settlement_related\` FOREIGN KEY (\`related_external_settlement_id\`) REFERENCES \`external_settlement\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_external_settlement_operation\` FOREIGN KEY (\`asset_operation_id\`) REFERENCES \`asset_operation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_external_settlement_status\` CHECK (\`status\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_external_settlement_flow_type\` CHECK (\`flow_type\` IN (1, 2, 3, 4)),
      CONSTRAINT \`ck_external_settlement_net\` CHECK (\`net_cny_cents\` = \`gross_cny_cents\` - \`fee_cny_cents\`),
      CONSTRAINT \`ck_external_settlement_deleted_at\` CHECK (\`deleted_at\` IS NULL),
      CONSTRAINT \`ck_external_settlement_flow_in\` CHECK (((\`flow_type\` = 1) = (\`payout_attempt_id\` IS NULL AND \`related_external_settlement_id\` IS NULL)) AND (((\`order_id\` IS NOT NULL) + (\`coin_market_trade_id\` IS NOT NULL)) = 1)),
      CONSTRAINT \`ck_external_settlement_flow_out\` CHECK ((\`flow_type\` = 2) = (\`payout_attempt_id\` IS NOT NULL AND \`order_id\` IS NULL AND \`coin_market_trade_id\` IS NULL AND \`related_external_settlement_id\` IS NULL)),
      CONSTRAINT \`ck_external_settlement_flow_funding\` CHECK ((\`flow_type\` = 4) = (\`order_id\` IS NULL AND \`payout_attempt_id\` IS NULL AND \`coin_market_trade_id\` IS NULL AND \`related_external_settlement_id\` IS NULL)),
      CONSTRAINT \`ck_external_settlement_flow_fee\` CHECK ((\`flow_type\` = 3) = (\`related_external_settlement_id\` IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='平台外部资金收支及渠道对账'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`payout_account\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '收款账户状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '账户所有者，引用 user.id',
      \`account_key\` CHAR(36) NOT NULL COMMENT '稳定收款账户定位值',
      \`version\` BIGINT UNSIGNED NOT NULL COMMENT '收款资料版本；资料变化新增版本，不覆盖处理中出款目标',
      \`method_type\` SMALLINT UNSIGNED NOT NULL COMMENT '提供商支持的出款方法常量',
      \`account_ciphertext\` VARBINARY(8192) NOT NULL COMMENT '收款人、号码等加密资料',
      \`lookup_hash\` BINARY(32) NOT NULL COMMENT '规范化账户摘要，供查询和去重',
      \`masked_label\` VARCHAR(128) NOT NULL COMMENT '客户端脱敏显示名称',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_payout_account_key_version\` (\`account_key\`, \`version\`),
      KEY \`ix_payout_account_user_status\` (\`user_id\`, \`status\`, \`id\`),
      KEY \`ix_payout_account_lookup_hash\` (\`lookup_hash\`),
      CONSTRAINT \`fk_payout_account_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_payout_account_status\` CHECK (\`status\` IN (1, 2, 3)),
      CONSTRAINT \`ck_payout_account_version\` CHECK (\`version\` >= 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户指定收款账户的版本'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`withdrawal\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '提现状态，取值见 WithdrawalStatus：REQUESTED=1/REVIEWING=2/APPROVED=3/PAYING=4/SUCCEEDED=5/REJECTED=6/CANCELLED=7/UNKNOWN=8/FAILED=9',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；提现申请不可软删，恒为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '提现用户，引用 user.id',
      \`payout_account_id\` BIGINT UNSIGNED NOT NULL COMMENT '固定收款账户版本，引用 payout_account.id',
      \`asset_operation_id\` BIGINT UNSIGNED NOT NULL COMMENT '创建占款操作，引用 asset_operation.id',
      \`asset_hold_id\` BIGINT UNSIGNED NOT NULL COMMENT '用户人民币占款，引用 asset_hold.id',
      \`withdrawal_key\` CHAR(36) NOT NULL COMMENT '申请业务幂等定位值',
      \`cash_cents\` BIGINT NOT NULL COMMENT '用户要求实际到账的净额，人民币分；提现门槛以该净额对应金币数检验',
      \`fee_cents\` BIGINT NOT NULL DEFAULT 0 COMMENT '申请时确认费用，默认尚无额外规则；申请时冻结额为 cash_cents + fee_cents',
      \`coin_equivalent\` DECIMAL(38,12) NOT NULL COMMENT '门槛检验的金币等值',
      \`minimum_coins\` BIGINT NOT NULL COMMENT '最小金币等值快照，默认 1000',
      \`policy_snapshot\` JSON NOT NULL COMMENT '身份门禁、流水、比例及手续费快照',
      \`payout_not_before_at\` DATETIME(3) NOT NULL COMMENT '最早可提交线下/外部出款的时间，默认申请时间后 72 小时，UTC',
      \`approval_key\` CHAR(36) NULL DEFAULT NULL COMMENT '一次性审批事件定位值',
      \`approved_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '平台余额提现审核通过时间，UTC',
      \`completed_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '实际出款完成时间，UTC',
      \`failure_reason\` VARCHAR(500) NULL DEFAULT NULL COMMENT '失败或拒绝原因',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_withdrawal_key\` (\`withdrawal_key\`),
      UNIQUE KEY \`uq_withdrawal_operation\` (\`asset_operation_id\`),
      UNIQUE KEY \`uq_withdrawal_hold\` (\`asset_hold_id\`),
      UNIQUE KEY \`uq_withdrawal_approval_key\` (\`approval_key\`),
      KEY \`ix_withdrawal_user_status\` (\`user_id\`, \`created_at\`, \`id\`),
      KEY \`ix_withdrawal_status_not_before\` (\`status\`, \`payout_not_before_at\`, \`id\`),
      CONSTRAINT \`fk_withdrawal_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_withdrawal_payout_account_id\` FOREIGN KEY (\`payout_account_id\`) REFERENCES \`payout_account\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_withdrawal_operation\` FOREIGN KEY (\`asset_operation_id\`) REFERENCES \`asset_operation\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_withdrawal_hold\` FOREIGN KEY (\`asset_hold_id\`) REFERENCES \`asset_hold\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_withdrawal_status\` CHECK (\`status\` IN (1, 2, 3, 4, 5, 6, 7, 8, 9)),
      CONSTRAINT \`ck_withdrawal_cash\` CHECK (\`cash_cents\` >= 0 AND \`fee_cents\` >= 0),
      CONSTRAINT \`ck_withdrawal_deleted_at\` CHECK (\`deleted_at\` IS NULL)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='人民币提现申请审核与占款'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`payout_attempt\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '出款状态，取值见 PayoutStatus：PREPARED=1/SENDING=2/UNKNOWN=3/SUCCEEDED=4/FAILED=5',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；出款事实不可软删，恒为 NULL',
      \`withdrawal_id\` BIGINT UNSIGNED NOT NULL COMMENT '对应提现，引用 withdrawal.id',
      \`payment_channel_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '可用代理出款渠道，引用 payment_channel.id；人工出款为空',
      \`attempt_no\` INT UNSIGNED NOT NULL COMMENT '明确失败后才可递增的尝试序号，从 1 开始',
      \`payout_key\` VARCHAR(160) NOT NULL COMMENT '渠道幂等出款请求号；UNKNOWN 结果须用相同键查询原结果',
      \`provider_payout_key\` VARCHAR(160) NULL DEFAULT NULL COMMENT '渠道返回流水号',
      \`request_hash\` BINARY(32) NOT NULL COMMENT '同键请求一致性摘要',
      \`requested_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '开始请求时间，UTC',
      \`resolved_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '结果明确时间，UTC',
      \`active_marker\` TINYINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN (\`status\` IN (1, 2, 3)) AND (\`deleted_at\` IS NULL) THEN 1 ELSE NULL END) STORED NULL COMMENT '未明确完成或失败为 1，否则 NULL；以唯一索引限制每笔提现至多一个有效出款尝试',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_payout_attempt_withdrawal_no\` (\`withdrawal_id\`, \`attempt_no\`),
      UNIQUE KEY \`uq_payout_attempt_key\` (\`payout_key\`),
      UNIQUE KEY \`uq_payout_attempt_active\` (\`withdrawal_id\`, \`active_marker\`),
      KEY \`ix_payout_attempt_status_updated\` (\`status\`, \`updated_at\`, \`id\`),
      CONSTRAINT \`fk_payout_attempt_withdrawal\` FOREIGN KEY (\`withdrawal_id\`) REFERENCES \`withdrawal\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_payout_attempt_channel\` FOREIGN KEY (\`payment_channel_id\`) REFERENCES \`payment_channel\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_payout_attempt_status\` CHECK (\`status\` IN (1, 2, 3, 4, 5)),
      CONSTRAINT \`ck_payout_attempt_no\` CHECK (\`attempt_no\` >= 1),
      CONSTRAINT \`ck_payout_attempt_deleted_at\` CHECK (\`deleted_at\` IS NULL)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='外部出款尝试与未知结果恢复'
  `);

  // 批次内后建表对先建表的外键补建：payout_attempt/withdrawal/external_settlement 引用 payout_attempt（后建），
  // 以及 gift_grant / payment_event 引用 order（后建）。
  await context.query(
    'ALTER TABLE `gift_grant` ADD CONSTRAINT `fk_gift_grant_order` FOREIGN KEY (`order_id`) REFERENCES `order` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT',
  );
  await context.query(`
    ALTER TABLE \`payment_event\`
      ADD CONSTRAINT \`fk_payment_event_payout_attempt\` FOREIGN KEY (\`payout_attempt_id\`) REFERENCES \`payout_attempt\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
  await context.query(`
    ALTER TABLE \`external_settlement\`
      ADD CONSTRAINT \`fk_external_settlement_payout_attempt\` FOREIGN KEY (\`payout_attempt_id\`) REFERENCES \`payout_attempt\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  // 先移除批次内补建的外键，再按 up 的相反顺序删表。
  await context.query('ALTER TABLE `external_settlement` DROP CONSTRAINT `fk_external_settlement_payout_attempt`');
  await context.query('ALTER TABLE `payment_event` DROP CONSTRAINT `fk_payment_event_payout_attempt`');
  await context.query('ALTER TABLE `gift_grant` DROP CONSTRAINT `fk_gift_grant_order`');
  await context.query('DROP TABLE IF EXISTS `payout_attempt`');
  await context.query('DROP TABLE IF EXISTS `withdrawal`');
  await context.query('DROP TABLE IF EXISTS `payout_account`');
  await context.query('DROP TABLE IF EXISTS `external_settlement`');
  await context.query('DROP TABLE IF EXISTS `payment_event`');
  await context.query('DROP TABLE IF EXISTS `order`');
  await context.query('DROP TABLE IF EXISTS `product`');
  await context.query('DROP TABLE IF EXISTS `payment_channel`');
  await context.query('DROP TABLE IF EXISTS `payment_provider`');
  await context.query('DROP TABLE IF EXISTS `turnover_state`');
  await context.query('DROP TABLE IF EXISTS `gift_grant`');
  await context.query('DROP TABLE IF EXISTS `coin_exchange`');
}
