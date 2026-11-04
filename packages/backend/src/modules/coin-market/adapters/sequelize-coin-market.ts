/**
 * coin-market 仓储适配器（Sequelize 实现各 Repo 端口；models/coin-market.ts
 * 2 model 的唯一写入点，行锁/幂等/守恒 CHECK 转换全在此层）。
 *
 * 领域所有者：coin-market 模块（models/coin-market.ts 为其唯一 model 定义；
 * asset_hold 经 wallet 模块 AssetLedger 端口操作，不直接查表；
 * 各表行锁/幂等/守恒 CHECK 约定经本层落库，领域规则经 domain/listing-rules.ts 校验）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 coin_market_listing →
 * coin_market_trade → asset_hold，幂等先抢唯一约束；所有分录 / outbox 同
 * 事务）、§9 第 7 步（金币集市：挂牌 / 成交 / 确认 / 取消）、§3.2 实体
 * 归属矩阵（coin-market owns 2 coin_market_* 表，models/coin-market.ts）；
 * 数据库设计 SDD §5.13（coin_market_listing 守恒 CHECK + U(listing_key) /
 * U(asset_hold_id)；coin_market_trade 11 态状态机 + U(trade_key) /
 * U(chain_tx_id) / U(asset_operation_id)）。
 *
 * 行锁与并发约定（与 rooms / social / referral 适配器同款纪律）：
 * - `lock: 'FOR UPDATE'` 字符串字面量写法（InnoDB 行锁，§4 锁顺序）；
 * - 唯一约束幂等兜底：`U(listing_key)` / `U(trade_key)` / `U(chain_tx_id)`
 *   命中 → 返回既有行（不产生第二行，验收红线"成交幂等"）；
 * - 守恒 CHECK：`listed = available + reserved + filled + cancelled`
 *   （全部非负，listed > 0）经 `domain/listing-rules.ts` `isValidListingInvariant`
 *   前置校验 + DB CHECK 兜底（迁移 0016），本层只做 UPDATE 落库
 *   （影响行数 0 = 守恒破坏 → 抛 STORAGE_UNAVAILABLE 可重试）；
 * - 11 态状态机转换由用例层经 `domain/listing-rules.ts`
 *   `canPlayerTriggerTransition` 前置校验，本层只做 UPDATE 落库。
 *
 * 错误码映射（coin-market domain/errors.ts CM 表）：
 * - `LISTING_NOT_FOUND` / `TRADE_NOT_FOUND`：行缺失（404 语义）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 守恒破坏 / 状态机影响行数 0
 *   （可重试，503 语义）。
 * - `IDEMPOTENCY_KEY_REUSED`：U(trade_key) 命中但内容不同（409 语义）。
 *
 * 结构约定（每表一类，不混类）：
 * 各 Repo 接口各有 `create` / `lockByPk` 等同名方法，一个类无法实现两个
 * 签名，故拆为 2 个独立类（`SequelizeListingRepo` / `SequelizeTradeRepo`），
 * 各实现自己的接口；共享 `txOf` 辅助函数保留在文件顶部，各 Repo 类都调。
 * 装配层（assembly.ts）按角色独立构造，与 rooms / referral 模块同款模式。
 * 注：Sequelize 6 的 BIGINT 列在严格模式（string 属性接口）下 create/update
 * 入参经 `as never` 桥接（rooms 适配器同款写法，_shared.ts 第 8 条）。
 * `exactOptionalPropertyTypes` 下 Sequelize 查询 options 对象经 `as never`
 * 整体桥接（rooms 适配器同款写法；`lock: txq ? 'FOR UPDATE' : undefined`
 * + `transaction: txq` 直传，不写 `?? undefined`）。
 * `Op` unique symbol 索引经 `as unknown as string` 桥接（TS2538，
 * referral 适配器同款写法）。
 */

