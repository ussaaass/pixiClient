/**
 * /api/v1/me/referral + /me/agent-domain + /public/referral-attribution 路由
 *（SDD §5.4 referral + invite-agent 端点）。
 *
 * 路由层职责：请求解析 → 用例调用 → envelope 包装；不含业务规则。
 * 依据：后端实施 SDD §5.4（referral 端点清单）+ §9 第 6 步（邀请归因返佣：
 * 五级 10/8/5/3、归因幂等、域隔离、代理域申请 + 查询）；
 * docs/04_domains/邀请归因返佣与数据规范.md（已登录用户读取 / 签发邀请
 * 链接，有效期内幂等；直属列表只返回实际建立的绑定关系；返佣明细
 * 以 referral_reward_allocation 为事实源）。
 *
 * 端点（与 contracts referral.ts + invite-agent.ts 对齐）：
 * - GET    /me/invite-link                         （读取邀请链接，200；
 *          无有效链接返回 200 + null）
 * - POST   /me/invite-link                         （签发邀请链接，201 新签
 *          发 / 200 幂等重放）
 * - GET    /me/referrals/direct-invitees           （直属下级列表，200；
 *          游标分页 50/页）
 * - GET    /me/referrals/rewards                   （返佣明细列表，200；
 *          游标分页 50/页，?rewardType=1|2）
 * - POST   /me/agent-domain/apply                   （申请代理域，201 新申请
 *          / 200 幂等重放）
 * - GET    /me/agent-domain                        （查询代理域，200；
 *          无行返回 200 + null）
 * - POST   /public/referral-attribution/candidate    （归因候选暂存，200；
 *          首版无 Redis 时返回 captured: false，登记扩展点）
 *
 * 注意：contracts 路径为 /api/v1/me/agent-domain/application，本路由文件
 * 按 SDD 任务说明 /me/agent-domain/apply + /me/agent-domain 落地；登记
 * 决策点：Lead 确认最终路径（建议对齐 contracts，改 app.ts 挂载前缀）。
 */

import type { Sequelize } from 'sequelize';
import Router from '@koa/router';
import type { Context } from 'koa';
import { Type } from '@sinclair/typebox';
import { Value } from '@gameing/contracts/wallet';
import type { ReferralModule, Tx } from '@gameing/backend/modules/referral/public';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import { setSuccess } from '../infrastructure/http/response.js';
import { ApiError } from '../infrastructure/http/error-boundary.js';
import { createPlayerAuthMiddleware, type AuthState } from '../infrastructure/auth/player-auth-middleware.js';

// --- 请求 / 响应 schema（与 contracts 对齐） ---

const InviteLinkResponseSchema = Type.Union([
  Type.Object(
    {
      inviteCode: Type.String({ pattern: '^[A-Z0-9]{8,16}$' }),
      url: Type.String({ minLength: 1, maxLength: 2048 }),
      expiresAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
    },
    { additionalProperties: false },
  ),
  Type.Null(),
]);

const ReferralInviteeItemSchema = Type.Object(
  {
    userLabel: Type.String({ minLength: 1, maxLength: 48 }),
    boundAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
    rewardCnyFen: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
  },
  { additionalProperties: false },
);

const ReferralInviteePageSchema = Type.Object(
  {
    items: Type.Array(ReferralInviteeItemSchema, { maxItems: 50 }),
    totalCount: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

const ReferralRewardItemSchema = Type.Object(
  {
    rewardId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
    sourceUserLabel: Type.String({ minLength: 1, maxLength: 48 }),
    paidAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
    paidAmountCnyFen: Type.String({ pattern: '^[1-9][0-9]*$' }),
    rateBps: Type.Integer({ minimum: 0, maximum: 10000 }),
    rewardCnyFen: Type.String({ pattern: '^[1-9][0-9]*$' }),
    state: Type.Union([Type.Literal('FROZEN'), Type.Literal('AVAILABLE'), Type.Literal('PAID')]),
    releaseAt: Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }), Type.Null()]),
  },
  { additionalProperties: false },
);

