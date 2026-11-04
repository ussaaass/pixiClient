/**
 * coin-market 模块纯领域规则（挂牌守恒校验 + 价格报价 + 交易状态机转换表，
 * 11 态 DDL 权威，无 IO）。
 *
 * 领域所有者：coin-market 模块（domain/listing-rules.ts；用例层 / 适配器层
 * 前置校验经本文件纯函数，不直接读表）。
 * 对应 SDD 章节：后端实施 SDD §4（构造注入 ports，用例纯函数前置校验）、
 * §9 第 7 步（金币集市：挂牌 / 成交 / 确认 / 取消）、§5.13（coin_market_listing
 * 守恒 CHECK listed = available + reserved + filled + cancelled，全部非负，
 * listed > 0；coin_market_trade 11 态状态机 DDL 权威）；数据库设计 SDD §5.13
 * （DDL CHECK 守恒 + 状态机 CHECK）。
 *
 * 挂牌守恒约定（SDD §5.13 CHECK 约束 + 应用层前置校验双兜底）：
 * - `listed = available + reserved + filled + cancelled`（全部非负，listed > 0）；
 * - 每次 reserved / filled / cancelled 变更在行锁内 UPDATE，DB CHECK 兜底
 *   （迁移 0016-check 约束）；
 * - 首版只校验"变更前守恒成立 + 变更后仍成立"，不校验 reserved ≤ listed
 *   之外的跨表不变量（DB CHECK 是最终兜底）。
 *
 * 价格报价约定（docs / contracts 双资产文档 + SDD §5.13）：
 * - `grossCents = coins × priceCentsPer1000Coins ÷ 1000`（BigInt 整除，
 *   向下取整；登记舍入决策点：首版向下取整，Lead 确认是否改四舍五入）；
 * - `sellerNetCents`：首版 = grossCents（无平台佣金，登记决策点：未来
 *   经 configuration 模块注入费率后改 `sellerNetCents = grossCents - fee`）。
 *
 * 交易状态机约定（11 态 DDL 权威，SDD §5.13 CoinMarketTradeStatus；
 * 首版只覆盖玩家侧路径，DISPUTE 3/4/5/6 裁决路径归 §9 第 9 步 Admin）：
 * - PAYMENT_PENDING=1 → SELLER_CONFIRMATION_PENDING=2（卖家确认收款）；
 * - SELLER_CONFIRMATION_PENDING=2 → RELEASED=7（买家确认放币，首版登记
 *   放币分录经 wallet ledger 扩展点）；
 * - PAYMENT_PENDING=1 → PAYMENT_EXPIRED=9（付款截止超时，worker 扫描推进，
 *   首版登记 §6.3 worker 未建，用例层只读判定旧态）；
 * - PAYMENT_PENDING=1 → CANCELLED=11（买家取消 / 卖家取消，释放占款）；
 * - SELLER_CONFIRMATION_PENDING=2 → RESOLVED_RETURN=10（争议裁决返还，
 *   首版只读不写，Admin 裁决端点归 §9 第 9 步）；
 * - SELLER_CONFIRMATION_PENDING=2 → AUTO_RELEASED=8（自动放款 worker 推进，
 *   首版登记 worker 未建，用例层只读判定旧态）。
 */

/** CoinMarketTradeStatus：交易 11 态常量（DDL 权威，models/coin-market.ts）。 */
export const CoinMarketTradeStatus11 = {
  PAYMENT_PENDING: 1,
  SELLER_CONFIRMATION_PENDING: 2,
  DISPUTED: 3,
  BUYER_EVIDENCE_PENDING: 4,
  SELLER_EVIDENCE_PENDING: 5,
  PLATFORM_REVIEW: 6,
  RELEASED: 7,
  AUTO_RELEASED: 8,
  PAYMENT_EXPIRED: 9,
  RESOLVED_RETURN: 10,
  CANCELLED: 11,
} as const;

export type CoinMarketTradeStatus11Value = (typeof CoinMarketTradeStatus11)[keyof typeof CoinMarketTradeStatus11];

/** CoinMarketListingStatus：挂牌 5 态常量（DDL 权威，models/coin-market.ts）。 */
export const CoinMarketListingStatus5 = {
  ACTIVE: 1,
  PAUSED: 2,
  COMPLETED: 3,
  CANCELLED: 4,
  SUSPENDED: 5,
} as const;

