/**
 * /api/v1/me 房间与牌局路由（SDD §5.5 rooms 端点）。
 *
 * 路由层职责：请求解析 → 用例调用 → envelope 包装；仅在 room-create 边界读取
 * 并校验档位 stake 配置快照，不含资金及牌局状态业务规则。
 * 依据：后端实施 SDD §5.5（rooms 端点清单）+ §4（锁顺序 room→round→round_player→settlement，
 *  asset_account.id 升序；幂等先抢唯一约束；所有分录/outbox 同事务）。
 *
 * 端点：
 * - GET    /me/rooms                  （列出用户有效房间）
 * - POST   /me/rooms                  （创建房间，201）
 * - POST   /rooms/:roomId/join        （入座，201/200 重放）
 * - POST   /rooms/:roomId/rounds      （开局，201）
 * - POST   /rounds/:roundId/submit    （出牌提交，201 新建 / 200 幂等重放）
 * - GET    /rounds/:roundId/settlement（结算触发 + 结果读取，200；重复请求幂等返回既有结果）
 * - GET    /me/game-entries           （列出用户有效 game_entry）
 *
 * 断线恢复：GET /rounds/:roundId/snapshot（round + round_player 全量快照 + round_event 游标补拉）。
 * 出款状态机推进归 §9 第 9 步 Admin 端点；/room/:roomId Socket 命名空间随 §6.1 管线落地。
 */

import type { Sequelize } from 'sequelize';
import Router from '@koa/router';
import type { Context } from 'koa';
import { Type } from '@sinclair/typebox';
import { GameConfigModel } from '@gameing/backend/infrastructure/database/models/game';
import {
  GameRoomSnapshotSchema,
  RoundSettlementQuerySchema,
  RoundSettlementResponseSchema,
  RoundSubmitRequestSchema,
  RoundStartRequestSchema,
  RoomCreatedResponseSchema,
  RoundStartResponseSchema,
  RoundSubmitResponseSchema,
} from '@gameing/contracts/game-room';
import { RoundSnapshotRequestSchema, RoundSnapshotResponseSchema } from '@gameing/contracts/round-snapshot';
import { Value } from '@gameing/contracts/wallet';
import { parseShisanshuiStakeConfig, R, isRoomDomainError, type RoomsModule, type Tx } from '@gameing/backend/modules/rooms/public';
import { isKnownErrorCode } from '@gameing/contracts/common/api-errors';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import { setSuccess } from '../infrastructure/http/response.js';
import { ApiError } from '../infrastructure/http/error-boundary.js';
import { createPlayerAuthMiddleware, type AuthState } from '../infrastructure/auth/player-auth-middleware.js';

// --- 请求/响应 schema（rooms 专有，contracts 未定义时本地兜底；有 contract 优先用 contract） ---

const CreateRoomRequestSchema = Type.Object(
  {
    gameId: Type.String({ minLength: 1, maxLength: 64 }),
    gameTierId: Type.String({ minLength: 1, maxLength: 64 }),
    roomType: Type.Union([Type.Literal(1), Type.Literal(2)]),
    capacity: Type.Integer({ minimum: 1, maximum: 4 }),
  },
  { additionalProperties: false },
);

const RoomListResponseSchema = Type.Array(RoomCreatedResponseSchema, { maxItems: 50 });

const GameEntryListResponseSchema = Type.Array(
  Type.Object(
    {
      entryId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
      status: Type.String(),
      roomId: Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), Type.Null()]),
      createdAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
      expiresAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
    },
    { additionalProperties: false },
  ),
  { maxItems: 50 },
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

async function submitInTx<T>(module: RoomsModule, sequelize: Sequelize, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sequelize
    .transaction(async (transaction) => {
      const tx: Tx = { transaction };
      return fn(tx);
    })
    .catch(mapRoomError);
}

function mapRoomError(error: unknown): never {
  if (!isRoomDomainError(error) || !isKnownErrorCode(error.code)) throw error;
  if (error.code === R.ROUND_PLAYER_NOT_FOUND) {
    throw new ApiError('FORBIDDEN', '无权操作此牌局。', { cause: error });
  }
  throw new ApiError(error.code, '牌局操作未能完成。', { retryable: error.retryable, cause: error });
}

// --- 路由工厂 ---

