import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

export const RoomDifficultyKeySchema = Type.Union([
  Type.Literal('BEGINNER'),
  Type.Literal('ADVANCED'),
  Type.Literal('STRATEGY'),
]);

export const RoomStatusSchema = Type.Union([
  Type.Literal('WAITING'),
  Type.Literal('PLAYING'),
  Type.Literal('CLOSED'),
]);

export const RoomMemberSnapshotSchema = Type.Object({
  seat: Type.Integer({ minimum: 1, maximum: 4 }),
  displayName: Type.String({ minLength: 1, maxLength: 24 }),
  participantType: Type.Union([Type.Literal('PLAYER'), Type.Literal('BOT')]),
  isReady: Type.Boolean(),
  isCurrentPlayer: Type.Boolean(),
}, { additionalProperties: false });

export const GameRoomSnapshotSchema = Type.Object({
  roomId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
  roomCode: Type.String({ pattern: '^[A-Z0-9]{6}$' }),
  gameKey: Type.Literal('SHISANSHUI'),
  difficultyKey: RoomDifficultyKeySchema,
  status: RoomStatusSchema,
  ownerSeat: Type.Integer({ minimum: 1, maximum: 4 }),
  capacity: Type.Literal(4),
  stateVersion: Type.Integer({ minimum: 1 }),
  members: Type.Array(RoomMemberSnapshotSchema, { minItems: 1, maxItems: 4 }),
}, { additionalProperties: false });

export const CreateGameRoomRequestSchema = Type.Object({
  gameKey: Type.Literal('SHISANSHUI'),
  difficultyKey: RoomDifficultyKeySchema,
  roomPassword: Type.Optional(Type.String({ minLength: 4, maxLength: 32 })),
}, { additionalProperties: false });

export const JoinGameRoomRequestSchema = Type.Object({
  roomCode: Type.String({ pattern: '^[A-Z0-9]{6}$' }),
  roomPassword: Type.Optional(Type.String({ minLength: 4, maxLength: 32 })),
}, { additionalProperties: false });

export type RoomDifficultyKey = Static<typeof RoomDifficultyKeySchema>;
export type RoomStatus = Static<typeof RoomStatusSchema>;
export type RoomMemberSnapshotDto = Static<typeof RoomMemberSnapshotSchema>;
export type GameRoomSnapshotDto = Static<typeof GameRoomSnapshotSchema>;
export type CreateGameRoomRequestDto = Static<typeof CreateGameRoomRequestSchema>;
export type JoinGameRoomRequestDto = Static<typeof JoinGameRoomRequestSchema>;
