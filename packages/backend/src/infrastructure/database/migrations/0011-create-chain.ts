import type { Sequelize } from 'sequelize';

/**
 * 0011 — TRON 链到账：`chain_address`、`chain_deposit_event`、`chain_scan_cursor`。
 *
 * 字段与约束逐条对应 `docs/05_data/数据库设计SDD.md` §5.4。
 * 批次内顺序即依赖：`chain_address` 被 `chain_deposit_event` 引用，故在前。
 *
 * 只建列不建外键的引用：`chain_address.order_id` 与 `chain_deposit_event.order_id`
 * 指向 `order` 表（0010 已建），目标表在同一批次或更早，直接建 RESTRICT 外键。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`
    CREATE TABLE IF NOT EXISTS \`chain_address\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '地址行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`user_id\` BIGINT UNSIGNED NOT NULL COMMENT '唯一地址归属用户，引用 user.id；必须与 order.user_id 一致',
      \`order_id\` BIGINT UNSIGNED NOT NULL COMMENT '唯一绑定的 TRON 入款订单，引用 order.id；每单随机分配一个地址，地址与订单一对一',
      \`chain_code\` VARCHAR(32) NOT NULL COMMENT '含主网或测试网的链标识',
      \`address\` VARCHAR(128) NOT NULL COMMENT '规范化收款地址',
      \`signer_reference\` VARCHAR(255) NULL DEFAULT NULL COMMENT '隔离签名服务引用，不是私钥',
      \`assigned_at\` DATETIME(3) NOT NULL COMMENT '分配时刻，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_chain_address_order_id\` (\`order_id\`),
      UNIQUE KEY \`uq_chain_address_chain\` (\`chain_code\`, \`address\`),
      KEY \`ix_chain_address_user_status\` (\`user_id\`, \`chain_code\`, \`status\`, \`id\`),
      CONSTRAINT \`fk_chain_address_user_id\` FOREIGN KEY (\`user_id\`) REFERENCES \`user\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_chain_address_order_id\` FOREIGN KEY (\`order_id\`) REFERENCES \`order\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_chain_address_status\` CHECK (\`status\` IN (1, 2, 3))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='TRON 收款地址归属'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`chain_deposit_event\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '链到账事件状态，取值见 ChainDepositStatus：SEEN=1/CONFIRMING=2/CONFIRMED=3/MATCHED=4/UNMATCHED=5/FAILED=6/REORGED=7',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；链上事实禁止删除，恒为 NULL',
      \`chain_address_id\` BIGINT UNSIGNED NOT NULL COMMENT '接收地址，引用 chain_address.id',
      \`order_id\` BIGINT UNSIGNED NULL DEFAULT NULL COMMENT '审定匹配的商城订单，引用 order.id；超时/金额不符/无法唯一匹配时为空并转客服',
      \`chain_code\` VARCHAR(32) NOT NULL COMMENT '链及网络标识',
      \`tx_hash\` VARCHAR(128) NOT NULL COMMENT '链交易哈希',
      \`event_index\` INT UNSIGNED NOT NULL COMMENT '同一交易日志事件位置',
      \`contract_address\` VARCHAR(128) NOT NULL COMMENT '白名单 USDT 合约',
      \`sender_address\` VARCHAR(128) NOT NULL COMMENT '付款链地址',
      \`amount_atomic\` DECIMAL(36,0) NOT NULL COMMENT '代币最小单位整数',
      \`token_decimals\` SMALLINT UNSIGNED NOT NULL COMMENT '代币精度快照',
      \`block_height\` BIGINT UNSIGNED NOT NULL COMMENT '所在区块高度',
      \`block_hash\` VARCHAR(128) NOT NULL COMMENT '区块标识',
      \`confirmed_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '满足固化及成功执行条件时间，UTC',
      \`confirmation_snapshot\` JSON NULL DEFAULT NULL COMMENT '固化区块、执行结果和校验依据',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_chain_deposit_event_tx\` (\`chain_code\`, \`tx_hash\`, \`event_index\`),
      KEY \`ix_chain_deposit_event_address\` (\`chain_address_id\`, \`status\`, \`block_height\`, \`id\`),
      KEY \`ix_chain_deposit_event_order\` (\`order_id\`),
      KEY \`ix_chain_deposit_event_status_height\` (\`status\`, \`block_height\`, \`id\`),
      CONSTRAINT \`fk_chain_deposit_event_address\` FOREIGN KEY (\`chain_address_id\`) REFERENCES \`chain_address\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`fk_chain_deposit_event_order\` FOREIGN KEY (\`order_id\`) REFERENCES \`order\` (\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT \`ck_chain_deposit_event_status\` CHECK (\`status\` IN (1, 2, 3, 4, 5, 6, 7)),
      CONSTRAINT \`ck_chain_deposit_event_event_index\` CHECK (\`event_index\` >= 0),
      CONSTRAINT \`ck_chain_deposit_event_deleted_at\` CHECK (\`deleted_at\` IS NULL)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='TRC20 转账发现确认和订单匹配'
  `);

  await context.query(`
    CREATE TABLE IF NOT EXISTS \`chain_scan_cursor\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '此表主键，对外以十进制字符串表示',
      \`status\` SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '游标行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'UTC 创建时间',
      \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'UTC 最后修改时间',
      \`deleted_at\` DATETIME(3) NULL DEFAULT NULL COMMENT '逻辑删除时间；未删除为 NULL',
      \`chain_code\` VARCHAR(32) NOT NULL COMMENT '链及网络',
      \`scanner_key\` VARCHAR(64) NOT NULL COMMENT '合约和地址集合扫描任务键',
      \`last_finalized_height\` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已处理固化区块高度；高度为普通数值，允许 0',
      \`last_block_hash\` VARCHAR(128) NULL DEFAULT NULL COMMENT '检查点区块标识',
      \`owner_key\` VARCHAR(128) NULL DEFAULT NULL COMMENT '当前扫描进程身份',
      \`fencing_token\` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '接管版本，旧进程写入被拒绝；普通版本号，允许 0 起',
      \`lease_until\` DATETIME(3) NULL DEFAULT NULL COMMENT '接管租约期限，UTC',
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_chain_scan_cursor_task\` (\`chain_code\`, \`scanner_key\`),
      CONSTRAINT \`ck_chain_scan_cursor_status\` CHECK (\`status\` IN (1, 2, 3))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='链扫描检查点及接管版本'
  `);
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS `chain_scan_cursor`');
  await context.query('DROP TABLE IF EXISTS `chain_deposit_event`');
  await context.query('DROP TABLE IF EXISTS `chain_address`');
}
