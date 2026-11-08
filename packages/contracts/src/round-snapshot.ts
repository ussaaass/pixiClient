import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const Id = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const Seq = Type.String({ pattern: '^(0|[1-9][0-9]{0,19})$' });
const PositiveSeq = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });

export const RoundSnapshotRequestSchema = Type.Object(
  {
    afterSeq: Type.Optional(Seq),
    limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
  },
  { additionalProperties: false },
);

export const RoundSnapshotPlayerSchema = Type.Object(
  {
    userId: Id,
    roundPlayerId: Id,
    seatNo: Type.Integer({ minimum: 1, maximum: 4 }),
    status: Type.Integer({ minimum: 1 }),
    submissionSnapshot: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    netCoinDelta: Type.Union([Type.String({ pattern: '^-?(0|[1-9][0-9]*)$' }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const RoundSnapshotEventSchema = Type.Object(
  {
    seq: PositiveSeq,
    eventKey: Type.String({ minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9:_-]+$' }),
    eventType: Type.Integer({ minimum: 1 }),
    roundPlayerId: Type.Union([Id, Type.Null()]),
  },
  { additionalProperties: false },
);

export const RoundSnapshotResponseSchema = Type.Object(
  {
    roundId: Id,
    roomId: Id,
    roundNo: Id,
    status: Type.Integer({ minimum: 1 }),
    handlerVersion: Type.String({ minLength: 1, maxLength: 64 }),
    rulesSnapshot: Type.Record(Type.String(), Type.Unknown()),
    fencingToken: Id,
    players: Type.Array(RoundSnapshotPlayerSchema, { minItems: 4, maxItems: 4 }),
    events: Type.Array(RoundSnapshotEventSchema, { maxItems: 100 }),
    nextCursor: Seq,
  },
  { additionalProperties: false },
);

export type RoundSnapshotRequestDto = Static<typeof RoundSnapshotRequestSchema>;
export type RoundSnapshotResponseDto = Static<typeof RoundSnapshotResponseSchema>;
