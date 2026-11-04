/**
 * /me/ai-assets 路由（SDD §9 第 8 步：AI 素材台账 0017）。
 *
 * 路由层职责：请求解析 → 用例调用 → envelope 包装；不含业务规则。
 * 依据：后端实施 SDD §9 第 8 步（AI 素材台账：asset/ai_asset_* 与发布，
 * 与现有 tools/asset-generation 台账对接）；§4（幂等先抢唯一约束）。
 *
 * 端点：
 * - POST   /me/ai-assets/jobs                      （创建生成任务，201 新建 /
 *          200 幂等重放；QUEUED=1 + U(job_key) 幂等；不实际调外部网关）
 * - POST   /me/ai-assets/jobs/:id/cancel           （取消任务，200；仅 QUEUED=1
 *          可取消，CANCELLED=5 幂等重放）
 * - GET    /me/ai-assets/jobs                      （任务列表，200；游标分页 50/页）
 * - GET    /me/ai-assets/jobs/:id                  （任务详情 + artifact 列表，200）
 * - POST   /me/ai-assets/releases                   （创建发布草稿，201/200 重放）
 * - POST   /me/ai-assets/releases/:id/publish       （发布 DRAFT=1→PUBLISHED=3，200）
 * - GET    /me/ai-assets/releases                   （发布列表，200；游标分页 50/页）
 *
 * 注意：
 * - `jobKey` / `releaseKey` 经 `crypto.randomUUID()` 路由层生成（U 幂等键）。
 * - `promptHashHex` 经 `crypto.createHash('sha256').update(prompt).digest('hex')`
 *   路由层计算（64 字符，防 prompt 篡改）。
 * - 挂载条件：identityModule + aiAssetsModule + sequelize 均就绪时挂载。
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize';
import Router from '@koa/router';
import type { Context } from 'koa';
import { Type } from '@sinclair/typebox';
import { Value } from '@gameing/contracts/wallet';
import type { AiAssetsModule } from '@gameing/backend/modules/ai-assets/public';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import { setSuccess } from '../infrastructure/http/response.js';
import { ApiError } from '../infrastructure/http/error-boundary.js';
import { createPlayerAuthMiddleware } from '../infrastructure/auth/player-auth-middleware.js';
import { isAiAssetsDomainError, AIAS } from '@gameing/backend/modules/ai-assets/public';

// --- 请求 / 响应 schema ---

const JobCreateRequestSchema = Type.Object(
  {
    assetKey: Type.String({ minLength: 1, maxLength: 128 }),
    assetKind: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4), Type.Literal(5)]),
    providerCode: Type.String({ maxLength: 32 }),
    mainModelCode: Type.String({ maxLength: 128 }),
    imageModelCode: Type.String({ maxLength: 128 }),
    apiMode: Type.Union([Type.Literal(1), Type.Literal(2)]),
    prompt: Type.String({ minLength: 1, maxLength: 10000 }),
    styleVersion: Type.String({ maxLength: 64 }),
    generationConfig: Type.Object({}),
  },
  { additionalProperties: false },
);

const ReleaseCreateRequestSchema = Type.Object(
  {
    gameId: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
    assetId: Type.String({ pattern: '^[1-9][0-9]*$' }),
    manifestHashHex: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    reviewNote: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);

const JobResponseSchema = Type.Object(
  {
    jobId: Type.String({ pattern: '^[1-9][0-9]*$' }),
    jobKey: Type.String({ maxLength: 36 }),
    status: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4), Type.Literal(5), Type.Literal(6)], {
      description: 'QUEUED=1/RUNNING=2/SUCCEEDED=3/FAILED=4/CANCELLED=5/REVIEW_REQUIRED=6',
    }),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);

const JobListResponseSchema = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          jobId: Type.String({ pattern: '^[1-9][0-9]*$' }),
          jobKey: Type.String({ maxLength: 36 }),
          assetKey: Type.String({ maxLength: 128 }),
          assetKind: Type.Integer({ minimum: 1, maximum: 5 }),
          providerCode: Type.String({ maxLength: 32 }),
          mainModelCode: Type.String({ maxLength: 128 }),
          apiMode: Type.Integer({ minimum: 1, maximum: 2 }),
          status: Type.Integer({ minimum: 1, maximum: 6 }),
          createdAt: Type.String(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

const JobDetailResponseSchema = Type.Object(
  {
    jobId: Type.String({ pattern: '^[1-9][0-9]*$' }),
    jobKey: Type.String({ maxLength: 36 }),
    status: Type.Integer({ minimum: 1, maximum: 6 }),
    costMicroUsd: Type.Union([Type.String({ pattern: '^-?[0-9]+$' }), Type.Null()]),
    attempts: Type.Integer(),
    completedAt: Type.Union([Type.String(), Type.Null()]),
    artifacts: Type.Array(
      Type.Object(
        {
          artifactId: Type.String({ pattern: '^[1-9][0-9]*$' }),
          assetId: Type.String({ pattern: '^[1-9][0-9]*$' }),
          artifactType: Type.Integer({ minimum: 1, maximum: 5 }),
          status: Type.Integer({ minimum: 1, maximum: 3 }),
          reviewNote: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const ReleaseResponseSchema = Type.Object(
  {
    releaseId: Type.String({ pattern: '^[1-9][0-9]*$' }),
    releaseKey: Type.String({ maxLength: 128 }),
    status: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4)], {
      description: 'DRAFT=1/REVIEW=2/PUBLISHED=3/RETIRED=4',
    }),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);

const ReleaseListResponseSchema = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          releaseId: Type.String({ pattern: '^[1-9][0-9]*$' }),
          releaseKey: Type.String({ maxLength: 128 }),
          gameId: Type.Union([Type.String({ pattern: '^[1-9][0-9]*$' }), Type.Null()]),
          status: Type.Integer({ minimum: 1, maximum: 4 }),
          publishedAt: Type.Union([Type.String(), Type.Null()]),
          createdAt: Type.String(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 50 },
    ),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

// --- 辅助函数（同款 referral / social 路由） ---

function getBody(ctx: Context): Record<string, unknown> {
  return (ctx as unknown as { request: { body?: Record<string, unknown> } }).request.body ?? {};
}

/** 领域错误 → HTTP 错误映射。 */
function mapAiAssetsError(err: unknown): never {
  if (isAiAssetsDomainError(err)) {
    switch (err.code) {
      case AIAS.JOB_NOT_FOUND:
        throw new ApiError('AIAS_JOB_NOT_FOUND', err.message, { status: 404 });
      case AIAS.JOB_NOT_CANCELLABLE:
        throw new ApiError('AIAS_JOB_NOT_CANCELLABLE', err.message, { status: 409 });
      case AIAS.RELEASE_NOT_FOUND:
        throw new ApiError('AIAS_RELEASE_NOT_FOUND', err.message, { status: 404 });
      case AIAS.RELEASE_NOT_DRAFT:
        throw new ApiError('AIAS_RELEASE_NOT_DRAFT', err.message, { status: 409 });
      case AIAS.ASSET_NOT_FOUND:
        throw new ApiError('AIAS_ASSET_NOT_FOUND', err.message, { status: 404 });
      case AIAS.STORAGE_UNAVAILABLE:
        throw new ApiError('AIAS_STORAGE_UNAVAILABLE', err.message, { status: 503 });
      default:
        throw new ApiError('AIAS_UNKNOWN', err.message, { status: 500 });
    }
  }
  throw err;
}

