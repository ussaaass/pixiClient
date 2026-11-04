import type { Sequelize } from 'sequelize';

/**
 * 0019 — 支付种子：Mock 支付提供商（MOCK=3）+ 五个 Mock 支付渠道（ALIPAY/WECHAT/BANK/UNIONPAY_QR/ECNY）
 * + 一个金币购买商品（ON_SALE=2，固定 1 元 = 10 金币，SDD §A.4 默认比例）。
 *
 * 领域依据：`docs/04_domains/双资产充值兑换与提现.md` §1
 * （"支付宝/微信/银行卡/银联二维码/数字人民币由代理商提供"，
 *  MockHandler 配套开发/测试模拟页面，可操作成功/失败/超时/重复回调，
 *  不能产生生产支付成功"）；§5.2（"五种代理支付 fixture"）。
 *
 * 首版 Mock 渠道：
 * - provider：`MOCK`，provider_type=MOCK=3，secret_reference=NULL（CHECK 约束允许），
 *   adapter_key=`mock`（服务器适配器注册表键，首版唯一，真实渠道 adapter 未闭环）。
 * - 渠道：method_type=ALIPAY=1/WECHAT=2/BANK=3/UNIONPAY_QR=4/ECNY=5，
 *   channel_code=`mock_alipay`/`mock_wechat`/`mock_bank`/`mock_unionpay_qr`/`mock_ecny`，
 *   priority=1..5（玩家列表展示顺序），fee_config=`{}`（Mock 不模拟通道费率，
 *   演练时实付全额记入系统 CNY 资产，§5.2 口径）。
 * - 商品：`COIN_10`，1 元 = 10 金币，ON_SALE=2，cny_fen=100，credit_coins=10，
 *   与 `cny_to_coin_ratio` 默认 1:10 对齐（双资产文档 §5 "默认 1 元:10 金币"）。
 *
 * 幂等：所有 INSERT 使用 INSERT IGNORE（provider_code / channel_code / product_code 唯一键），
 * 重复执行不报错。down：按商品 → 渠道 → 提供商顺序 DELETE（RESTRICT 外键保护）。
 *
 * 注意：USDT_TRON=6 渠道不入 seed（自建 TRON 首版无 provider，
 *  真实链上流程未闭环，随 0011 chain 表 + 汇率采样任务落地）。
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  // Mock 提供商（provider_type=MOCK=3，secret_reference=NULL，CHECK 约束允许）
  await context.query(`
    INSERT IGNORE INTO \`payment_provider\` (
      \`status\`, \`created_at\`, \`updated_at\`, \`deleted_at\`,
      \`provider_code\`, \`provider_type\`, \`name\`, \`adapter_key\`,
      \`secret_reference\`, \`capability_snapshot\`
    ) VALUES (
      1, NOW(3), NOW(3), NULL,
      'MOCK', 3, 'Mock 支付提供商（开发/测试）', 'mock',
      NULL,
      JSON_OBJECT('supports_order', true, 'supports_query', true, 'supports_payout', false, 'mock_only', true)
    )
  `);

  // 五个 Mock 支付渠道（method_type 1..5；priority 展示顺序；fee_config 空）
  await context.query(`
    INSERT IGNORE INTO \`payment_channel\` (
      \`status\`, \`created_at\`, \`updated_at\`, \`deleted_at\`,
      \`payment_provider_id\`, \`channel_code\`, \`method_type\`,
      \`channel_config\`, \`fee_config\`, \`priority\`
    ) SELECT
      1, NOW(3), NOW(3), NULL,
      p.id, t.channel_code, t.method_type,
      JSON_OBJECT('mock', true), JSON_OBJECT('fee_bps', 0), t.priority
    FROM \`payment_provider\` p
    CROSS JOIN (
      SELECT 'mock_alipay' AS channel_code, 1 AS method_type, 1 AS priority UNION ALL
      SELECT 'mock_wechat', 2, 2 UNION ALL
      SELECT 'mock_bank', 3, 3 UNION ALL
      SELECT 'mock_unionpay_qr', 4, 4 UNION ALL
      SELECT 'mock_ecny', 5, 5
    ) t
    WHERE p.provider_code = 'MOCK'
  `);

  // 金币购买商品（ON_SALE=2；1 元 = 10 金币，与 cny_to_coin_ratio 默认 1:10 对齐）
  await context.query(`
    INSERT IGNORE INTO \`product\` (
      \`status\`, \`created_at\`, \`updated_at\`, \`deleted_at\`,
      \`product_code\`, \`product_type\`, \`version\`, \`name\`,
      \`price_amount\`, \`price_currency\`, \`fulfillment_spec\`
    ) VALUES (
      2, NOW(3), NOW(3), NULL,
      'COIN_10', 1, 1, '金币 10 枚（1 元）',
      '10.000000000000', 'CNY',
      JSON_OBJECT('coin_units', 10, 'grant_coins', 0, 'turnover_multiplier', 5)
    )
  `);
}

/**
 * 回滚语义：删除 Mock 种子行（渠道 → 商品 → 提供商，RESTRICT 外键顺序）。
 * 不删除 0010 创建的表结构。
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  // 商品（无外键依赖，先删）
  await context.query(`DELETE FROM \`product\` WHERE \`product_code\` = 'COIN_10'`);
  // 渠道（FK → provider，需在 provider 之前删除）
  await context.query(`
    DELETE c FROM \`payment_channel\` c
    JOIN \`payment_provider\` p ON c.payment_provider_id = p.id
    WHERE p.provider_code = 'MOCK'
  `);
  // 提供商（无渠道残留后可删）
  await context.query(`DELETE FROM \`payment_provider\` WHERE \`provider_code\` = 'MOCK'`);
}
