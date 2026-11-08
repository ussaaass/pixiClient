import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

export const FencingTokenSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });

const RoundIdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });

/** Shared arrangement shape currently enforced at HTTP/use-case boundaries; not proof of server-dealt cards. */
export const RoundArrangementSchema = Type.Object(
  {
    front: Type.Array(Type.Integer({ minimum: 0, maximum: 51 }), { minItems: 3, maxItems: 3 }),
    middle: Type.Array(Type.Integer({ minimum: 0, maximum: 51 }), { minItems: 5, maxItems: 5 }),
    back: Type.Array(Type.Integer({ minimum: 0, maximum: 51 }), { minItems: 5, maxItems: 5 }),
  },
  { additionalProperties: false },
);

export const RoundStartRequestSchema = Type.Object(
  {
    fencingToken: FencingTokenSchema,
    waterUnits: Type.String({ pattern: '^[1-9][0-9]{0,18}$' }),
  },
  { additionalProperties: false },
);

export const RoundSubmitRequestSchema = Type.Object(
  {
    fencingToken: FencingTokenSchema,
    arrangement: RoundArrangementSchema,
    attempt: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  },
  { additionalProperties: false },
);

export const RoomCreatedResponseSchema = Type.Object(
  {
    roomId: RoundIdSchema,
    roomCode: Type.String({ pattern: '^[A-Z0-9]{6}$' }),
    status: Type.Integer({ minimum: 1 }),
    capacity: Type.Integer({ minimum: 1, maximum: 4 }),
    ownerKey: Type.String({ minLength: 1, maxLength: 128 }),
    replay: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type RoomCreatedResponseDto = Static<typeof RoomCreatedResponseSchema>;

export const RoundStartResponseSchema = Type.Object(
  {
    roundId: RoundIdSchema,
    roundKey: Type.String({ minLength: 1, maxLength: 64 }),
    status: Type.Integer({ minimum: 1 }),
    replay: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const RoundSubmitResponseSchema = Type.Object(
  {
    roundId: RoundIdSchema,
    roundPlayerId: RoundIdSchema,
    submittedAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
    replay: Type.Boolean(),
    allSubmitted: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type RoundStartResponseDto = Static<typeof RoundStartResponseSchema>;
export type RoundSubmitResponseDto = Static<typeof RoundSubmitResponseSchema>;
export type RoundStartRequestDto = Static<typeof RoundStartRequestSchema>;
export type RoundArrangementDto = Static<typeof RoundArrangementSchema>;
export type RoundSubmitRequestDto = Static<typeof RoundSubmitRequestSchema>;
const SettlementPlayerSchema = Type.Object(
  {
    userId: RoundIdSchema,
    water: Type.String({ pattern: '^-?[0-9]{1,19}$' }),
    foul: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Optional for settled-result polling; required by the use case when triggering SETTLING. */
export const RoundSettlementQuerySchema = Type.Object({ fencingToken: Type.Optional(FencingTokenSchema) }, { additionalProperties: false });
export const RoundSettlementResponseSchema = Type.Object(
  {
    roundId: RoundIdSchema,
    settlementId: RoundIdSchema,
    players: Type.Array(SettlementPlayerSchema, { minItems: 1, maxItems: 4 }),
    replay: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type RoundSettlementResponseDto = Static<typeof RoundSettlementResponseSchema>;

export const RoomDifficultyKeySchema = Type.Union([Type.Literal('BEGINNER'), Type.Literal('ADVANCED'), Type.Literal('STRATEGY')]);

export const RoomStatusSchema = Type.Union([Type.Literal('WAITING'), Type.Literal('PLAYING'), Type.Literal('CLOSED')]);

export const RoomMemberSnapshotSchema = Type.Object(
  {
    seat: Type.Integer({ minimum: 1, maximum: 4 }),
    displayName: Type.String({ minLength: 1, maxLength: 24 }),
    participantType: Type.Union([Type.Literal('PLAYER'), Type.Literal('BOT')]),
    isReady: Type.Boolean(),
    isCurrentPlayer: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const GameRoomSnapshotSchema = Type.Object(
  {
    roomId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
    roomCode: Type.String({ pattern: '^[A-Z0-9]{6}$' }),
    gameKey: Type.Literal('SHISANSHUI'),
    difficultyKey: RoomDifficultyKeySchema,
    status: RoomStatusSchema,
    ownerSeat: Type.Integer({ minimum: 1, maximum: 4 }),
    capacity: Type.Literal(4),
    stateVersion: Type.Integer({ minimum: 1 }),
    members: Type.Array(RoomMemberSnapshotSchema, { minItems: 1, maxItems: 4 }),
  },
  { additionalProperties: false },
);

export const CreateGameRoomRequestSchema = Type.Object(
  {
    gameKey: Type.Literal('SHISANSHUI'),
    difficultyKey: RoomDifficultyKeySchema,
    roomPassword: Type.Optional(Type.String({ minLength: 4, maxLength: 32 })),
  },
  { additionalProperties: false },
);

export const JoinGameRoomRequestSchema = Type.Object(
  {
    roomCode: Type.String({ pattern: '^[A-Z0-9]{6}$' }),
    roomPassword: Type.Optional(Type.String({ minLength: 4, maxLength: 32 })),
  },
  { additionalProperties: false },
);

export type RoomDifficultyKey = Static<typeof RoomDifficultyKeySchema>;
export type RoomStatus = Static<typeof RoomStatusSchema>;
export type RoomMemberSnapshotDto = Static<typeof RoomMemberSnapshotSchema>;
export type GameRoomSnapshotDto = Static<typeof GameRoomSnapshotSchema>;
export type CreateGameRoomRequestDto = Static<typeof CreateGameRoomRequestSchema>;
export type JoinGameRoomRequestDto = Static<typeof JoinGameRoomRequestSchema>;
