import { Type } from '@sinclair/typebox';
import type { Static, TSchema } from '@sinclair/typebox';

const UtcTimestampSchema = Type.String({
  pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$',
});
const IdSchema = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
const KeySchema = Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,63}$' });
const SafeParamsSchema = Type.Record(
  Type.String({ pattern: '^[a-z][A-Za-z0-9]{0,47}$' }),
  Type.Union([Type.String({ maxLength: 120 }), Type.Number({ minimum: -1000000000, maximum: 1000000000 })]),
  { maxProperties: 16 },
);

export const PlatformAnnouncementKind = {
  EFFECT: 'EFFECT',
  BROADCAST_ONLY: 'BROADCAST_ONLY',
} as const;

export const PlatformAnnouncementStatus = {
  ACTIVE: 'ACTIVE',
  DRAINING: 'DRAINING',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  EXHAUSTED: 'EXHAUSTED',
} as const;

export const AnnouncementScopeSchema = Type.Union([
  Type.Object({ type: Type.Literal('GLOBAL_HALL') }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('GAME_HALL'), gameKey: KeySchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('DIFFICULTY_HALL'), gameKey: KeySchema, difficultyKey: KeySchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('GAME_SESSION') }, { additionalProperties: false }),
]);

export const PlatformAnnouncementSchema = Type.Object({
  announcementId: IdSchema,
  platformEventId: Type.Optional(IdSchema),
  eventType: KeySchema,
  stateVersion: Type.Integer({ minimum: 1 }),
  kind: Type.Union([Type.Literal(PlatformAnnouncementKind.EFFECT), Type.Literal(PlatformAnnouncementKind.BROADCAST_ONLY)]),
  titleKey: KeySchema,
  safeParams: SafeParamsSchema,
  scope: Type.Array(AnnouncementScopeSchema, { minItems: 1, maxItems: 16 }),
  publicActorLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 48 })),
  startsAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
  clickAction: Type.Optional(Type.Object({
    route: Type.Literal('PLATFORM_ANNOUNCEMENT_DETAIL'),
    params: Type.Object({ announcementId: IdSchema }, { additionalProperties: false }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const PublicEffectTargetSchema = Type.Object({
  scopeLabel: Type.String({ minLength: 1, maxLength: 96 }),
  summary: Type.String({ minLength: 1, maxLength: 240 }),
  probabilityDeltaPoints: Type.Optional(Type.Number({ minimum: -100, maximum: 100 })),
  payoutDeltaPercent: Type.Optional(Type.Number({ minimum: -100, maximum: 10000 })),
  poolRemaining: Type.Optional(Type.String({ pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$', maxLength: 40 })),
  poolUnit: Type.Optional(Type.String({ minLength: 1, maxLength: 24 })),
  seat: Type.Optional(Type.Object({
    occupied: Type.Integer({ minimum: 0 }),
    capacity: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const DetailBaseSchema = {
  announcement: PlatformAnnouncementSchema,
  status: Type.Union([
    Type.Literal(PlatformAnnouncementStatus.ACTIVE),
    Type.Literal(PlatformAnnouncementStatus.DRAINING),
    Type.Literal(PlatformAnnouncementStatus.EXPIRED),
    Type.Literal(PlatformAnnouncementStatus.CANCELLED),
    Type.Literal(PlatformAnnouncementStatus.EXHAUSTED),
  ]),
  endedAt: Type.Optional(UtcTimestampSchema),
  rulesVersion: Type.String({ minLength: 1, maxLength: 64 }),
};

export const PlatformAnnouncementDetailSchema = Type.Union([
  Type.Object({ ...DetailBaseSchema, kind: Type.Literal(PlatformAnnouncementKind.EFFECT), effectTargets: Type.Array(PublicEffectTargetSchema, { minItems: 1, maxItems: 16 }) }, { additionalProperties: false }),
  Type.Object({ ...DetailBaseSchema, kind: Type.Literal(PlatformAnnouncementKind.BROADCAST_ONLY) }, { additionalProperties: false }),
]);

function successEnvelopeSchema<T extends TSchema>(data: T) {
  return Type.Object({
    requestId: Type.String({ minLength: 1 }),
    code: Type.Literal('OK'),
    message: Type.String(),
    data,
    serverNow: UtcTimestampSchema,
  }, { additionalProperties: false });
}

export const ActivePlatformAnnouncementsResponseSchema = successEnvelopeSchema(Type.Object({
  announcements: Type.Array(PlatformAnnouncementSchema, { maxItems: 100 }),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: false }));

export const PlatformAnnouncementDetailResponseSchema = successEnvelopeSchema(PlatformAnnouncementDetailSchema);

export type AnnouncementScope = Static<typeof AnnouncementScopeSchema>;
export type PlatformAnnouncement = Static<typeof PlatformAnnouncementSchema>;
export type PlatformAnnouncementDetail = Static<typeof PlatformAnnouncementDetailSchema>;
export type ActivePlatformAnnouncementsResponse = Static<typeof ActivePlatformAnnouncementsResponseSchema>;
export type PlatformAnnouncementDetailResponse = Static<typeof PlatformAnnouncementDetailResponseSchema>;