// --- 路由工厂 ---

export function createAiAssetsRoutes(module: AiAssetsModule, identityModule: IdentityModule, _sequelize: Sequelize): Router {
  const router = new Router({ prefix: '' });
  const auth = createPlayerAuthMiddleware(identityModule);

  // POST /me/ai-assets/jobs（创建生成任务，201 新建 / 200 幂等重放）
  router.post('/me/ai-assets/jobs', auth, async (ctx) => {
    const body = getBody(ctx);
    if (!Value.Check(JobCreateRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体 schema 校验失败。', { status: 400 });
    }
    const jobKey = randomUUID();
    const promptHashHex = createHash('sha256')
      .update(body.prompt as string)
      .digest('hex');

    const result = await module
      .withTx({ transaction: null }, (tx) =>
        module.jobCreate.run({
          jobKey,
          assetKey: body.assetKey as string,
          assetKind: body.assetKind as number,
          providerCode: body.providerCode as string,
          mainModelCode: body.mainModelCode as string,
          imageModelCode: body.imageModelCode as string,
          apiMode: body.apiMode as number,
          prompt: body.prompt as string,
          promptHashHex,
          styleVersion: body.styleVersion as string,
          generationConfig: body.generationConfig as Record<string, unknown>,
          secretRef: null,
          tx,
        }),
      )
      .catch(mapAiAssetsError);

    setSuccess(ctx, {
      message: result.inserted ? '生成任务已创建' : '生成任务已存在（幂等重放）',
      data: result,
      schema: JobResponseSchema,
      status: result.inserted ? 201 : 200,
    });
  });

  // POST /me/ai-assets/jobs/:id/cancel（取消任务，200；仅 QUEUED=1 可取消）
  router.post('/me/ai-assets/jobs/:id/cancel', auth, async (ctx) => {
    const jobId = ctx.params.id;
    if (jobId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });

    const result = await module.withTx({ transaction: null }, (tx) => module.jobCancel.run({ jobId, tx })).catch(mapAiAssetsError);

    setSuccess(ctx, {
      message: result.replay ? '任务已取消（幂等重放）' : '任务已取消',
      data: result,
      schema: Type.Object(
        {
          jobId: Type.String(),
          status: Type.Integer(),
          replay: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      status: 200,
    });
  });

  // GET /me/ai-assets/jobs（任务列表，200；游标分页 50/页）
  router.get('/me/ai-assets/jobs', auth, async (ctx) => {
    const cursor = (ctx.query.cursor as string | undefined) ?? null;
    const limit = Number.parseInt((ctx.query.limit as string | undefined) ?? '50', 10);

    const result = await module
      .withTx({ transaction: null }, (tx) =>
        module.jobList.run({
          assetKey: (ctx.query.assetKey as string | undefined) ?? '',
          cursor,
          limit: Number.isNaN(limit) ? 50 : limit,
          tx,
        }),
      )
      .catch(mapAiAssetsError);

    setSuccess(ctx, {
      message: '生成任务列表',
      data: result,
      schema: JobListResponseSchema,
      status: 200,
    });
  });

  // GET /me/ai-assets/jobs/:id（任务详情 + artifact 列表，200）
  router.get('/me/ai-assets/jobs/:id', auth, async (ctx) => {
    const jobId = ctx.params.id;
    if (jobId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });

    const result = await module.withTx({ transaction: null }, (tx) => module.jobDetail.run({ jobId, tx })).catch(mapAiAssetsError);

    setSuccess(ctx, {
      message: '生成任务详情',
      data: result,
      schema: JobDetailResponseSchema,
      status: 200,
    });
  });

  // POST /me/ai-assets/releases（创建发布草稿，201/200 重放）
  router.post('/me/ai-assets/releases', auth, async (ctx) => {
    const body = getBody(ctx);
    if (!Value.Check(ReleaseCreateRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体 schema 校验失败。', { status: 400 });
    }
    const releaseKey = randomUUID();

    const result = await module
      .withTx({ transaction: null }, (tx) =>
        module.releaseCreate.run({
          releaseKey,
          gameId: (body.gameId as string | undefined) ?? null,
          assetId: body.assetId as string,
          manifestHashHex: body.manifestHashHex as string,
          reviewNote: (body.reviewNote as string | undefined) ?? '',
          tx,
        }),
      )
      .catch(mapAiAssetsError);

    setSuccess(ctx, {
      message: result.inserted ? '发布草稿已创建' : '发布草稿已存在（幂等重放）',
      data: result,
      schema: ReleaseResponseSchema,
      status: result.inserted ? 201 : 200,
    });
  });

  // POST /me/ai-assets/releases/:id/publish（发布 DRAFT=1→PUBLISHED=3，200）
  router.post('/me/ai-assets/releases/:id/publish', auth, async (ctx) => {
    const releaseId = ctx.params.id;
    if (releaseId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });

    const result = await module.withTx({ transaction: null }, (tx) => module.releasePublish.run({ releaseId, tx })).catch(mapAiAssetsError);

    setSuccess(ctx, {
      message: result.replay ? '发布版本已发布（幂等重放）' : '发布版本已发布',
      data: result,
      schema: Type.Object(
        {
          releaseId: Type.String(),
          status: Type.Integer(),
          publishedAt: Type.String(),
          replay: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      status: 200,
    });
  });

  // GET /me/ai-assets/releases（发布列表，200；游标分页 50/页）
  router.get('/me/ai-assets/releases', auth, async (ctx) => {
    const cursor = (ctx.query.cursor as string | undefined) ?? null;
    const limit = Number.parseInt((ctx.query.limit as string | undefined) ?? '50', 10);
    const gameId = (ctx.query.gameId as string | undefined) ?? null;

    const result = await module
      .withTx({ transaction: null }, (tx) =>
        module.releaseList.run({
          gameId: gameId === '' ? null : (gameId ?? null),
          cursor,
          limit: Number.isNaN(limit) ? 50 : limit,
          tx,
        }),
      )
      .catch(mapAiAssetsError);

    setSuccess(ctx, {
      message: '发布版本列表',
      data: result,
      schema: ReleaseListResponseSchema,
      status: 200,
    });
  });

  return router;
}
