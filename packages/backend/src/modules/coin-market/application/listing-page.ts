/**
 * coin-market 模块用例：集市页挂牌列表 + 报价（GET /me/coin-market/listings +
 * GET /me/coin-market/price-quote，只读，无副作用）。
 *
 * 领域所有者：coin-market 模块（读 coin_market_listing，不写表；SDD §5.13
 * "不新增报表持久化表"，集市页纯读投影）。
 * 对应 SDD 章节：后端实施 SDD §9 第 7 步（金币集市集市页 + 报价端点）、
 * §5.13（coin_market_listing 读路径 + 参考报价 referenceCentsPer1000Coins）；
 * contracts coin-market.ts（CoinMarketListingPageSchema +
 * CoinMarketPriceQuoteDtoSchema，报价纯函数无副作用）。
 *
 * 用例语义：
 * - `listListings`：活跃挂牌列表（status=ACTIVE=1 + availableCoins > 0，
 *   游标分页 50/页；参考报价 = 本页内最低 priceCentsPer1000Coins，
 *   首版纯读集市内最低报价，登记决策点：可经 configuration 注入市场基准价）；
 * - `priceQuote`：纯函数报价（BigInt 整除，向下取整；登记舍入决策点），
 *   无副作用（读路径，不经 wallet ledger，不经 DB）。
 *
 * 错误码映射（CM → 触发条件）：
 * - `COINS_INSUFFICIENT`：coins ≤ 0（400 语义，报价端点入参校验）。
 * - `AMOUNT_MISMATCH`：price ≤ 0 / 报价计算失败（400 语义）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障（可重试，503 语义，列表端点）。
 */

import type { ListingRepo, Tx } from '../ports/coin-market-repository.js';
import { CoinMarketDomainError, CM } from '../domain/errors.js';
import { priceQuote } from '../domain/listing-rules.js';

/** 集市页单页条数上限（SDD §5.4 游标分页 50/页；登记决策点：可经 configuration 注入）。 */
export const LISTING_PAGE_LIMIT = 50;

/** 挂牌列表项 DTO（wire；对齐 contracts CoinMarketListingSchema，脱敏最小负载）。 */
export interface ListingItemDto {
  listingId: string;
  coins: string;
  availableCoins: string;
  priceCentsPer1000Coins: string;
  totalCents: string;
  status: number;
  createdAt: string;
  sellerLabel: string | null;
}

export interface ListingPageDto {
  items: ListingItemDto[];
  referenceCentsPer1000Coins: string | null;
  nextCursor: string | null;
}

/** 报价 DTO（wire；对齐 contracts CoinMarketPriceQuoteDtoSchema，纯函数无副作用）。 */
export interface PriceQuoteDto {
  coins: string;
  priceCentsPer1000Coins: string;
  grossCents: string;
  sellerNetCents: string;
}

/**
 * 集市页 + 报价用例（构造注入 ListingRepo，不用全局，SDD §4；
 * 读路径无写操作，同事务约定不适用，`tx` 可无事务）。
 * `displayNameOf` 经 identity model 匿名展示名端口注入（跨模块复用，
 * 不直接查 user 表，保持模块内聚；首版实现由 assembly.ts 提供）。
 */
export class ListingPageUseCase {
  constructor(
    private readonly listingRepo: ListingRepo,
    private readonly displayNameOf: (userId: string) => Promise<string>,
  ) {}

  /**
   * GET /me/coin-market/listings：集市页（活跃挂牌列表 + 参考报价，
   * 游标分页 50/页）。
   */
  async listListings(cursor: string | null, tx: Tx): Promise<ListingPageDto> {
    const page = await this.listingRepo.listActiveListings({
      cursor,
      limit: LISTING_PAGE_LIMIT,
      tx,
    });
    const items: ListingItemDto[] = [];
    for (const row of page.items) {
      const sellerLabel = await this.displayNameOf(row.sellerUserId);
      items.push({
        listingId: row.id,
        coins: row.listedCoins,
        availableCoins: row.availableCoins,
        priceCentsPer1000Coins: row.priceCentsPer1000Coins,
        totalCents: priceQuote(row.listedCoins, row.priceCentsPer1000Coins)?.grossCents ?? '0',
        status: row.status,
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : row.createdAt.toISOString(),
        sellerLabel,
      });
    }
    return { items, referenceCentsPer1000Coins: page.referenceCentsPer1000Coins, nextCursor: page.nextCursor };
  }

  /**
   * GET /me/coin-market/price-quote：报价纯函数（无副作用，不经 DB /
   * wallet ledger；BigInt 整除向下取整，登记舍入决策点）。
   */
  async priceQuoteRequest(coins: string, priceCentsPer1000Coins: string): Promise<PriceQuoteDto> {
    const coinsB = BigInt(coins);
    const priceB = BigInt(priceCentsPer1000Coins);
    if (coinsB <= 0n) {
      throw new CoinMarketDomainError(CM.COINS_INSUFFICIENT, '报价金币数量须为正整数。', {
        retryable: false,
      });
    }
    if (priceB <= 0n) {
      throw new CoinMarketDomainError(CM.AMOUNT_MISMATCH, '报价须为正整数（每 1000 金币的人民币分）。', {
        retryable: false,
      });
    }
    const quote = priceQuote(coins, priceCentsPer1000Coins);
    if (quote === null) {
      throw new CoinMarketDomainError(CM.AMOUNT_MISMATCH, '报价计算失败（入参非法）。', {
        retryable: false,
      });
    }
    return {
      coins,
      priceCentsPer1000Coins,
      grossCents: quote.grossCents,
      sellerNetCents: quote.sellerNetCents,
    };
  }
}