export type CoinMarketListingStatus5Value = (typeof CoinMarketListingStatus5)[keyof typeof CoinMarketListingStatus5];

/**
 * 挂牌守恒校验（SDD §5.13 CHECK 约束应用层前置双兜底）：
 * - `listed = available + reserved + filled + cancelled`（全部非负，listed > 0）；
 * - 变更前行值须守恒成立（读回行值经本函数校验，不成立 → 抛 LISTING_HOLD_INCONSISTENT）。
 *
 * @param values 挂牌行 4 列值（string wire 十进制，BigInt 全链路）
 * @returns 守恒成立返回 `true`；不成立返回 `false`（用例层抛 `LISTING_HOLD_INCONSISTENT`
 *   —— 登记：CM 表无此码，首版经 STORAGE_UNAVAILABLE 映射，Lead 确认是否加码）。
 */
export function isValidListingInvariant(values: {
  listedCoins: string;
  availableCoins: string;
  reservedCoins: string;
  filledCoins: string;
  cancelledCoins: string;
}): boolean {
  const listed = BigInt(values.listedCoins);
  const available = BigInt(values.availableCoins);
  const reserved = BigInt(values.reservedCoins);
  const filled = BigInt(values.filledCoins);
  const cancelled = BigInt(values.cancelledCoins);
  // 全部非负
  if (available < 0n || reserved < 0n || filled < 0n || cancelled < 0n) return false;
  if (listed <= 0n) return false;
  // 守恒：listed = available + reserved + filled + cancelled
  const sum = available + reserved + filled + cancelled;
  return sum === listed;
}

/**
 * 价格报价（BigInt 全链路，向下取整；登记舍入决策点）：
 * - `grossCents = coins × priceCentsPer1000Coins ÷ 1000`（BigInt 整除）；
 * - `sellerNetCents`：首版 = grossCents（无平台佣金，登记决策点）。
 *
 * @returns wire 十进制字符串 { grossCents, sellerNetCents }；任一入参非法
 *   （coins ≤ 0 或 price ≤ 0）→ null（用例层映射 AMOUNT_MISMATCH / COINS_INSUFFICIENT）。
 */
export function priceQuote(coins: string, priceCentsPer1000Coins: string): { grossCents: string; sellerNetCents: string } | null {
  let coinsB: bigint;
  let priceB: bigint;
  try {
    coinsB = BigInt(coins);
    priceB = BigInt(priceCentsPer1000Coins);
  } catch {
    return null;
  }
  if (coinsB <= 0n || priceB <= 0n) return null;
  const grossCents = (coinsB * priceB) / 1000n; // BigInt 整除，向下取整
  const sellerNetCents = grossCents; // 首版无平台佣金（登记决策点）
  return { grossCents: grossCents.toString(), sellerNetCents: sellerNetCents.toString() };
}

/** 付款截止时间（秒；首版 30 分钟 = 1800s，登记决策点：可经 configuration 模块注入）。 */
export const PAYMENT_DEADLINE_SECONDS = 1800;

/**
 * 交易状态机转换表（11 态 DDL 权威；首版只覆盖玩家侧路径，DISPUTE 裁决路径
 * 归 §9 第 9 步 Admin，本表登记 3/4/5/6 → 7/10 转换但用例层不触发）。
 *
 * 键：from（状态码）；值：to 状态码数组（合法后继状态）。
 * - PAYMENT_PENDING=1 → [SELLER_CONFIRMATION_PENDING=2, PAYMENT_EXPIRED=9, CANCELLED=11]
 * - SELLER_CONFIRMATION_PENDING=2 → [RELEASED=7, AUTO_RELEASED=8, RESOLVED_RETURN=10]
 * - DISPUTED=3 → [BUYER_EVIDENCE_PENDING=4, SELLER_EVIDENCE_PENDING=5, PLATFORM_REVIEW=6]（首版不写，只读）
 * - BUYER_EVIDENCE_PENDING=4 → [PLATFORM_REVIEW=6]（首版不写）
 * - SELLER_EVIDENCE_PENDING=5 → [PLATFORM_REVIEW=6]（首版不写）
 * - PLATFORM_REVIEW=6 → [RELEASED=7, RESOLVED_RETURN=10]（首版不写，Admin 裁决端点）
 * - 终态（RELEASED=7 / AUTO_RELEASED=8 / PAYMENT_EXPIRED=9 / RESOLVED_RETURN=10 / CANCELLED=11）→ []
 */