const ReferralRewardPageSchema = Type.Object(
  {
    items: Type.Array(ReferralRewardItemSchema, { maxItems: 50 }),
    rewardType: Type.Union([Type.Literal(1), Type.Literal(2)]),
    totalRewardCnyFen: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
    frozenRewardCnyFen: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
    availableRewardCnyFen: Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' }),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

const AgentDomainResponseSchema = Type.Union([
  Type.Object(
    {
      userId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
      status: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4), Type.Literal(5)]),
      appliedAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
      capabilities: Type.Array(Type.String(), { maxItems: 9, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  Type.Null(),
]);

const AgentDomainApplyResponseSchema = Type.Object(
  {
    agentDomain: Type.Object(
      {
        userId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
        status: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4), Type.Literal(5)]),
        appliedAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
        capabilities: Type.Array(Type.String(), { maxItems: 9, uniqueItems: true }),
      },
      { additionalProperties: false },
    ),
    inserted: Type.Boolean(),
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

/** 解析游标查询参数（非法 / 缺失 → null，首版不校验游标格式，登记扩展点）。 */
function parseCursorParam(ctx: Context): string | null {
  const raw = ctx.query.cursor as string | undefined;
  if (raw === undefined || raw === '') return null;
  return raw;
}

/** 解析 rewardType 查询参数（默认 1=充值返点；非法 → 400）。 */
function parseRewardType(ctx: Context): 1 | 2 {
  const raw = ctx.query.rewardType as string | undefined;
  if (raw === undefined || raw === '') return 1;
  const v = Number(raw);
  if (v !== 1 && v !== 2) {
    throw new ApiError('REQUEST_VALIDATION_FAILED', 'rewardType 非法（仅接受 1=充值返点 / 2=客损返点）。', { status: 400 });
  }
  return v;
}

// --- 路由工厂 ---

export function createReferralRoutes(module: ReferralModule, identityModule: IdentityModule, _sequelize: Sequelize): Router {
  const router = new Router({ prefix: '' });
  const auth = createPlayerAuthMiddleware(identityModule);

  const noTx: Tx = { transaction: null };

  // GET /me/invite-link（读取邀请链接，200；无有效链接返回 null）
  router.get('/me/invite-link', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const link = await module.inviteLink.get(userId, noTx);
    setSuccess(ctx, {
      message: link !== null ? '邀请链接' : '无有效邀请链接（请签发）',
      data: link,
      schema: InviteLinkResponseSchema,
      status: 200,
    });
  });

  // POST /me/invite-link（签发邀请链接，201 新签发 / 200 幂等重放）
  router.post('/me/invite-link', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const body = getBody(ctx);
    // contracts POST 请求体为空对象（additionalProperties: false）；
    // 若客户端误传字段则 400（首版宽松：忽略 body，登记决策点）。
    void body;
    const { link, inserted } = await module.inviteLink.issue(userId, noTx);
    setSuccess(ctx, {
      message: inserted ? '邀请链接已签发' : '邀请链接已存在（幂等重放）',
      data: link,
      schema: InviteLinkResponseSchema,
      status: inserted ? 201 : 200,
    });
  });

  // GET /me/referrals/direct-invitees（直属下级列表，200；游标分页 50/页）
  router.get('/me/referrals/direct-invitees', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const cursor = parseCursorParam(ctx);
    const page = await module.referralList.listDirectInvitees(userId, cursor, noTx);
    setSuccess(ctx, {
      message: '直属下级列表',
      data: page,
      schema: ReferralInviteePageSchema,
      status: 200,
    });
  });

  // GET /me/referrals/rewards（返佣明细列表，200；游标分页 50/页，?rewardType=1|2）
  router.get('/me/referrals/rewards', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const rewardType = parseRewardType(ctx);
    const cursor = parseCursorParam(ctx);
    const page = await module.referralList.listRewards(userId, rewardType, cursor, noTx);
    setSuccess(ctx, {
      message: '返佣明细列表',
      data: page,
      schema: ReferralRewardPageSchema,
      status: 200,
    });
  });

  // POST /me/agent-domain/apply（申请代理域，201 新申请 / 200 幂等重放）
  router.post('/me/agent-domain/apply', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const body = getBody(ctx);
    // contracts ApplyAgentDomainRequestSchema = { acknowledged: true }（additionalProperties: false）
    if (!Value.Check(Type.Object({ acknowledged: Type.Literal(true) }, { additionalProperties: false }), body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体须为 { "acknowledged": true }。', { status: 400 });
    }
    const result = await module.agentDomain.apply(userId, [], noTx);
    setSuccess(ctx, {
      message: result.inserted ? '代理域申请已提交（待审批）' : '代理域已存在（幂等重放）',
      data: result,
      schema: AgentDomainApplyResponseSchema,
      status: result.inserted ? 201 : 200,
    });
  });

  // GET /me/agent-domain（查询代理域，200；无行返回 null）
  router.get('/me/agent-domain', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const domain = await module.agentDomain.get(userId, noTx);
    setSuccess(ctx, {
      message: domain !== null ? '代理域状态' : '未申请代理域',
      data: domain,
      schema: AgentDomainResponseSchema,
      status: 200,
    });
  });

  // POST /public/referral-attribution/candidate（归因候选暂存，200；
  // 首版无 Redis 时返回 captured: false + expiresAt: null，登记扩展点：
  // Redis 暂存 IP 摘要 + 最新有效邀请码 + TTL 经 §9 第 6 步后续运维闭环）。
  router.post('/public/referral-attribution/candidate', async (ctx) => {
    const body = getBody(ctx);
    const inviteCode = (body.inviteCode as string | undefined) ?? null;
    if (inviteCode !== null && !/^[A-Z0-9]{8,16}$/.test(inviteCode)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '邀请码格式非法（须 8~16 位 [A-Z0-9]）。', { status: 400 });
    }
    // 首版：无 Redis 暂存，返回未捕获（客户端登录时经归因用例落库，
    // 候选状态在归因事务内检查，docs 第 1 节"已有上级账号不因再次访问被换绑"）。
    setSuccess(ctx, {
      message: '归因候选未捕获（首版 Redis 暂存未闭环）',
      data: { captured: false, expiresAt: null },
      schema: Type.Object(
        { captured: Type.Boolean(), expiresAt: Type.Union([Type.String(), Type.Null()]) },
        { additionalProperties: false },
      ),
      status: 200,
    });
  });

  return router;
}
