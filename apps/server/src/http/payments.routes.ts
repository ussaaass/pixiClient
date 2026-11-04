/**
 * /api/v1/me 支付与提现路由（SDD §5.4 payments 端点）。
 *
 * 路由层职责：请求解析 → 用例调用 → envelope 包装；不含业务规则。
 * 依据：后端实施 SDD §5.4（payments 端点清单）+ §4（锁顺序/幂等/同事务 outbox）。
 *
 * 端点（与 contracts WalletEndpoint + WalletFundingEndpoint 对齐）：
 * - GET    /me/payment-channels
 * - GET    /me/wallet/orders
 * - POST   /me/wallet/orders                 （201 新建 / 200 幂等重放）
 * - GET    /me/wallet/payout-accounts
 * - POST   /me/wallet/payout-accounts        （201 / 200 重放）
 * - DELETE /me/wallet/payout-accounts/:id
 * - POST   /me/wallet/withdrawals/quote
 * - GET    /me/wallet/withdrawals
 * - POST   /me/wallet/withdrawals            （201 / 200 重放）
 * - POST   /me/wallet/withdrawals/:id/cancel
 *
 * 出款状态机推进（REVIEWING→APPROVED→PAYING→…）与 Admin 审核端点归 §9 第 9 步；
 * 出款 worker（payout_attempt）随 §6.3 outbox 管线落地。
 */

import type { Sequelize, Transaction } from 'sequelize';
import Router from '@koa/router';
import type { Context } from 'koa';
import { Type } from '@sinclair/typebox';
import {
  WalletEndpoint,
  WithdrawalQuoteSchema,
  WithdrawalListSchema,
  WithdrawalSchema,
  CreatePayoutAccountRequestSchema,
  PayoutAccountSchema,
} from '@gameing/contracts/wallet';
import { FundingChannelListResponseSchema, FundingOrderDtoSchema, FundingOrderListResponseSchema, CreateFundingOrderRequestSchema } from '@gameing/contracts/wallet-funding';
import type { WithdrawalQuoteRequestDto } from '@gameing/contracts/wallet';
import type {
  PaymentsModule,
  Tx,
  OutboxPort,
} from '@gameing/backend/modules/payments/public';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import { setSuccess } from '../infrastructure/http/response.js';
import { ApiError } from '../infrastructure/http/error-boundary.js';
import { createPlayerAuthMiddleware, type AuthState } from '../infrastructure/auth/player-auth-middleware.js';
import { Value } from '@gameing/contracts/wallet';

/** 响应 schema：deletePayoutAccount（{deleted:boolean}）*/
const DeletePayoutAccountResponseSchema = Type.Object({ deleted: Type.Boolean() }, { additionalProperties: false });

function getBody(ctx: Context): Record<string, unknown> {
  return (ctx as unknown as { request: { body?: Record<string, unknown> } }).request.body ?? {};
}

function requireUserId(state: AuthState): string {
  const uid = state.userId;
  if (uid === undefined) throw new ApiError('UNAUTHORIZED', '未认证。', { status: 401 });
  return uid;
}

async function submitInTx<T>(module: PaymentsModule, sequelize: Sequelize, fn: (tx: Tx, outbox: OutboxPort) => Promise<T>): Promise<T> {
  return sequelize.transaction(async (transaction) => {
    const scope: { transaction: Transaction | null } = { transaction };
    const outbox: OutboxPort = await module.withTx(scope, (o) => o);
    const tx: Tx = { transaction };
    return fn(tx, outbox);
  });
}