import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import type { CoinMarketListingModel, CoinMarketTradeModel } from '../../../infrastructure/database/models/coin-market.js';
import { CoinMarketListingStatus, CoinMarketTradeStatus } from '../../../infrastructure/database/models/coin-market.js';
import type { ListingRepo, TradeRepo, Tx } from '../ports/coin-market-repository.js';
import { CoinMarketDomainError, CM } from '../domain/errors.js';

/** 取事务（Sequelize Transaction 鸭子类型；与 rooms 适配器同款约定）。
 * 返回 `Transaction | null`（exactOptionalPropertyTypes 下 undefined 不可赋给
 * null 槽，统一 null 化；options 经 `as never` 整体桥接后直传）。 */
function txOf(tx?: Tx): Transaction | null {
  return (tx?.transaction as Transaction | undefined) ?? null;
}

/** 稳定游标解析 `{createdAt ISO}~{id}`（SDD §5.4 游标分页约定）。 */
function parseCursor(cursor: string | null): { createdAt: string; id: string } | null {
  if (cursor === null) return null;
  const idx = cursor.lastIndexOf('~');
  if (idx <= 0) return null;
  return { createdAt: cursor.slice(0, idx), id: cursor.slice(idx + 1) };
}

function formatCursor(item: { createdAt: Date | string; id: string }): string {
  const iso = typeof item.createdAt === 'string' ? item.createdAt : item.createdAt.toISOString();
  return `${iso}~${item.id}`;
}

/** coin-market 模块 11 态交易状态常量（DDL 权威，models/coin-market.ts）。
 * 本文件不重定义，经 models/coin-market.ts 导入；`CoinMarketTradeStatus`
 * 在此直接可用。 */

// ---------------------------------------------------------------------------
// ListingRepo（coin_market_listing）
// ---------------------------------------------------------------------------

/**
 * 挂牌仓储（ListingRepo；Sequelize 实现）。
 * 创建（U(listing_key) 幂等兜底，assetHoldId 经 wallet ledger 同事务取得）+
 * 行锁读 + 活跃挂牌列表（游标分页 + 参考报价）+ 取消（ACTIVE → CANCELLED
 * 守恒变更）。
 */
export class SequelizeListingRepo implements ListingRepo {
  constructor(private readonly model: typeof CoinMarketListingModel) {}

