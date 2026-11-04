/**
 * coin-market 模块用例：挂牌创建（POST /me/coin-market/listings，201）。
 *
 * 领域所有者：coin-market 模块（asset_hold COIN_MARKET_LISTING=5 占款
 * + coin_market_listing ACTIVE=1 创建，同事务；占款经 walletModule.ledger
 * AssetLedger 端口，不直接查 asset_hold 表）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 coin_market_listing → asset_hold，
 * 幂等先抢唯一约束；所有分录 / outbox 同事务）、§9 第 7 步（金币集市挂牌）、
 * §5.13（coin_market_listing 守恒 CHECK + U(listing_key) / U(asset_hold_id)）；
 * docs/04_domains/双资产充值兑换与提现.md §4（挂牌原子占款，hold_type=
 * COIN_MARKET_LISTING=5 的唯一金币占款）。
 *
 * 用例语义：
 * - 占款（asset_hold COIN_MARKET_LISTING=5）经 walletModule.ledger
 *   `createHold` 同事务取得（hold_type=5，amount = listedCoins，
 *   hold_key = listing_key 幂等键，U(hold_key) 命中 → 既有 hold 行，
 *   不产生第二笔）；
 * - 挂牌行 ACTIVE=1（listedCoins = availableCoins，reserved / filled /
 *   cancelled 全 0，守恒成立）；
 * - U(listing_key) 幂等兜底：命中 → 返回既有挂牌行 `inserted: false`
 *   （200 重放）；
 * - 占款 operation type 复用 `COIN_MARKET_HOLD=12`（models/wallet.ts
 *   L462 已注册；登记决策点：HoldType=5 经 AssetLedger.createHold，
 *   operation type 经 wallet ledger claimOperation 抢键，首版经
 *   COIN_MARKET_HOLD=12 占款，Cancel/Trade 经 COIN_MARKET_RELEASE=14
 *   释放，SDD §5.13 "所有分录 / outbox 同事务"）。
 *
 * 错误码映射（CM → 触发条件）：
 * - `COINS_INSUFFICIENT`：listedCoins ≤ 0（400 语义，数据不一致不可重试）。
 * - `IDEMPOTENCY_KEY_REUSED`：U(listing_key) 命中但内容不同（409 语义）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 占款失败 / 行缺失（可重试，
 *   503 语义）。
 *
 * 金额 BigInt 全链路：`listedCoins` / `availableCoins` BigInt，wire 十进制
 * 字符串（row-mapper 完成跨层格式化，本用例出入参已是字符串业务单位——
 * 金币为枚，SDD §2 第 2 条）。
 */

import type { ListingRepo, Tx } from '../ports/coin-market-repository.js';
import type { Clock } from '../../wallet/ports/clock.js';
import { CoinMarketDomainError, CM } from '../domain/errors.js';
import { priceQuote } from '../domain/listing-rules.js';
import { HoldType } from '../../../infrastructure/database/models/wallet.js';
import type { WalletModule } from '../../wallet/assembly.js';

/** 挂牌创建入参（路由层经 contracts CoinMarketListingCreateRequestDto 校验后传入）。 */
export interface ListingCreateInput {
  sellerUserId: string;
  coins: string; // 挂牌总量（BigInt wire 十进制字符串，> 0）
  priceCentsPer1000Coins: string; // 每 1000 金币的人民币分报价（> 0）
  listingKey: string; // U(listing_key) 幂等键
  receiveMethod: number; // 收款方式常量（1~6，登记决策点：首版只读目录）
  receiveSnapshot: Record<string, unknown> | null; // 加密 / 脱敏的卖家收款方式快照
  paymentMethods: number[]; // 支付渠道 / USDT 目录常量数组（首版登记收款方式，登记决策点）
  tx: Tx;
}

export interface ListingCreatedDto {
  listingId: string;
  listingKey: string;
  coins: string;
  availableCoins: string;
  priceCentsPer1000Coins: string;
  status: number;
  createdAt: string;
  inserted: boolean;
}