export function createPaymentsRoutes(module: PaymentsModule, identityModule: IdentityModule, sequelize: Sequelize): Router {
  const router = new Router({ prefix: '' });
  const auth = createPlayerAuthMiddleware(identityModule);

  // GET /me/payment-channels
  router.get('/me/payment-channels', auth, async (ctx) => {
    const channels = await module.channels.listEnabledChannelsByMethod();
    // 映射 ChannelView → FundingChannelDto（contract DTO 契约字段）
    const result = channels.map((c) => ({
      channelId: c.channelCode,
      displayName: c.displayName,
      paymentMethod: c.methodType,
      sortOrder: c.priority,
      status: 1, // FundingChannelStatus.ENABLED
    }));
    setSuccess(ctx, {
      message: '可用充值渠道',
      data: result,
      schema: FundingChannelListResponseSchema as never,
      status: 200,
    });
  });

  // GET /me/wallet/orders
  router.get('/me/wallet/orders', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const result = await module.orders.listByUser(userId, 50);
    setSuccess(ctx, {
      message: '充值订单列表',
      data: result,
      schema: FundingOrderListResponseSchema as never,
      status: 200,
    });
  });

  // POST /me/wallet/orders（201 新建 / 200 幂等重放）
  router.post('/me/wallet/orders', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const body = getBody(ctx);
    if (!Value.Check(CreateFundingOrderRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体 schema 校验失败。', { status: 400 });
    }
    const result = await submitInTx(module, sequelize, async (tx, outbox) => {
      void outbox;
      return module.orderCreate.createOrder({ userId, request: body as never, tx });
    });
    setSuccess(ctx, {
      message: result.inserted ? '订单已创建' : '订单已存在（幂等重放）',
      data: result.dto,
      schema: FundingOrderDtoSchema as never,
      status: result.inserted ? 201 : 200,
    });
  });

  // GET /me/wallet/payout-accounts
  router.get('/me/wallet/payout-accounts', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const result = await module.payoutAccounts.list(userId);
    setSuccess(ctx, {
      message: '收款账户列表',
      data: result,
      schema: PayoutAccountSchema as never,
      status: WalletEndpoint.payoutAccounts.successStatus,
    });
  });

  // POST /me/wallet/payout-accounts（201 / 200 重放）
  router.post('/me/wallet/payout-accounts', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const body = getBody(ctx);
    if (!Value.Check(CreatePayoutAccountRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体 schema 校验失败。', { status: 400 });
    }
    const request = body as never;
    const result = await submitInTx(module, sequelize, async (tx, outbox) => {
      void outbox;
      return module.payoutAccounts.create({ userId, request, tx });
    });
    setSuccess(ctx, {
      message: result.inserted ? '收款账户已创建' : '收款账户已存在（幂等重放）',
      data: result.dto,
      schema: PayoutAccountSchema as never,
      status: result.inserted ? 201 : 200,
    });
  });

  // DELETE /me/wallet/payout-accounts/:payoutAccountId
  router.delete('/me/wallet/payout-accounts/:payoutAccountId', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const payoutAccountId = ctx.params.payoutAccountId;
    if (payoutAccountId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });
    const result = await module.payoutAccounts.remove({ userId, payoutAccountId, tx: { transaction: null } });
    setSuccess(ctx, {
      message: '收款账户已删除',
      data: result,
      schema: DeletePayoutAccountResponseSchema,
      status: WalletEndpoint.deletePayoutAccount.successStatus,
    });
  });

  // POST /me/wallet/withdrawals/quote
  router.post('/me/wallet/withdrawals/quote', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const body = getBody(ctx);
    const request = body as unknown as WithdrawalQuoteRequestDto;
    const result = await module.withdrawal.quote(userId, request);
    setSuccess(ctx, {
      message: '提现报价',
      data: result,
      schema: WithdrawalQuoteSchema as never,
      status: WalletEndpoint.withdrawalQuote.successStatus,
    });
  });

  // GET /me/wallet/withdrawals
  router.get('/me/wallet/withdrawals', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const result = await module.withdrawals.listByUser(userId, 50);
    setSuccess(ctx, {
      message: '提现记录',
      data: result,
      schema: WithdrawalListSchema as never,
      status: WalletEndpoint.withdrawals.successStatus,
    });
  });

  // POST /me/wallet/withdrawals（201 新建 / 200 幂等重放）
  router.post('/me/wallet/withdrawals', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const body = getBody(ctx);
    const result = await submitInTx(module, sequelize, async (tx, outbox) => {
      return module.withdrawal.create(userId, { userId, request: body as never, tx, outbox });
    });
    setSuccess(ctx, {
      message: result.inserted ? '提现申请已提交' : '提现申请已存在（幂等重放）',
      data: result.dto,
      schema: WithdrawalSchema as never,
      status: result.inserted ? 201 : 200,
    });
  });

  // POST /me/wallet/withdrawals/:withdrawalId/cancel
  router.post('/me/wallet/withdrawals/:withdrawalId/cancel', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const withdrawalId = ctx.params.withdrawalId;
    if (withdrawalId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });
    const result = await submitInTx(module, sequelize, async (tx, outbox) => {
      return module.withdrawalCancel.cancel(userId, { userId, withdrawalId, tx, outbox });
    });
    setSuccess(ctx, {
      message: '提现已取消，占款已释放',
      data: result.dto,
      schema: WithdrawalSchema as never,
      status: WalletEndpoint.cancelWithdrawal.successStatus,
    });
  });

  return router;
}
