import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const IdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const TimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });

export const AdminOperationsSource = { LOCAL_DEMO: 1, SERVER: 2 } as const;
export const AdminRoomStatus = { WAITING: 1, PLAYING: 2, SETTLING: 3, CLOSED: 4 } as const;
export const AdminRoundStatus = { SETTLED: 1, CANCELLED: 2 } as const;
export const AdminRoomType = { PRIVATE: 1, MATCHED: 2 } as const;
export const AdminMembershipStatus = { SEATED: 1, LEFT: 2, REMOVED: 3 } as const;
export const AdminRoundSubmissionType = { MANUAL: 1, TIMEOUT_AUTO: 2 } as const;

export const AdminRoomQuerySchema = Type.Object({
  keyword: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  gameKey: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  tierKey: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  status: Type.Optional(Type.Union(Object.values(AdminRoomStatus).map((value) => Type.Literal(value)))),
  cursor: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,8}$' })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });

export const AdminRoomSummarySchema = Type.Object({
  roomId: IdSchema, roomKey: Type.String({ minLength: 1, maxLength: 64 }), gameKey: Type.String({ minLength: 1, maxLength: 64 }),
  gameTitle: Type.String({ minLength: 1, maxLength: 64 }), tierKey: Type.String({ minLength: 1, maxLength: 64 }), tierTitle: Type.String({ minLength: 1, maxLength: 64 }),
  status: Type.Union(Object.values(AdminRoomStatus).map((value) => Type.Literal(value))), phase: Type.String({ minLength: 1, maxLength: 32 }),
  playerCount: Type.Integer({ minimum: 0, maximum: 12 }), capacity: Type.Integer({ minimum: 1, maximum: 12 }), waitSeconds: Type.Integer({ minimum: 0 }),
  rulesVersion: Type.String({ minLength: 1, maxLength: 64 }), lastChangedAt: TimestampSchema, source: Type.Union(Object.values(AdminOperationsSource).map((value) => Type.Literal(value))),
}, { additionalProperties: false });

export const AdminRoomListResponseSchema = Type.Object({ items: Type.Array(AdminRoomSummarySchema, { maxItems: 100 }), total: Type.Integer({ minimum: 0 }), nextCursor: Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,9}$' }), Type.Null()]), source: Type.Union(Object.values(AdminOperationsSource).map((value) => Type.Literal(value))) }, { additionalProperties: false });
export const AdminRoomDetailSchema = Type.Object({
  summary: AdminRoomSummarySchema,
  roomType: Type.Union(Object.values(AdminRoomType).map((value) => Type.Literal(value))),
  heartbeatAt: Type.Union([TimestampSchema, Type.Null()]), ownerKey: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
  checkpointVersion: Type.Integer({ minimum: 1 }),
  members: Type.Array(Type.Object({ userId: IdSchema, nickname: Type.String({ minLength: 1, maxLength: 64 }), seatNo: Type.Integer({ minimum: 1, maximum: 12 }), membershipStatus: Type.Union(Object.values(AdminMembershipStatus).map((value) => Type.Literal(value))), joinedAt: TimestampSchema, connected: Type.Boolean() }, { additionalProperties: false }), { maxItems: 12 }),
  source: Type.Union(Object.values(AdminOperationsSource).map((value) => Type.Literal(value))),
}, { additionalProperties: false });

export const AdminRoundQuerySchema = Type.Object({
  keyword: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })), playerUserId: Type.Optional(IdSchema),
  gameKey: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })), fromCreatedAt: Type.Optional(TimestampSchema), toCreatedAt: Type.Optional(TimestampSchema),
  cursor: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,8}$' })), pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
export const AdminRoundSummarySchema = Type.Object({
  roundId: IdSchema, roundKey: Type.String({ minLength: 1, maxLength: 64 }), roomId: IdSchema, roomKey: Type.String({ minLength: 1, maxLength: 64 }), roundNo: Type.Integer({ minimum: 1 }),
  gameKey: Type.String({ minLength: 1, maxLength: 64 }), gameTitle: Type.String({ minLength: 1, maxLength: 64 }), handlerVersion: Type.String({ minLength: 1, maxLength: 64 }),
  participantCount: Type.Integer({ minimum: 1, maximum: 12 }), status: Type.Union(Object.values(AdminRoundStatus).map((value) => Type.Literal(value))),
  createdAt: TimestampSchema, settledAt: Type.Union([TimestampSchema, Type.Null()]), resultSummary: Type.String({ maxLength: 240 }), source: Type.Union(Object.values(AdminOperationsSource).map((value) => Type.Literal(value))),
}, { additionalProperties: false });
export const AdminRoundListResponseSchema = Type.Object({ items: Type.Array(AdminRoundSummarySchema, { maxItems: 100 }), total: Type.Integer({ minimum: 0 }), nextCursor: Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,9}$' }), Type.Null()]), source: Type.Union(Object.values(AdminOperationsSource).map((value) => Type.Literal(value))) }, { additionalProperties: false });
export const AdminRoundDetailSchema = Type.Object({
  summary: AdminRoundSummarySchema, fencingToken: Type.Integer({ minimum: 1 }), rulesHash: Type.String({ minLength: 8, maxLength: 128 }),
  settlementInputHash: Type.Union([Type.String({ minLength: 8, maxLength: 128 }), Type.Null()]),
  players: Type.Array(Type.Object({ userId: IdSchema, nickname: Type.String({ minLength: 1, maxLength: 64 }), seatNo: Type.Integer({ minimum: 1, maximum: 12 }), wagerCoins: Type.String({ pattern: '^[0-9]+$' }), netCoinDelta: Type.Union([Type.String({ pattern: '^-?[0-9]+$' }), Type.Null()]), submissionType: Type.Union([...Object.values(AdminRoundSubmissionType).map((value) => Type.Literal(value)), Type.Null()]) }, { additionalProperties: false }), { maxItems: 12 }),
  safeHandlerSummary: Type.Union([Type.String({ maxLength: 1000 }), Type.Null()]), assetOperationIds: Type.Array(IdSchema, { maxItems: 24 }), source: Type.Union(Object.values(AdminOperationsSource).map((value) => Type.Literal(value))),
}, { additionalProperties: false });

export const AdminGameOperationsEndpoint = {
  rooms: { method: 'GET', path: '/api/v1/admin/rooms', query: AdminRoomQuerySchema, response: AdminRoomListResponseSchema, successStatus: 200 },
  roomDetail: { method: 'GET', path: '/api/v1/admin/rooms/:roomId', response: AdminRoomDetailSchema, successStatus: 200 },
  rounds: { method: 'GET', path: '/api/v1/admin/rounds', query: AdminRoundQuerySchema, response: AdminRoundListResponseSchema, successStatus: 200 },
  roundDetail: { method: 'GET', path: '/api/v1/admin/rounds/:roundId', response: AdminRoundDetailSchema, successStatus: 200 },
} as const;

export type AdminRoomQueryDto = Static<typeof AdminRoomQuerySchema>;
export type AdminRoomSummaryDto = Static<typeof AdminRoomSummarySchema>;
export type AdminRoomDetailDto = Static<typeof AdminRoomDetailSchema>;
export type AdminRoomListResponseDto = Static<typeof AdminRoomListResponseSchema>;
export type AdminRoundQueryDto = Static<typeof AdminRoundQuerySchema>;
export type AdminRoundSummaryDto = Static<typeof AdminRoundSummarySchema>;
export type AdminRoundDetailDto = Static<typeof AdminRoundDetailSchema>;
export type AdminRoundListResponseDto = Static<typeof AdminRoundListResponseSchema>;