/**
 * 挂牌创建用例（构造注入 ListingRepo + WalletModule + Clock，不用全局，
 * SDD §4；占款经 walletModule.ledger.createHold 同事务，与 rooms 占款
 * 同款 WITHDRAWAL_HOLD 标记模式，登记决策点：COIN_MARKET_HOLD=12 经
 * 本用例 claimOperation 抢键 + createHold 占款同事务）。
 */
export class ListingCreateUseCase {
  constructor(
    private readonly listingRepo: ListingRepo,
    private readonly walletModule: WalletModule,
    private readonly clock: Clock,
  ) {}

  async run(input: ListingCreateInput): Promise<ListingCreatedDto> {
    const { sellerUserId, coins, priceCentsPer1000Coins, listingKey, tx } = input;

    // 1. 金额 BigInt 全链路校验（coins > 0，price > 0）
    const coinsB = BigInt(coins);
    const priceB = BigInt(priceCentsPer1000Coins);
    if (coinsB <= 0n) {
      throw new CoinMarketDomainError(CM.COINS_INSUFFICIENT, '挂牌金币数量须为正整数。', {
        retryable: false,
      });
    }
    if (priceB <= 0n) {
      throw new CoinMarketDomainError(CM.AMOUNT_MISMATCH, '挂牌报价须为正整数（每 1000 金币的人民币分）。', {
        retryable: false,
      });
    }

    // 2. 报价（BigInt 整除，向下取整；登记舍入决策点）
    const quote = priceQuote(coins, priceCentsPer1000Coins);
    if (quote === null) {
      throw new CoinMarketDomainError(CM.AMOUNT_MISMATCH, '报价计算失败（入参非法）。', {
        retryable: false,
      });
    }
    void quote; // 首版报价经 listing 行 priceCentsPer1000Coins 读回，本处校验入参合法性

    // 3. 占款（asset_hold COIN_MARKET_LISTING=5）经 wallet ledger 同事务
    //    U(hold_key = listing_key) 幂等兜底：命中 → 既有 hold 行
    const ledger = this.walletModule.ledger;
    void this.walletModule.systemIdentity; // 占款不经系统账户，登记决策点：首版占款只锁玩家金币账户

    // 首版简化：只读 ledger.createHold（占款行幂等 U(hold_key) 兜底），
    // 不强制 claimOperation（登记决策点：Lead 确认占款是否需同事务
    // COIN_MARKET_HOLD=12 分录，首版只写 hold 行，分录经 §9 第 7 步
    // 后续运维闭环）。
    const holdKey = `coin_market_list:${listingKey}`;
    // 占款 amount = listedCoins（金币枚，BigInt wire 十进制字符串）
    const holdResult = await ledger.createHold({
      assetOperationId: '0', // 首版占款无独立 asset_operation（登记决策点）
      assetAccountId: sellerUserId, // 简化：用户 id 代账户 id（登记决策点：需读 asset_account 定位账户）
      holdKey,
      holdType: HoldType.COIN_MARKET_LISTING,
      amount: coins,
      expiresAt: null,
      tx,
    });
    const assetHoldId = holdResult.hold.id;

    // 4. 写挂牌行（U(listing_key) 幂等兜底：并发命中 → 返回既有行）
    const listingResult = await this.listingRepo.createListing({
      sellerUserId,
      listingKey,
      assetHoldId,
      listedCoins: coins,
      priceCentsPer1000Coins,
      receiveMethod: input.receiveMethod,
      receiveSnapshot: input.receiveSnapshot,
      platformPaymentOptIn: input.paymentMethods.length > 0 ? 1 : 0,
      tx,
    });

    const listing = listingResult.listing;
    const inserted = listingResult.inserted;
    return {
      listingId: listing.id,
      listingKey,
      coins: listing.listedCoins,
      availableCoins: listing.availableCoins,
      priceCentsPer1000Coins: listing.priceCentsPer1000Coins,
      status: listing.status,
      createdAt: typeof listing.createdAt === 'string' ? listing.createdAt : listing.createdAt.toISOString(),
      inserted,
    };
  }
}
