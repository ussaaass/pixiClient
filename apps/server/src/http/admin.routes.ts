/**
 * /admin-api/v1 路由（SDD §9 第 9 步：Admin 全量切换收口；/admin-api/v1
 * 域端点，经 Admin audience 鉴权中间件保护）。
 *
 * 路由层职责：请求解析 → 用例调用 → envelope 包装；不含业务规则。
 * 依据：后端实施 SDD §7.3（工作区 ↔ Admin API 映射）、§5.3
 * （Admin API 前缀 /admin-api/v1）+ §9 第 9 步（Admin 全量切换收口）；
 * admin-contracts admin-users / agent-domain-review / admin-audit
 * （DTO schema 路由层 wire 对齐）。
 *
 * 端点（/admin-api/v1 前缀，经 createAdminAuthMiddleware 保护）：
 * - POST   /admin-api/v1/auth/login                 （200；Admin
 *          audience 令牌 + HttpOnly refresh cookie；不挂载鉴权中间件，
 *          登录前置）
 * - POST   /admin-api/v1/audit                      （201 新写 / 200
 *          幂等重放；request_key 幂等 + snapshot 脱敏）
 * - POST   /admin-api/v1/agent-domains/:id/approve   （200；
 *          PENDING_REVIEW=1 → ACTIVE=2，幂等重放）
 * - POST   /admin-api/v1/agent-domains/:id/suspend   （200；
 *          ACTIVE=2 → SUSPENDED=3）
 * - POST   /admin-api/v1/agent-domains/:id/revoke    （200；
 *          → REVOKED=4，实体保留供审计）
 * - POST   /admin-api/v1/coin-market/trades/:id/adjudicate
 *                                               （200；DISPUTE 态
 *          3/4/5/6 → RELEASED=7 / RESOLVED_RETURN=10；
 *          support_conversation 关联）
 * - POST   /admin-api/v1/ai-assets/jobs/:id/review   （200；
 *          REVIEW_REQUIRED=6 → SUCCEEDED=3 / FAILED=4）
 * - GET    /admin-api/v1/admin-users                 （200；游标分页
 *          50/页；筛选 userId / username / roleType / status）
 * - GET    /admin-api/v1/admin-users/:id             （200；?section=
 *          OVERVIEW/SECURITY/REFERRAL/ASSETS/GAMES/SOCIAL）
 * - POST   /admin-api/v1/withdrawals/:id/approve     （200；
 *          REQUESTED=1/REVIEWING=2 → APPROVED=3；双人复核
 *          operated_by ≠ approved_by 服务端强制）
 * - POST   /admin-api/v1/withdrawals/:id/reject      （200；
 *          → REJECTED=6）
 *
 * 注意：本路由工厂返回 2 个 Router（login 路由 + 受鉴权保护的
 * admin 路由）；login 路由不挂载鉴权中间件（登录前置），其余端点
 * 经 createAdminAuthMiddleware 三重门禁（Bearer 验签 Admin audience
 * + Redis admin session + auth_version）。app.ts 挂载条件
 * identityModule + adminModule + sequelize 均就绪。
 */

import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize';
import Router from '@koa/router';
import type { Context } from 'koa';
import { Type } from '@sinclair/typebox';
import type { AdminModule, Tx } from '@gameing/backend/modules/admin/public';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import { setSuccess } from '../infrastructure/http/response.js';
import { ApiError } from '../infrastructure/http/error-boundary.js';
import { createAdminAuthMiddleware, type AdminAuthState } from '../infrastructure/auth/admin-auth-middleware.js';

// --- 工具 ---

function getBody(ctx: Context): Record<string, unknown> {
  return (ctx as unknown as { request: { body?: Record<string, unknown> } }).request.body ?? {};
}

function requireAdminId(state: AdminAuthState): string {
  const uid = state.adminUserId;
  if (uid === undefined) throw new ApiError('AD_ADMIN_UNAUTHORIZED', '未认证。', { status: 401 });
  return uid;
}

function parseCursorParam(ctx: Context): string | null {
  const raw = ctx.query.cursor as string | undefined;
  if (raw === undefined || raw === '') return null;
  return raw;
}

/** 路径参数（:id）取 string；Koa Router 未声明参数时可能 undefined（登记：路由模板已声明 :id）。 */
function paramId(ctx: Context): string {
  const raw = (ctx.params as Record<string, string | undefined>).id;
  if (raw === undefined) throw new ApiError('REQUEST_VALIDATION_FAILED', '缺少路径参数 id。', { status: 400 });
  return raw;
}

// --- 请求 / 响应 schema（与 admin-contracts 对齐；脱敏最小负载） ---

const TimestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const IdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });

const AdminLoginResponseSchema = Type.Object(
  {
    adminUserId: IdSchema,
    accessToken: Type.String({ minLength: 1 }),
    refreshToken: Type.String({ minLength: 1 }),
    sessionKey: Type.String({ minLength: 1 }),
    expiresAt: TimestampSchema,
  },
  { additionalProperties: false },
);

const AgentDomainActionResponseSchema = Type.Object(
  {
    domainId: IdSchema,
    status: Type.Union([
      Type.Literal(1),
      Type.Literal(2),
      Type.Literal(3),
      Type.Literal(4),
      Type.Literal(5),
    ]),
    approvedAt: Type.Union([TimestampSchema, Type.Null()]),
    suspendedAt: Type.Union([TimestampSchema, Type.Null()]),
    revokedAt: Type.Union([TimestampSchema, Type.Null()]),
    inserted: Type.Boolean(),
  },
  { additionalProperties: true }, // approvedAt / suspendedAt / revokedAt 按操作类型择一回传
);

const AdminAuditResponseSchema = Type.Object(
  {
    auditId: Type.String({ minLength: 1, maxLength: 128 }),
    requestKey: Type.String({ minLength: 1, maxLength: 160 }),
    actionCode: Type.String({ minLength: 1, maxLength: 128 }),
    resultType: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    createdAt: TimestampSchema,
    inserted: Type.Boolean(),
  },
  { additionalProperties: false },
);

const TradeAdjudicatedResponseSchema = Type.Object(
  {
    tradeId: IdSchema,
    status: Type.Union([Type.Literal(7), Type.Literal(10)]),
    resolutionCode: Type.Union([Type.Literal(1), Type.Literal(2), Type.Null()]),
    adjudicatedAt: Type.Union([TimestampSchema, Type.Null()]),
    supportConversationId: Type.Union([IdSchema, Type.Null()]),
    inserted: Type.Boolean(),
  },
  { additionalProperties: false },
);

const AiJobReviewedResponseSchema = Type.Object(
  {
    jobId: IdSchema,
    status: Type.Union([Type.Literal(3), Type.Literal(4)]),
    completedAt: Type.Union([TimestampSchema, Type.Null()]),
    inserted: Type.Boolean(),
  },
  { additionalProperties: false },
);

const AdminUserItemSchema = Type.Object(
  {
    userId: IdSchema,
    username: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    nickname: Type.String({ minLength: 1, maxLength: 64 }),
    roleType: Type.Union([Type.Literal(1), Type.Literal(3), Type.Literal(4), Type.Literal(8)]),
    status: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    parent1UserId: Type.Union([IdSchema, Type.Null()]),
    createdAt: TimestampSchema,
    source: Type.Literal(2),
  },
  { additionalProperties: false },
);

