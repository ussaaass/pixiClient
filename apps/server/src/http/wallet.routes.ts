/**
 * /api/v1/me/wallet/* 路由（SDD §5.4 wallet 端点：summary/activity/transfers/exchanges）。
 *
 * 路由层职责：请求解析 → 用例调用 → envelope 包装；不含业务规则。
 * 依据：后端实施 SDD §5.4 + §4（锁顺序/幂等）；`packages/backend/src/modules/wallet/`
 * 用例层提供全部领域逻辑。
 *
 * 端点清单（与 contracts/WalletEndpoint 对齐）：
 * - GET  /me/wallet/summary       （需玩家认证）
 * - GET  /me/wallet/activity      （需玩家认证）
 * - POST /me/wallet/transfers/quote  （需玩家认证）
 * - POST /me/wallet/transfers        （需玩家认证，201）
 * - POST /me/wallet/exchanges/quote  （需玩家认证）
 * - POST /me/wallet/exchanges        （需玩家认证，201）
 */

import type { Sequelize, Transaction } from 'sequelize';
import Router from '@koa/router';
import type { Context } from 'koa';
import {
  WalletEndpoint,
  WalletActivityResponseSchema,
  WalletSummaryResponseSchema,
  WalletTransferQuoteSchema,
  WalletTransferResultSchema,
  WalletExchangeQuoteSchema,
  WalletExchangeResultSchema,
} from '@gameing/contracts/wallet';
import type { WalletModule, Tx, OutboxPort } from '@gameing/backend/modules/wallet/public';
import { setSuccess } from '../infrastructure/http/response.js';
import { ApiError } from '../infrastructure/http/error-boundary.js';
import { createPlayerAuthMiddleware, type AuthState } from '../infrastructure/auth/player-auth-middleware.js';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';

function getBody(ctx: Context): Record<string, unknown> {
  return (ctx as unknown as { request: { body?: Record<string, unknown> } }).request.body ?? {};
}

/**
 * 在事务内执行资金用例（SDD §4 "所有分录/outbox 同事务"）：
 * sequelize.transaction → module.withTx 取同事务 OutboxPort → 传入用例 submit。
 * 读用例（summary/activity/quote）直接无事务调用，避免不必要的行锁。
 */
async function submitInTx<T>(
  module: WalletModule,
  sequelize: Sequelize,
  userId: string,
  fn: (tx: Tx, outbox: OutboxPort) => Promise<T>,
): Promise<T> {
  return sequelize.transaction(async (transaction) => {
    const scope: { transaction: Transaction | null } = { transaction };
    const outbox: OutboxPort = await module.withTx(scope, (o) => o);
    const tx: Tx = { transaction };
    return fn(tx, outbox);
  });
}

export function createWalletRoutes(module: WalletModule, identityModule: IdentityModule, sequelize: Sequelize): Router {
  const router = new Router({ prefix: '/me/wallet' });
  const auth = createPlayerAuthMiddleware(identityModule);

  // GET /me/wallet/summary
  router.get('/summary', auth, async (ctx) => {
    const state = ctx.state as AuthState;
    const result = await module.summary.run({ userId: state.userId ?? '' });
    setSuccess(ctx, {
      message: '资产汇总',
      data: result,
      schema: WalletSummaryResponseSchema as never,
      status: WalletEndpoint.summary.successStatus,
    });
  });

  // GET /me/wallet/activity
  router.get('/activity', auth, async (ctx) => {
    const state = ctx.state as AuthState;
    const cursor = (ctx.query.cursor as string) || undefined;
    const result = await module.activity.run({ userId: state.userId ?? '' }, cursor);
    setSuccess(ctx, {
      message: '资产流水',
      data: result,
      schema: WalletActivityResponseSchema as never,
      status: 200,
    });
  });

  // POST /me/wallet/transfers/quote
  router.post('/transfers/quote', auth, async (ctx) => {
    const state = ctx.state as AuthState;
    const body = getBody(ctx);
    if (!body.recipientUserId) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', 'recipientUserId 必填。', { status: 400 });
    }
    const result = await module.transfer.quote({ userId: state.userId ?? '' }, body as never);
    setSuccess(ctx, {
      message: '转账报价',
      data: result,
      schema: WalletTransferQuoteSchema as never,
      status: WalletEndpoint.transferQuote.successStatus,
    });
  });

  // POST /me/wallet/transfers（201；新提交 / 幂等重放均为 201，首版统一）
  router.post('/transfers', auth, async (ctx) => {
    const state = ctx.state as AuthState;
    const body = getBody(ctx);
    const userId = state.userId ?? '';
    const result = await submitInTx(module, sequelize, userId, (tx, outbox) => {
      return module.transfer.submit(
        { userId },
        { userId, request: body as never, tx, outbox },
      );
    });
    setSuccess(ctx, {
      message: '转账成功',
      data: result,
      schema: WalletTransferResultSchema as never,
      status: WalletEndpoint.transfer.successStatus,
    });
  });

  // POST /me/wallet/exchanges/quote
  router.post('/exchanges/quote', auth, async (ctx) => {
    const state = ctx.state as AuthState;
    const body = getBody(ctx);
    const result = await module.exchange.quote({ userId: state.userId ?? '' }, body as never);
    setSuccess(ctx, {
      message: '兑换报价',
      data: result,
      schema: WalletExchangeQuoteSchema as never,
      status: WalletEndpoint.exchangeQuote.successStatus,
    });
  });

  // POST /me/wallet/exchanges（201）
  router.post('/exchanges', auth, async (ctx) => {
    const state = ctx.state as AuthState;
    const body = getBody(ctx);
    const userId = state.userId ?? '';
    const result = await submitInTx(module, sequelize, userId, (tx, outbox) => {
      return module.exchange.submit(
        { userId },
        { userId, request: body as never, tx, outbox },
      );
    });
    setSuccess(ctx, {
      message: '兑换成功',
      data: result,
      schema: WalletExchangeResultSchema as never,
      status: WalletEndpoint.exchange.successStatus,
    });
  });

  return router;
}
