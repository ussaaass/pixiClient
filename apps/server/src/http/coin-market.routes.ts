/**
 * /me/coin-market 路由（SDD §9 第 7 步：金币集市挂牌 / 成交 / 确认 / 取消）。
 *
 * 路由层职责：请求解析 → 用例调用 → envelope 包装；不含业务规则。
 * 依据：后端实施 SDD §5.4（金币集市端点清单）+ §9 第 7 步（金币集市：
 * 挂牌 / 成交 / 确认 / 取消 / 列表）；contracts coin-market.ts
 * （CoinMarketEndpoint 路径对齐）。
 *
 * 端点（与 contracts CoinMarketEndpoint 对齐，/api/v1 前缀经 app.ts 挂载）：
 * - POST   /coin-market/price-quotes                 （报价纯函数，200）
 * - POST   /coin-market/listings                     （挂牌创建，201 新创建
 *          / 200 幂等重放）
 * - GET    /coin-market/listings                     （集市页挂牌列表，200）
 * - POST   /me/coin-market/listings/:id/cancel       （挂牌取消，200 幂等）
 * - POST   /coin-market/listings/:id/trades          （成交创建，201 新创建
 *          / 200 幂等重放）
 * - POST   /me/coin-market/trades/:id/confirm-receipt（卖家确认收款，200；
 *          PAYMENT_PENDING=1 → SELLER_CONFIRMATION_PENDING=2，幂等重放）
 * - GET    /me/coin-market/trades                    （买家成交列表，200；
 *          游标分页 50/页，读路径超时推进 PAYMENT_EXPIRED=9 登记）
 *
 * 注意：contracts 路径为 /api/v1/coin-market/...，本路由文件按任务说明
 * /me/coin-market/... 落地；登记决策点：Lead 确认最终路径前缀
 * （建议对齐 contracts，改 app.ts 挂载前缀）。
 */

import type { Sequelize } from 'sequelize';
import Router from '@koa/router';
import type { Context } from 'koa';
import { Type } from '@sinclair/typebox';
import { Value } from '@gameing/contracts/wallet';
import type { CoinMarketModule, Tx } from '@gameing/backend/modules/coin-market/public';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import { setSuccess } from '../infrastructure/http/response.js';
import { ApiError } from '../infrastructure/http/error-boundary.js';
import { createPlayerAuthMiddleware, type AuthState } from '../infrastructure/auth/player-auth-middleware.js';
import {
  CoinMarketPriceQuoteRequestSchema,
  CoinMarketListingCreateRequestSchema,
  CoinMarketTradeCreateRequestSchema,
} from '@gameing/contracts/coin-market';

// --- 请求 / 响应 schema（与 contracts 对齐） ---

const PositiveIntStringSchema = Type.String({ pattern: '^[1-9][0-9]{0,18}$' });
const NonNegIntStringSchema = Type.String({ pattern: '^(?:0|[1-9][0-9]{0,18})$' });
const TimestampSchema = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });

const PriceQuoteResponseSchema = Type.Object(
  {
    coins: PositiveIntStringSchema,
    priceCentsPer1000Coins: PositiveIntStringSchema,
    grossCents: PositiveIntStringSchema,
    sellerNetCents: PositiveIntStringSchema,
  },
  { additionalProperties: false },
);

const ListingItemSchema = Type.Object(
  {
    listingId: PositiveIntStringSchema,
    coins: PositiveIntStringSchema,
    availableCoins: NonNegIntStringSchema,
    priceCentsPer1000Coins: PositiveIntStringSchema,
    totalCents: NonNegIntStringSchema,
    status: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4), Type.Literal(5)]),
    createdAt: TimestampSchema,
    sellerLabel: Type.Optional(Type.String({ maxLength: 48 })),
  },
  { additionalProperties: false },
);