export const COIN_MARKET_TRADE_TRANSITIONS: Readonly<Record<number, readonly number[]>> = Object.freeze({
  [CoinMarketTradeStatus11.PAYMENT_PENDING]: [
    CoinMarketTradeStatus11.SELLER_CONFIRMATION_PENDING,
    CoinMarketTradeStatus11.PAYMENT_EXPIRED,
    CoinMarketTradeStatus11.CANCELLED,
  ],
  [CoinMarketTradeStatus11.SELLER_CONFIRMATION_PENDING]: [
    CoinMarketTradeStatus11.RELEASED,
    CoinMarketTradeStatus11.AUTO_RELEASED,
    CoinMarketTradeStatus11.RESOLVED_RETURN,
  ],
  [CoinMarketTradeStatus11.DISPUTED]: [
    CoinMarketTradeStatus11.BUYER_EVIDENCE_PENDING,
    CoinMarketTradeStatus11.SELLER_EVIDENCE_PENDING,
    CoinMarketTradeStatus11.PLATFORM_REVIEW,
  ],
  [CoinMarketTradeStatus11.BUYER_EVIDENCE_PENDING]: [CoinMarketTradeStatus11.PLATFORM_REVIEW],
  [CoinMarketTradeStatus11.SELLER_EVIDENCE_PENDING]: [CoinMarketTradeStatus11.PLATFORM_REVIEW],
  [CoinMarketTradeStatus11.PLATFORM_REVIEW]: [CoinMarketTradeStatus11.RELEASED, CoinMarketTradeStatus11.RESOLVED_RETURN],
  [CoinMarketTradeStatus11.RELEASED]: [],
  [CoinMarketTradeStatus11.AUTO_RELEASED]: [],
  [CoinMarketTradeStatus11.PAYMENT_EXPIRED]: [],
  [CoinMarketTradeStatus11.RESOLVED_RETURN]: [],
  [CoinMarketTradeStatus11.CANCELLED]: [],
});

/**
 * 交易状态机转换合法性校验（from → to 是否合法；经转换表查）。
 * @returns 合法返回 `true`；不合法返回 `false`（用例层抛 `TRADE_NOT_ALLOWED`）。
 */
export function canTradeTransition(from: number, to: number): boolean {
  const allowed = COIN_MARKET_TRADE_TRANSITIONS[from];
  if (allowed === undefined) return false;
  return allowed.includes(to);
}

/**
 * 首版玩家侧可触发的状态转换（DISPUTE 裁决路径 3/4/5/6 → 7/10 排除，
 * 归 §9 第 9 步 Admin；PAYMENT_EXPIRED / AUTO_RELEASED 经 worker 推进，
 * 首版登记 worker 未建，用例层不触发，只读判定旧态）。
 *
 * @param from 当前状态
 * @param to 目标状态
 * @returns 玩家侧可触发返回 `true`；DISPUTE / worker 路径返回 `false`（
 *   用例层映射 TRADE_NOT_ALLOWED，登记决策点：Lead 确认首版玩家侧是否
 *   允许 PAYMENT_PENDING → CANCELLED=11 买家取消）。
 */
export function canPlayerTriggerTransition(from: number, to: number): boolean {
  // 首版玩家侧可触发：1→2（卖家确认）、1→11（买家取消，登记决策点）
  // 2→7（买家确认放币，登记放币扩展点）
  // 1→9（超时，worker 推进，首版登记不触发）
  // 2→8（自动放款，worker 推进，首版登记不触发）
  // 2→10（争议返还，Admin 裁决，首版不触发）
  // 3/4/5/6 → 任何（DISPUTE 路径，归 Admin）
  if (from === CoinMarketTradeStatus11.PAYMENT_PENDING) {
    return to === CoinMarketTradeStatus11.SELLER_CONFIRMATION_PENDING || to === CoinMarketTradeStatus11.CANCELLED;
  }
  if (from === CoinMarketTradeStatus11.SELLER_CONFIRMATION_PENDING) {
    return to === CoinMarketTradeStatus11.RELEASED;
  }
  return false;
}