  async createListing(input: {
    sellerUserId: string;
    listingKey: string;
    assetHoldId: string;
    listedCoins: string;
    priceCentsPer1000Coins: string;
    receiveMethod: number;
    receiveSnapshot: Record<string, unknown> | null;
    platformPaymentOptIn: number;
    tx: Tx;
  }): Promise<{ inserted: boolean; listing: CoinMarketListingModel }> {
    const txq = txOf(input.tx);
    // U(listing_key) 幂等兜底：先读既有行，命中 → 返回（inserted: false）
    const existing = await this.model.findOne({
      where: { listingKey: input.listingKey },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (existing !== null) {
      return { inserted: false, listing: existing };
    }
    // 守恒 CHECK：listed = available（reserved / filled / cancelled 全 0）
    const listing = (await this.model.create(
      {
        sellerUserId: input.sellerUserId as never,
        listingKey: input.listingKey,
        assetHoldId: input.assetHoldId as never,
        listedCoins: input.listedCoins,
        availableCoins: input.listedCoins,
        reservedCoins: '0',
        filledCoins: '0',
        cancelledCoins: '0',
        priceCentsPer1000Coins: input.priceCentsPer1000Coins,
        receiveMethod: input.receiveMethod,
        receiveSnapshot: input.receiveSnapshot,
        platformPaymentOptIn: input.platformPaymentOptIn,
        status: CoinMarketListingStatus.ACTIVE,
      } as never,
      { transaction: txq } as never,
    )) as CoinMarketListingModel;
    return { inserted: true, listing };
  }

  async lockListing(listingId: string, tx: Tx): Promise<CoinMarketListingModel | null> {
    const txq = txOf(tx);
    const row = await this.model.findByPk(listingId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    return row;
  }

  async listActiveListings(input: { cursor: string | null; limit: number; tx: Tx }): Promise<{
    items: CoinMarketListingModel[];
    nextCursor: string | null;
    referenceCentsPer1000Coins: string | null;
  }> {
    const txq = txOf(input.tx);
    // 活跃挂牌：status = ACTIVE=1 + availableCoins > 0（可成交）
    const where: Record<string, unknown> = {
      status: CoinMarketListingStatus.ACTIVE,
      availableCoins: { [Op.gt as unknown as string]: '0' } as never,
    };
    const cur = parseCursor(input.cursor);
    if (cur !== null) {
      // 稳定游标：created_at < cursor.createdAt OR (created_at = cursor.createdAt AND id < cursor.id)
      where[Op.and as unknown as string] = [
        { createdAt: { [Op.lt as unknown as string]: cur.createdAt } },
        { createdAt: cur.createdAt, id: { [Op.lt as unknown as string]: cur.id as never } },
      ];
    }
    const items = await this.model.findAll({
      where: where as never,
      order: [
        ['priceCentsPer1000Coins', 'ASC'], // 价格低优先（登记决策点：Lead 确认排序策略）
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: input.limit,
      transaction: txq,
    } as never);
    const last = items.length === input.limit ? items[items.length - 1] : undefined;
    const nextCursor = last !== undefined ? formatCursor(last) : null;
    // 参考报价：本页内最低价（首版纯读集市内最低报价，登记决策点：可经
    // configuration 注入市场基准价）；本页无数据 → null（路由层回退默认值）
    let referenceCentsPer1000Coins: string | null = null;
    for (const row of items) {
      const price = row.priceCentsPer1000Coins;
      if (referenceCentsPer1000Coins === null || BigInt(price) < BigInt(referenceCentsPer1000Coins)) {
        referenceCentsPer1000Coins = price;
      }
    }
    return { items, nextCursor, referenceCentsPer1000Coins };
  }

  async cancelListing(input: { listingId: string; cancelledAt: Date; tx: Tx }): Promise<CoinMarketListingModel | null> {
    const txq = txOf(input.tx);
    const [affected] = await this.model.update(
      {
        status: CoinMarketListingStatus.CANCELLED,
        cancelledAt: input.cancelledAt,
        // 守恒变更：available → cancelled（cancelled += available，available = 0）
      } as never,
      {
        where: {
          id: input.listingId,
          status: CoinMarketListingStatus.ACTIVE,
        },
        transaction: txq,
        lock: txq ? 'FOR UPDATE' : undefined,
      } as never,
    );
    if (affected === 0) {
      // 已 CANCELLED / COMPLETED / 非 ACTIVE → null（用例层映射 TRADE_NOT_ALLOWED /
      // LISTING_NOT_CANCELLABLE；幂等重放由用例层读回既有值判定，本层只落库）
      return null;
    }
    const row = await this.model.findByPk(input.listingId, { transaction: txq } as never);
    if (row === null) {
      throw new CoinMarketDomainError(CM.LISTING_NOT_FOUND, `挂牌不存在：${input.listingId}`);
    }
    // 守恒变更（read-then-write 经行锁保护）：cancelled += available，available = 0
    const currentCancelled = BigInt(row.cancelledCoins);
    const currentAvailable = BigInt(row.availableCoins);
    const nextCancelled = (currentCancelled + currentAvailable).toString();
    await this.model.update(
      {
        cancelledCoins: nextCancelled,
        availableCoins: '0',
      } as never,
      { where: { id: input.listingId }, transaction: txq } as never,
    );
    return this.model.findByPk(input.listingId, { transaction: txq } as never);
  }
}

// ---------------------------------------------------------------------------
// TradeRepo（coin_market_trade）
// ---------------------------------------------------------------------------

/**
 * 交易仓储（TradeRepo；Sequelize 实现）。
 * 创建（U(trade_key) 幂等兜底 + 同事务锁读 listing availableCoins 预占）+
 * 行锁读 + 11 态状态机转换（confirmPayment / expireTrade / releaseToBuyer /
 * cancelTrade，同事务 listing reserved/filled 守恒变更）。
 */
export class SequelizeTradeRepo implements TradeRepo {
  constructor(
    private readonly model: typeof CoinMarketTradeModel,
    private readonly listingModel: typeof CoinMarketListingModel,
  ) {}

  async createTrade(input: {
    listingId: string;
    buyerUserId: string;
    sellerUserId: string;
    tradeKey: string;
    coins: string;
    grossCents: string;
    sellerNetCents: string;
    paymentMethod: number;
    tx: Tx;
  }): Promise<{ inserted: boolean; trade: CoinMarketTradeModel; isNew: boolean }> {
    const txq = txOf(input.tx);
    // U(trade_key) 幂等兜底：先读既有行，命中 → 返回（inserted: false，重放）
    const existing = await this.model.findOne({
      where: { tradeKey: input.tradeKey },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (existing !== null) {
      return { inserted: false, trade: existing, isNew: false };
    }
    // 同事务锁读 listing availableCoins（预占：reserved += coins，available -= coins）
    const listing = await this.listingModel.findByPk(input.listingId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (listing === null) {
      throw new CoinMarketDomainError(CM.LISTING_NOT_FOUND, `挂牌不存在：${input.listingId}`);
    }
    if (listing.status !== CoinMarketListingStatus.ACTIVE) {
      throw new CoinMarketDomainError(CM.LISTING_NOT_CANCELLABLE, `挂牌非 ACTIVE，不可成交：${input.listingId}`, {
        retryable: false,
      });
    }
    const coinsB = BigInt(input.coins);
    const availableB = BigInt(listing.availableCoins);
    if (coinsB <= 0n) {
      throw new CoinMarketDomainError(CM.COINS_INSUFFICIENT, '预占金币数量须为正整数。', { retryable: false });
    }
    if (coinsB > availableB) {
      throw new CoinMarketDomainError(CM.COINS_INSUFFICIENT, '预占金币数量超过挂牌可成交量。', { retryable: false });
    }
    // 预占（守恒变更：reserved += coins，available -= coins）
    const nextReserved = (BigInt(listing.reservedCoins) + coinsB).toString();
    const nextAvailable = (availableB - coinsB).toString();
    await this.listingModel.update(
      {
        reservedCoins: nextReserved,
        availableCoins: nextAvailable,
      } as never,
      { where: { id: listing.id }, transaction: txq } as never,
    );
    // 写交易行 PAYMENT_PENDING=1（payment_deadline_at 经用例层传入）
    const now = new Date();
    const trade = (await this.model.create(
      {
        coinMarketListingId: input.listingId as never,
        buyerUserId: input.buyerUserId as never,
        tradeKey: input.tradeKey,
        coins: input.coins,
        grossCents: input.grossCents,
        paymentMode: input.paymentMethod,
        sellerNetCents: input.sellerNetCents,
        status: CoinMarketTradeStatus.PAYMENT_PENDING,
        paymentDeadlineAt: new Date(now.getTime() + 1800 * 1000), // 首版 30 分钟（PAYMENT_DEADLINE_SECONDS，登记决策点）
        createdAt: now,
      } as never,
      { transaction: txq } as never,
    )) as CoinMarketTradeModel;
    return { inserted: true, trade, isNew: true };
  }

  async lockTrade(tradeId: string, tx: Tx): Promise<CoinMarketTradeModel | null> {
    const txq = txOf(tx);
    const row = await this.model.findByPk(tradeId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    return row;
  }

  async confirmPayment(input: { tradeId: string; confirmedAt: Date; tx: Tx }): Promise<CoinMarketTradeModel | null> {
    const txq = txOf(input.tx);
    // 卖家确认收款（PAYMENT_PENDING=1 → SELLER_CONFIRMATION_PENDING=2）
    // 同事务 listing reserved → filled（reserved -= coins，filled += coins，守恒变更）
    // trade 表无 confirmed_at 列（DDL 权威：paid_at 记录凭证提交时间，
    // 本处 status 推进 + listing 守恒变更；时间戳经 status 列隐含，
    // 登记决策点：Lead 确认是否需 0017 迁移补 confirmed_at 列）
    const [affected] = await this.model.update(
      {
        status: CoinMarketTradeStatus.SELLER_CONFIRMATION_PENDING,
      } as never,
      {
        where: {
          id: input.tradeId,
          status: CoinMarketTradeStatus.PAYMENT_PENDING,
        },
        transaction: txq,
        lock: txq ? 'FOR UPDATE' : undefined,
      } as never,
    );
    if (affected === 0) {
      return null; // 用例层映射 TRADE_NOT_ALLOWED / TRADE_DEADLINE_PASSED（读回既有值判定）
    }
    // 同事务 listing 守恒变更：reserved -= coins，filled += coins
    const trade = await this.model.findByPk(input.tradeId, { transaction: txq } as never);
    if (trade === null) {
      throw new CoinMarketDomainError(CM.TRADE_NOT_FOUND, `交易不存在：${input.tradeId}`);
    }
    const listing = await this.listingModel.findByPk(trade.coinMarketListingId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (listing !== null) {
      const coinsB = BigInt(trade.coins);
      await this.listingModel.update(
        {
          reservedCoins: (BigInt(listing.reservedCoins) - coinsB).toString(),
          filledCoins: (BigInt(listing.filledCoins) + coinsB).toString(),
        } as never,
        { where: { id: listing.id }, transaction: txq } as never,
      );
    }
    return this.model.findByPk(input.tradeId, { transaction: txq } as never);
  }

  async expireTrade(input: { tradeId: string; expiredAt: Date; tx: Tx }): Promise<CoinMarketTradeModel | null> {
    const txq = txOf(input.tx);
    // 付款超时推进（PAYMENT_PENDING=1 → PAYMENT_EXPIRED=9）
    // 同事务 listing reserved → available（reserved -= coins，available += coins，释放预占）
    // trade 表无 expired_at 列（DDL 权威：status 列隐含超时态，登记决策点：
    // Lead 确认是否需 0017 迁移补 expired_at 列）
    const [affected] = await this.model.update(
      {
        status: CoinMarketTradeStatus.PAYMENT_EXPIRED,
      } as never,
      {
        where: {
          id: input.tradeId,
          status: CoinMarketTradeStatus.PAYMENT_PENDING,
        },
        transaction: txq,
        lock: txq ? 'FOR UPDATE' : undefined,
      } as never,
    );
    if (affected === 0) {
      return null; // 用例层映射 TRADE_DEADLINE_PASSED（读回既有值判定幂等）
    }
    const trade = await this.model.findByPk(input.tradeId, { transaction: txq } as never);
    if (trade === null) {
      throw new CoinMarketDomainError(CM.TRADE_NOT_FOUND, `交易不存在：${input.tradeId}`);
    }
    const listing = await this.listingModel.findByPk(trade.coinMarketListingId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (listing !== null) {
      const coinsB = BigInt(trade.coins);
      await this.listingModel.update(
        {
          reservedCoins: (BigInt(listing.reservedCoins) - coinsB).toString(),
          availableCoins: (BigInt(listing.availableCoins) + coinsB).toString(),
        } as never,
        { where: { id: listing.id }, transaction: txq } as never,
      );
    }
    return this.model.findByPk(input.tradeId, { transaction: txq } as never);
  }

  async releaseToBuyer(input: { tradeId: string; releasedAt: Date; tx: Tx }): Promise<CoinMarketTradeModel | null> {
    const txq = txOf(input.tx);
    // 买家确认放币（SELLER_CONFIRMATION_PENDING=2 → RELEASED=7）
    // 幂等重放：已 RELEASED → 静默返回既有值（不产生第二笔）
    // trade 表无 released_at 列（DDL 权威：status 列隐含放币态，登记决策点：
    // Lead 确认是否需 0017 迁移补 released_at 列）
    const [affected] = await this.model.update(
      {
        status: CoinMarketTradeStatus.RELEASED,
      } as never,
      {
        where: {
          id: input.tradeId,
          status: CoinMarketTradeStatus.SELLER_CONFIRMATION_PENDING,
        },
        transaction: txq,
        lock: txq ? 'FOR UPDATE' : undefined,
      } as never,
    );
    if (affected === 0) {
      // 已 RELEASED（幂等重放）→ 读回既有值返回；否则 → null（用例层映射 TRADE_NOT_ALLOWED）
      const row = await this.model.findByPk(input.tradeId, { transaction: txq } as never);
      if (row !== null && row.status === CoinMarketTradeStatus.RELEASED) {
        return row;
      }
      return null;
    }
    return this.model.findByPk(input.tradeId, { transaction: txq } as never);
  }

  async listByBuyer(input: {
    buyerUserId: string;
    cursor: string | null;
    limit: number;
    tx: Tx;
  }): Promise<{ items: CoinMarketTradeModel[]; nextCursor: string | null }> {
    const txq = txOf(input.tx);
    const where: Record<string, unknown> = {
      buyerUserId: input.buyerUserId as never,
    };
    const cur = parseCursor(input.cursor);
    if (cur !== null) {
      where[Op.and as unknown as string] = [
        { createdAt: { [Op.lt as unknown as string]: cur.createdAt } },
        { createdAt: cur.createdAt, id: { [Op.lt as unknown as string]: cur.id as never } },
      ];
    }
    const items = await this.model.findAll({
      where: where as never,
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: input.limit,
      transaction: txq,
    } as never);
    const last = items.length === input.limit ? items[items.length - 1] : undefined;
    const nextCursor = last !== undefined ? formatCursor(last) : null;
    return { items, nextCursor };
  }

  async cancelTrade(input: { tradeId: string; cancelledAt: Date; tx: Tx }): Promise<CoinMarketTradeModel | null> {
    const txq = txOf(input.tx);
    // 买家 / 卖家取消（PAYMENT_PENDING=1 → CANCELLED=11）
    // 同事务 listing reserved → available（reserved -= coins，available += coins，释放预占）
    // 幂等重放：已 CANCELLED → 静默返回既有值（不产生第二笔）
    // trade 表无 cancelled_at 列（DDL 权威：status 列隐含取消态，登记决策点：
    // Lead 确认是否需 0017 迁移补 cancelled_at 列）
    const [affected] = await this.model.update(
      {
        status: CoinMarketTradeStatus.CANCELLED,
      } as never,
      {
        where: {
          id: input.tradeId,
          status: CoinMarketTradeStatus.PAYMENT_PENDING,
        },
        transaction: txq,
        lock: txq ? 'FOR UPDATE' : undefined,
      } as never,
    );
    if (affected === 0) {
      const row = await this.model.findByPk(input.tradeId, { transaction: txq } as never);
      if (row !== null && row.status === CoinMarketTradeStatus.CANCELLED) {
        return row;
      }
      return null;
    }
    const trade = await this.model.findByPk(input.tradeId, { transaction: txq } as never);
    if (trade === null) {
      throw new CoinMarketDomainError(CM.TRADE_NOT_FOUND, `交易不存在：${input.tradeId}`);
    }
    const listing = await this.listingModel.findByPk(trade.coinMarketListingId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (listing !== null) {
      const coinsB = BigInt(trade.coins);
      await this.listingModel.update(
        {
          reservedCoins: (BigInt(listing.reservedCoins) - coinsB).toString(),
          availableCoins: (BigInt(listing.availableCoins) + coinsB).toString(),
        } as never,
        { where: { id: listing.id }, transaction: txq } as never,
      );
    }
    return this.model.findByPk(input.tradeId, { transaction: txq } as never);
  }
}