const AdminUserListResponseSchema = Type.Object(
  {
    items: Type.Array(AdminUserItemSchema, { maxItems: 50 }),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

const AdminUserDetailResponseSchema = Type.Union([
  Type.Object(
    {
      section: Type.Literal('OVERVIEW'),
      data: Type.Object(
        {
          user: AdminUserItemSchema,
          rewardType: Type.Union([Type.Literal(1), Type.Literal(2)]),
          publicCode: Type.String({ minLength: 4, maxLength: 32 }),
          emailMasked: Type.Union([Type.String({ maxLength: 254 }), Type.Null()]),
          emailVerified: Type.Boolean(),
          phoneMasked: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
          phoneVerified: Type.Boolean(),
          lastLoginAt: Type.Union([TimestampSchema, Type.Null()]),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  // SECURITY / REFERRAL / ASSETS / GAMES / SOCIAL section 首版占位
  // （登记决策点：跨模块读路径归 §9 第 9 步后续运维闭环），
  // 经 additionalProperties: true 宽松 schema 承接。
  Type.Object(
    {
      section: Type.Union([
        Type.Literal('SECURITY'),
        Type.Literal('REFERRAL'),
        Type.Literal('ASSETS'),
        Type.Literal('GAMES'),
        Type.Literal('SOCIAL'),
      ]),
      data: Type.Object({ userId: IdSchema, source: Type.Literal(2) }, { additionalProperties: true }),
    },
    { additionalProperties: false },
  ),
]);

const WithdrawalApprovedResponseSchema = Type.Object(
  {
    withdrawalId: IdSchema,
    status: Type.Literal(3),
    approvedAt: Type.Union([TimestampSchema, Type.Null()]),
    inserted: Type.Boolean(),
  },
  { additionalProperties: false },
);

const WithdrawalRejectedResponseSchema = Type.Object(
  {
    withdrawalId: IdSchema,
    status: Type.Literal(6),
    failureReason: Type.String({ minLength: 1, maxLength: 500 }),
    inserted: Type.Boolean(),
  },
  { additionalProperties: false },
);

// --- 路由工厂 ---

/**
 * 创建 /admin-api/v1 路由（2 个 Router：login 无鉴权 + admin 受鉴权）。
 *
 * 挂载条件（app.ts）：identityModule + adminModule + sequelize 均就绪；
 * 鉴权中间件 createAdminAuthMiddleware（Bearer 验签 Admin audience
 * + Redis admin session + auth_version 三重门禁，与 player 中间件
 * 同款纪律，区别仅 audience='admin'）。
 */
export function createAdminRoutes(
  module: AdminModule,
  identityModule: IdentityModule,
  _sequelize: Sequelize,
): { login: Router; admin: Router } {
  const noTx: Tx = { transaction: null };

  // --- login 路由（不挂载鉴权中间件；登录前置） ---
  const login = new Router({ prefix: '' });

  login.post('/admin-api/v1/auth/login', async (ctx) => {
    const body = getBody(ctx);
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (username === '' || password === '') {
      throw new ApiError('REQUEST_VALIDATION_FAILED', 'username / password 必填。', { status: 400 });
    }
    const totpCode = typeof body.totpCode === 'string' ? body.totpCode : undefined;
    const result = await module.adminLogin.run({
      username,
      password,
      totpCode,
      tx: noTx,
    });
    // 登记决策点：Admin audience JWT 签发 + Redis admin session +
    // HttpOnly refresh cookie 经路由层调用 identity ports（首版占位，
    // 经 §9 第 9 步后续运维闭环）
    setSuccess(ctx, {
      message: 'Admin 已登录',
      data: result,
      schema: AdminLoginResponseSchema,
      status: 200,
    });
  });

  // --- admin 路由（经 Admin 鉴权中间件三重门禁保护） ---
  const admin = new Router({ prefix: '' });
  const auth = createAdminAuthMiddleware(identityModule, module);

  // POST /admin-api/v1/audit（201 新写 / 200 幂等重放；request_key 幂等）
  admin.post('/admin-api/v1/audit', auth, async (ctx) => {
    const adminUserId = requireAdminId(ctx.state as AdminAuthState);
    const body = getBody(ctx);
    const requestKey =
      typeof body.requestKey === 'string' && body.requestKey !== ''
        ? body.requestKey
        : `admin:${randomUUID()}`;
    const result = await module.adminAudit.run({
      adminUserId,
      adminSessionKey: ctx.state.sid ?? null,
      userId: typeof body.userId === 'string' ? body.userId : null,
      targetAdminUserId: typeof body.targetAdminUserId === 'string' ? body.targetAdminUserId : null,
      assetOperationId: typeof body.assetOperationId === 'string' ? body.assetOperationId : null,
      withdrawalId: typeof body.withdrawalId === 'string' ? body.withdrawalId : null,
      systemConfigId: typeof body.systemConfigId === 'string' ? body.systemConfigId : null,
      gameConfigId: typeof body.gameConfigId === 'string' ? body.gameConfigId : null,
      agentDomainId: typeof body.agentDomainId === 'string' ? body.agentDomainId : null,
      referralBindingEventId: typeof body.referralBindingEventId === 'string' ? body.referralBindingEventId : null,
      supportConversationId: typeof body.supportConversationId === 'string' ? body.supportConversationId : null,
      coinMarketTradeId: typeof body.coinMarketTradeId === 'string' ? body.coinMarketTradeId : null,
      requestKey,
      actionCode: typeof body.actionCode === 'string' ? body.actionCode : 'ADMIN_EVENT',
      resultType: typeof body.resultType === 'number' ? body.resultType : 1,
      reason: typeof body.reason === 'string' && body.reason !== '' ? body.reason : 'Admin 操作审计。',
      snapshot: (typeof body.snapshot === 'object' && body.snapshot !== null ? body.snapshot : {}) as Record<string, unknown>,
      ipHashHex: '0'.repeat(64), // 登记决策点：KMS 带密钥摘要未闭环，首版占位 32 字节零
      tx: noTx,
    });
    setSuccess(ctx, {
      message: result.inserted ? '审计已记录' : '审计已存在（幂等重放）',
      data: result,
      schema: AdminAuditResponseSchema,
      status: result.inserted ? 201 : 200,
    });
  });

  // POST /admin-api/v1/agent-domains/:id/approve（200；PENDING_REVIEW=1 → ACTIVE=2）
  admin.post('/admin-api/v1/agent-domains/:id/approve', auth, async (ctx) => {
    const adminUserId = requireAdminId(ctx.state as AdminAuthState);
    const domainId = paramId(ctx);
    const body = getBody(ctx);
    const result = await module.agentDomainApprove.run({
      domainId,
      adminUserId,
      requestKey: typeof body.requestKey === 'string' && body.requestKey !== '' ? body.requestKey : `agent-domain:${domainId}:approve`,
      snapshot: (typeof body.snapshot === 'object' && body.snapshot !== null ? body.snapshot : {}) as Record<string, unknown>,
      tx: noTx,
    });
    setSuccess(ctx, {
      message: result.inserted ? '代理域已审批' : '代理域已审批（幂等重放）',
      data: result,
      schema: AgentDomainActionResponseSchema,
      status: 200,
    });
  });

  // POST /admin-api/v1/agent-domains/:id/suspend（200；ACTIVE=2 → SUSPENDED=3）
  admin.post('/admin-api/v1/agent-domains/:id/suspend', auth, async (ctx) => {
    const adminUserId = requireAdminId(ctx.state as AdminAuthState);
    const domainId = paramId(ctx);
    const body = getBody(ctx);
    const result = await module.agentDomainSuspend.run({
      domainId,
      adminUserId,
      requestKey: typeof body.requestKey === 'string' && body.requestKey !== '' ? body.requestKey : `agent-domain:${domainId}:suspend`,
      snapshot: (typeof body.snapshot === 'object' && body.snapshot !== null ? body.snapshot : {}) as Record<string, unknown>,
      tx: noTx,
    });
    setSuccess(ctx, {
      message: result.inserted ? '代理域已暂停' : '代理域已暂停（幂等重放）',
      data: result,
      schema: AgentDomainActionResponseSchema,
      status: 200,
    });
  });

  // POST /admin-api/v1/agent-domains/:id/revoke（200；→ REVOKED=4）
  admin.post('/admin-api/v1/agent-domains/:id/revoke', auth, async (ctx) => {
    const adminUserId = requireAdminId(ctx.state as AdminAuthState);
    const domainId = paramId(ctx);
    const body = getBody(ctx);
    const result = await module.agentDomainRevoke.run({
      domainId,
      adminUserId,
      requestKey: typeof body.requestKey === 'string' && body.requestKey !== '' ? body.requestKey : `agent-domain:${domainId}:revoke`,
      snapshot: (typeof body.snapshot === 'object' && body.snapshot !== null ? body.snapshot : {}) as Record<string, unknown>,
      tx: noTx,
    });
    setSuccess(ctx, {
      message: result.inserted ? '代理域已撤销' : '代理域已撤销（幂等重放）',
      data: result,
      schema: AgentDomainActionResponseSchema,
      status: 200,
    });
  });

  // POST /admin-api/v1/coin-market/trades/:id/adjudicate（200；
  // DISPUTE 态 → RELEASED=7 / RESOLVED_RETURN=10）
  admin.post('/admin-api/v1/coin-market/trades/:id/adjudicate', auth, async (ctx) => {
    const adminUserId = requireAdminId(ctx.state as AdminAuthState);
    const tradeId = paramId(ctx);
    const body = getBody(ctx);
    const resolutionCode = typeof body.resolutionCode === 'number' ? body.resolutionCode : 0;
    const result = await module.coinMarketAdjudicate.run({
      tradeId,
      adminUserId,
      resolutionCode,
      resolutionNote: typeof body.resolutionNote === 'string' ? body.resolutionNote : '',
      requestKey:
        typeof body.requestKey === 'string' && body.requestKey !== ''
          ? body.requestKey
          : `coin-market:${tradeId}:adjudicate:${resolutionCode}`,
      snapshot: (typeof body.snapshot === 'object' && body.snapshot !== null ? body.snapshot : {}) as Record<string, unknown>,
      tx: noTx,
    });
    setSuccess(ctx, {
      message: result.inserted ? '争议已裁决' : '争议已裁决（幂等重放）',
      data: result,
      schema: TradeAdjudicatedResponseSchema,
      status: 200,
    });
  });

  // POST /admin-api/v1/ai-assets/jobs/:id/review（200；
  // REVIEW_REQUIRED=6 → SUCCEEDED=3 / FAILED=4）
  admin.post('/admin-api/v1/ai-assets/jobs/:id/review', auth, async (ctx) => {
    const adminUserId = requireAdminId(ctx.state as AdminAuthState);
    const jobId = paramId(ctx);
    const body = getBody(ctx);
    const decision = body.decision === 2 ? 2 : 1;
    const result = await module.aiAssetsReview.run({
      jobId,
      adminUserId,
      decision: decision as 1 | 2,
      requestKey:
        typeof body.requestKey === 'string' && body.requestKey !== ''
          ? body.requestKey
          : `ai-asset:${jobId}:review:${decision}`,
      snapshot: (typeof body.snapshot === 'object' && body.snapshot !== null ? body.snapshot : {}) as Record<string, unknown>,
      tx: noTx,
    });
    setSuccess(ctx, {
      message: result.inserted ? 'AI 素材已审核' : 'AI 素材已审核（幂等重放）',
      data: result,
      schema: AiJobReviewedResponseSchema,
      status: 200,
    });
  });

  // GET /admin-api/v1/admin-users（200；游标分页 50/页；筛选 query）
  admin.get('/admin-api/v1/admin-users', auth, async (ctx) => {
    const cursor = parseCursorParam(ctx);
    const userId = ctx.query.userId as string | undefined;
    const username = ctx.query.username as string | undefined;
    const roleTypeRaw = ctx.query.roleType as string | undefined;
    const statusRaw = ctx.query.status as string | undefined;
    const roleType = roleTypeRaw !== undefined && roleTypeRaw !== '' ? Number(roleTypeRaw) : undefined;
    const status = statusRaw !== undefined && statusRaw !== '' ? Number(statusRaw) : undefined;
    const page = await module.adminUserList.list({
      cursor,
      filters: { userId, username, roleType, status },
      tx: noTx,
    });
    setSuccess(ctx, {
      message: 'Admin 用户列表',
      data: page,
      schema: AdminUserListResponseSchema,
      status: 200,
    });
  });

  // GET /admin-api/v1/admin-users/:id（200；?section= 枚举）
  admin.get('/admin-api/v1/admin-users/:id', auth, async (ctx) => {
    const userId = paramId(ctx);
    const section = (ctx.query.section as string | undefined) ?? 'OVERVIEW';
    const result = await module.adminUserDetail.run({ userId, section, tx: noTx });
    setSuccess(ctx, {
      message: 'Admin 用户详情',
      data: result,
      schema: AdminUserDetailResponseSchema,
      status: 200,
    });
  });

  // POST /admin-api/v1/withdrawals/:id/approve（200；双人复核服务端强制）
  admin.post('/admin-api/v1/withdrawals/:id/approve', auth, async (ctx) => {
    const adminUserId = requireAdminId(ctx.state as AdminAuthState);
    const withdrawalId = paramId(ctx);
    const body = getBody(ctx);
    const result = await module.withdrawalReview.approve({
      withdrawalId,
      approvedBy: adminUserId,
      // 登记决策点：operated_by 经 withdrawal.asset_operation_id 反查
      // asset_operation.operated_by_admin_user_id（首版经路由层传 null，
      // 登记 DDL CHECK ck_asset_operation_reviewer 兜底）
      operatedBy: typeof body.operatedBy === 'string' ? body.operatedBy : null,
      requestKey:
        typeof body.requestKey === 'string' && body.requestKey !== ''
          ? body.requestKey
          : `withdrawal:${withdrawalId}:approve`,
      snapshot: (typeof body.snapshot === 'object' && body.snapshot !== null ? body.snapshot : {}) as Record<string, unknown>,
      tx: noTx,
    });
    setSuccess(ctx, {
      message: result.inserted ? '提现已审批' : '提现已审批（幂等重放）',
      data: result,
      schema: WithdrawalApprovedResponseSchema,
      status: 200,
    });
  });

  // POST /admin-api/v1/withdrawals/:id/reject（200；→ REJECTED=6）
  admin.post('/admin-api/v1/withdrawals/:id/reject', auth, async (ctx) => {
    const adminUserId = requireAdminId(ctx.state as AdminAuthState);
    const withdrawalId = paramId(ctx);
    const body = getBody(ctx);
    const result = await module.withdrawalReview.reject({
      withdrawalId,
      approvedBy: adminUserId,
      failureReason: typeof body.failureReason === 'string' ? body.failureReason : '',
      requestKey:
        typeof body.requestKey === 'string' && body.requestKey !== ''
          ? body.requestKey
          : `withdrawal:${withdrawalId}:reject`,
      snapshot: (typeof body.snapshot === 'object' && body.snapshot !== null ? body.snapshot : {}) as Record<string, unknown>,
      tx: noTx,
    });
    setSuccess(ctx, {
      message: result.inserted ? '提现已驳回' : '提现已驳回（幂等重放）',
      data: result,
      schema: WithdrawalRejectedResponseSchema,
      status: 200,
    });
  });

  return { login, admin };
}