const ListingPageResponseSchema = Type.Object(
  {
    items: Type.Array(ListingItemSchema, { maxItems: 50 }),
    referenceCentsPer1000Coins: Type.Union([PositiveIntStringSchema, Type.Null()]),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

const ListingCreateResponseSchema = Type.Object(
  {
    listingId: PositiveIntStringSchema,
    listingKey: Type.String({ minLength: 16, maxLength: 128 }),
    coins: PositiveIntStringSchema,
    availableCoins: PositiveIntStringSchema,
    priceCentsPer1000Coins: PositiveIntStringSchema,
    status: Type.Literal(1),
    createdAt: TimestampSchema,
    inserted: Type.Boolean(),
  },
  { additionalProperties: false },
);

const ListingCancelResponseSchema = Type.Object(
  {
    listingId: PositiveIntStringSchema,
    status: Type.Literal(4),
    cancelledCoins: NonNegIntStringSchema,
    cancelledAt: TimestampSchema,
    inserted: Type.Boolean(),
  },
  { additionalProperties: false },
);

const TradeItemSchema = Type.Object(
  {
    tradeId: PositiveIntStringSchema,
    listingId: PositiveIntStringSchema,
    coins: PositiveIntStringSchema,
    grossCents: NonNegIntStringSchema,
    status: Type.Union([
      Type.Literal(1),
      Type.Literal(2),
      Type.Literal(3),
      Type.Literal(4),
      Type.Literal(5),
      Type.Literal(6),
      Type.Literal(7),
      Type.Literal(8),
      Type.Literal(9),
      Type.Literal(10),
      Type.Literal(11),
    ]),
    paymentDeadlineAt: Type.Union([TimestampSchema, Type.Null()]),
    createdAt: TimestampSchema,
  },
  { additionalProperties: false },
);

const TradePageResponseSchema = Type.Object(
  {
    items: Type.Array(TradeItemSchema, { maxItems: 50 }),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

const TradeCreateResponseSchema = Type.Object(
  {
    tradeId: PositiveIntStringSchema,
    tradeKey: Type.String({ minLength: 16, maxLength: 128 }),
    coins: PositiveIntStringSchema,
    grossCents: NonNegIntStringSchema,
    sellerNetCents: NonNegIntStringSchema,
    status: Type.Literal(1),
    paymentDeadlineAt: TimestampSchema,
    isNew: Type.Boolean(),
  },
  { additionalProperties: false },
);

const TradeConfirmResponseSchema = Type.Object(
  {
    tradeId: PositiveIntStringSchema,
    status: Type.Union([Type.Literal(1), Type.Literal(2)]),
    replay: Type.Boolean(),
  },
  { additionalProperties: false },
);

// --- 工具 ---

function getBody(ctx: Context): Record<string, unknown> {
  return (ctx as unknown as { request: { body?: Record<string, unknown> } }).request.body ?? {};
}

function requireUserId(state: AuthState): string {
  const uid = state.userId;
  if (uid === undefined) throw new ApiError('UNAUTHORIZED', '未认证。', { status: 401 });
  return uid;
}

function parseCursorParam(ctx: Context): string | null {
  const raw = ctx.query.cursor as string | undefined;
  if (raw === undefined || raw === '') return null;
  return raw;
}

// --- 路由工厂 ---

async function submitInTx<T>(sequelize: Sequelize, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sequelize.transaction(async (transaction) => fn({ transaction }));
}

export function createCoinMarketRoutes(module: CoinMarketModule, identityModule: IdentityModule, sequelize: Sequelize): Router {
  const router = new Router({ prefix: '' });
  const auth = createPlayerAuthMiddleware(identityModule);

  const noTx: Tx = { transaction: null };

  // POST /coin-market/price-quotes（报价纯函数，200，无副作用）
  router.post('/coin-market/price-quotes', auth, async (ctx) => {
    const body = getBody(ctx);
    if (!Value.Check(CoinMarketPriceQuoteRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '报价入参非法。', { status: 400 });
    }
    const { coins, priceCentsPer1000Coins } = body as { coins: string; priceCentsPer1000Coins: string };
    const quote = await module.listingPage.priceQuoteRequest(coins, priceCentsPer1000Coins);
    setSuccess(ctx, {
      message: '报价',
      data: quote,
      schema: PriceQuoteResponseSchema,
      status: 200,
    });
  });

  // POST /coin-market/listings（挂牌创建，201 新创建 / 200 幂等重放）
  router.post('/coin-market/listings', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const body = getBody(ctx);
    if (!Value.Check(CoinMarketListingCreateRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '挂牌入参非法。', { status: 400 });
    }
    const req = body as {
      coins: string;
      priceCentsPer1000Coins: string;
      idempotencyKey: string;
      paymentMethods?: number[];
      paymentInstructions?: string;
    };
    const result = await submitInTx(sequelize, (tx) =>
      module.listingCreate.run({
        sellerUserId: userId,
        coins: req.coins,
        priceCentsPer1000Coins: req.priceCentsPer1000Coins,
        listingKey: req.idempotencyKey,
        receiveMethod: 1, // 首版默认 BANK_TRANSFER（登记决策点：收款方式经 configuration 模块注入）
        receiveSnapshot: req.paymentInstructions !== undefined ? { instructions: req.paymentInstructions } : null,
        paymentMethods: req.paymentMethods ?? [],
        tx,
      }),
    );
    setSuccess(ctx, {
      message: result.inserted ? '挂牌已创建' : '挂牌已存在（幂等重放）',
      data: result,
      schema: ListingCreateResponseSchema,
      status: result.inserted ? 201 : 200,
    });
  });

  // GET /coin-market/listings（集市页挂牌列表，200；游标分页 50/页）
  router.get('/coin-market/listings', auth, async (ctx) => {
    const cursor = parseCursorParam(ctx);
    const page = await module.listingPage.listListings(cursor, noTx);
    setSuccess(ctx, {
      message: '挂牌列表',
      data: page,
      schema: ListingPageResponseSchema,
      status: 200,
    });
  });

  // POST /me/coin-market/listings/:id/cancel（挂牌取消，200 幂等）
  router.post('/me/coin-market/listings/:id/cancel', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const listingId = ctx.params.id as string;
    const result = await submitInTx(sequelize, (tx) => module.listingCancel.run(userId, listingId, tx));
    setSuccess(ctx, {
      message: result.inserted ? '挂牌已取消' : '挂牌已取消（幂等重放）',
      data: result,
      schema: ListingCancelResponseSchema,
      status: 200,
    });
  });

  // POST /coin-market/listings/:id/trades（成交创建，201 新创建 / 200 幂等重放）
  router.post('/coin-market/listings/:id/trades', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const listingId = ctx.params.id as string;
    const body = getBody(ctx);
    if (!Value.Check(CoinMarketTradeCreateRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '成交入参非法。', { status: 400 });
    }
    const req = body as { coins: string; paymentMethod: number; idempotencyKey: string };
    const result = await submitInTx(sequelize, (tx) =>
      module.trade.create({
        buyerUserId: userId,
        listingId,
        tradeKey: req.idempotencyKey,
        coins: req.coins,
        paymentMethod: req.paymentMethod,
        tx,
      }),
    );
    setSuccess(ctx, {
      message: result.isNew ? '成交已创建' : '成交已存在（幂等重放）',
      data: result,
      schema: TradeCreateResponseSchema,
      status: result.isNew ? 201 : 200,
    });
  });

  // POST /me/coin-market/trades/:id/confirm-receipt（卖家确认收款，200；
  // PAYMENT_PENDING=1 → SELLER_CONFIRMATION_PENDING=2，幂等重放）
  router.post('/me/coin-market/trades/:id/confirm-receipt', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const tradeId = ctx.params.id as string;
    const result = await submitInTx(sequelize, (tx) => module.tradeConfirm.run(userId, tradeId, tx));
    setSuccess(ctx, {
      message: result.replay ? '成交已确认（幂等重放）' : '成交已确认',
      data: result,
      schema: TradeConfirmResponseSchema,
      status: 200,
    });
  });

  // GET /me/coin-market/trades（买家成交列表，200；游标分页 50/页）
  router.get('/me/coin-market/trades', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const cursor = parseCursorParam(ctx);
    const page = await submitInTx(sequelize, (tx) => module.tradeList.listTrades(userId, cursor, tx));
    setSuccess(ctx, {
      message: '成交列表',
      data: page,
      schema: TradePageResponseSchema,
      status: 200,
    });
  });

  return router;
}