export function createRoomsRoutes(module: RoomsModule, identityModule: IdentityModule, sequelize: Sequelize): Router {
  const router = new Router({ prefix: '' });
  const auth = createPlayerAuthMiddleware(identityModule);

  // GET /me/rooms
  router.get('/me/rooms', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const result = await module.roomRepo.listRoomsByUser(userId);
    setSuccess(ctx, {
      message: '用户有效房间列表',
      data: result,
      schema: RoomListResponseSchema,
      status: 200,
    });
  });

  // POST /me/rooms（201）
  router.post('/me/rooms', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const body = getBody(ctx);
    if (!Value.Check(CreateRoomRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体 schema 校验失败。', { status: 400 });
    }
    const result = await submitInTx(module, sequelize, async (tx) => {
      const gameConfig = await GameConfigModel.findOne({
        where: {
          gameId: (body.gameId as string) ?? '',
          gameTierId: (body.gameTierId as string) ?? '',
          agentDomainId: null,
          scopeType: 2,
          configKey: 'shisanshui.stake',
          status: 1,
        },
        order: [['updatedAt', 'DESC']],
        transaction: tx.transaction as never,
      } as never);
      if (gameConfig === null || gameConfig.configType !== 5) {
        throw new ApiError('STORAGE_UNAVAILABLE', '档位下注配置不可用。', { status: 503 });
      }
      let stakePolicy: ReturnType<typeof parseShisanshuiStakeConfig>;
      try {
        stakePolicy = parseShisanshuiStakeConfig(JSON.parse(gameConfig.configValue) as unknown);
      } catch (error) {
        if (isRoomDomainError(error)) throw error;
        throw new ApiError('STORAGE_UNAVAILABLE', '档位下注配置无效。', { status: 503, cause: error });
      }
      return module.roomCreate.run({
        userId,
        gameId: (body.gameId as string) ?? '',
        gameTierId: (body.gameTierId as string) ?? '',
        rulesSnapshot: {
          'shisanshui.stake': {
            coinPerWater: stakePolicy.coinPerWater.toString(),
            minWaterUnits: stakePolicy.minWaterUnits.toString(),
            maxWaterUnits: stakePolicy.maxWaterUnits.toString(),
            maxLossHoldCoins: stakePolicy.maxLossHoldCoins.toString(),
          },
        },
        capacity: (body.capacity as number) ?? 4,
        roomType: (body.roomType as number) ?? 1,
        ownerKey: `owner:${userId}`,
        tx,
      });
    });
    setSuccess(ctx, {
      message: '房间已创建',
      data: result,
      schema: RoomCreatedResponseSchema,
      status: result.replay ? 200 : 201,
    });
  });

  // POST /rooms/:roomId/join（201 新建 / 200 重放）
  router.post('/rooms/:roomId/join', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const roomId = ctx.params.roomId;
    if (roomId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });
    const result = await submitInTx(module, sequelize, async (tx) => {
      return module.roomJoin.run({ userId, roomId, tx });
    });
    setSuccess(ctx, {
      message: '入座成功',
      data: result,
      schema: GameRoomSnapshotSchema as never,
      status: result.replay ? 200 : 201,
    });
  });

  // POST /rooms/:roomId/rounds（开局，201）
  router.post('/rooms/:roomId/rounds', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const roomId = ctx.params.roomId;
    if (roomId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });
    const body = getBody(ctx);
    if (!Value.Check(RoundStartRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体 schema 校验失败。', { status: 400 });
    }
    const result = await submitInTx(module, sequelize, async (tx) => {
      return module.roundStart.run({
        userId,
        roomId,
        fencingToken: (body.fencingToken as string) ?? '',
        waterUnits: (body.waterUnits as string) ?? '0',
        tx,
      });
    });
    setSuccess(ctx, {
      message: '开局成功',
      data: result,
      schema: RoundStartResponseSchema,
      status: result.replay ? 200 : 201,
    });
  });

  // POST /rounds/:roundId/submit（新提交 201，幂等重放 200）
  router.post('/rounds/:roundId/submit', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const roundId = ctx.params.roundId;
    if (roundId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });
    const body = getBody(ctx);
    if (!Value.Check(RoundSubmitRequestSchema, body)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '请求体 schema 校验失败。', { status: 400 });
    }
    const result = await submitInTx(module, sequelize, async (tx) => {
      return module.roundSubmit.run({
        userId,
        roundId,
        fencingToken: (body.fencingToken as string) ?? '',
        arrangement: (body.arrangement as Record<string, unknown>) ?? {},
        attempt: (body.attempt as number) ?? 1,
        tx,
      });
    });
    setSuccess(ctx, {
      message: result.allSubmitted ? '全部玩家已提交，牌局进入结算' : '出牌已提交',
      data: result,
      schema: RoundSubmitResponseSchema,
      status: result.replay ? 200 : 201,
    });
  });

  // GET /rounds/:roundId/snapshot（成员授权快照与游标事件补拉）
  router.get('/rounds/:roundId/snapshot', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const roundId = ctx.params.roundId;
    if (roundId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });
    const snapshotQuery = Object.fromEntries(new URLSearchParams(ctx.querystring).entries());
    if (!Value.Check(RoundSnapshotRequestSchema, snapshotQuery)) {
      throw new ApiError('REQUEST_VALIDATION_FAILED', '快照游标参数格式非法。', { status: 400 });
    }
    const result = await submitInTx(module, sequelize, async (tx) =>
      module.roundSnapshot(
        {
          userId,
          roundId,
          ...(typeof ctx.query.afterSeq === 'string' ? { afterSeq: ctx.query.afterSeq } : {}),
          ...(typeof ctx.query.limit === 'string' ? { limit: Number(ctx.query.limit) } : {}),
        },
        tx,
      ),
    );
    setSuccess(ctx, { message: '牌局快照', data: result, schema: RoundSnapshotResponseSchema, status: 200 });
  });

  // GET /rounds/:roundId/settlement（结算触发 + 结果读取，幂等）
  router.get('/rounds/:roundId/settlement', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const roundId = ctx.params.roundId;
    if (roundId === undefined) throw new ApiError('NOT_FOUND', '路径参数缺失。', { status: 404 });
    const result = await submitInTx(module, sequelize, async (tx) => {
      if (!Value.Check(RoundSettlementQuerySchema, ctx.query)) {
        throw new ApiError('REQUEST_VALIDATION_FAILED', '结算查询参数格式非法。', { status: 400 });
      }
      const fencingToken = ctx.query.fencingToken as string | undefined;
      return module.roundSettle.run({ roundId, userId, ...(fencingToken === undefined ? {} : { fencingToken }), tx });
    });
    setSuccess(ctx, {
      message: '结算结果',
      data: result,
      schema: RoundSettlementResponseSchema,
      status: 200,
    });
  });

  // GET /me/game-entries（列出用户有效 game_entry）
  router.get('/me/game-entries', auth, async (ctx) => {
    const userId = requireUserId(ctx.state as AuthState);
    const result = await module.gameEntry.list(userId);
    setSuccess(ctx, {
      message: '游戏入场资格列表',
      data: result,
      schema: GameEntryListResponseSchema,
      status: 200,
    });
  });

  return router;
}
