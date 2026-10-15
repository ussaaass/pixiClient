import { Type, type Static } from '@sinclair/typebox';

export const EventRuleType = { PLAYER_BURST: 'PLAYER_BURST', PLAYER_STREAK: 'PLAYER_STREAK' } as const;
export const EventRuleStatus = { ACTIVE: 'ACTIVE', PAUSED: 'PAUSED' } as const;
export const PlatformEventLocalStatus = { ACTIVE: 'ACTIVE', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED' } as const;
export const EventDeliveryPreviewStatus = { PREVIEW_ONLY: 'PREVIEW_ONLY' } as const;
export const EventOperationsSource = { LOCAL_DEMO: 'LOCAL_DEMO', SERVER: 'SERVER' } as const;
export const EventActorType = { USER: 'USER', BOT: 'BOT', SYSTEM: 'SYSTEM' } as const;

const Id = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
const Timestamp = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });
const Key = Type.String({ pattern: '^[a-z][a-z0-9_]{1,63}$' });

export const AdminEventRuleDtoSchema = Type.Object({
  ruleId: Id,
  eventType: Type.Union([Type.Literal(EventRuleType.PLAYER_BURST), Type.Literal(EventRuleType.PLAYER_STREAK)]),
  gameKey: Key,
  difficultyKey: Key,
  threshold: Type.Integer({ minimum: 1, maximum: 100000 }),
  durationMinutes: Type.Integer({ minimum: 1, maximum: 15 }),
  allowedActorTypes: Type.Array(Type.Union([Type.Literal(EventActorType.USER), Type.Literal(EventActorType.BOT), Type.Literal(EventActorType.SYSTEM)]), { minItems: 1, maxItems: 3, uniqueItems: true }),
  status: Type.Union([Type.Literal(EventRuleStatus.ACTIVE), Type.Literal(EventRuleStatus.PAUSED)]),
  effect: Type.Literal('BROADCAST_ONLY'),
  updatedAt: Timestamp,
  source: Type.Literal(EventOperationsSource.LOCAL_DEMO),
}, { additionalProperties: false });

export const AdminEventRuleSaveRequestSchema = Type.Object({
  ruleId: Type.Union([Id, Type.Null()]),
  eventType: Type.Union([Type.Literal(EventRuleType.PLAYER_BURST), Type.Literal(EventRuleType.PLAYER_STREAK)]),
  gameKey: Key,
  difficultyKey: Key,
  threshold: Type.Integer({ minimum: 1, maximum: 100000 }),
  durationMinutes: Type.Integer({ minimum: 1, maximum: 15 }),
  allowedActorTypes: Type.Array(Type.Union([Type.Literal(EventActorType.USER), Type.Literal(EventActorType.BOT), Type.Literal(EventActorType.SYSTEM)]), { minItems: 1, maxItems: 3, uniqueItems: true }),
  status: Type.Union([Type.Literal(EventRuleStatus.ACTIVE), Type.Literal(EventRuleStatus.PAUSED)]),
  reason: Type.String({ minLength: 3, maxLength: 240 }),
  requestKey: Id,
}, { additionalProperties: false });

export const AdminEventTriggerRequestSchema = Type.Object({
  ruleId: Id,
  eventValue: Type.Integer({ minimum: 1, maximum: 100000 }),
  actorType: Type.Union([Type.Literal(EventActorType.USER), Type.Literal(EventActorType.BOT), Type.Literal(EventActorType.SYSTEM)]),
  actorLabel: Type.String({ minLength: 2, maxLength: 24 }),
  cannotContinue: Type.Boolean(),
  reason: Type.String({ minLength: 3, maxLength: 240 }),
  requestKey: Id,
}, { additionalProperties: false });

export const AdminPlatformEventDtoSchema = Type.Object({
  eventId: Id,
  ruleId: Id,
  eventType: Type.Union([Type.Literal(EventRuleType.PLAYER_BURST), Type.Literal(EventRuleType.PLAYER_STREAK)]),
  gameKey: Key,
  difficultyKey: Key,
  metricValue: Type.Integer({ minimum: 1 }),
  actorType: Type.Union([Type.Literal(EventActorType.USER), Type.Literal(EventActorType.BOT), Type.Literal(EventActorType.SYSTEM)]),
  publicActorLabel: Type.String({ minLength: 2, maxLength: 24 }),
  effect: Type.Literal('BROADCAST_ONLY'),
  status: Type.Union([Type.Literal(PlatformEventLocalStatus.ACTIVE), Type.Literal(PlatformEventLocalStatus.CANCELLED), Type.Literal(PlatformEventLocalStatus.EXPIRED)]),
  startsAt: Timestamp,
  expiresAt: Timestamp,
  stateVersion: Type.Integer({ minimum: 1 }),
  source: Type.Literal(EventOperationsSource.LOCAL_DEMO),
}, { additionalProperties: false });

export const AdminEventDeliveryDtoSchema = Type.Object({
  deliveryId: Id,
  eventId: Id,
  audience: Type.Union([Type.Literal('GLOBAL_HALL'), Type.Literal('GAME_HALL'), Type.Literal('DIFFICULTY_HALL')]),
  status: Type.Literal(EventDeliveryPreviewStatus.PREVIEW_ONLY),
  previewText: Type.String({ minLength: 1, maxLength: 320 }),
  previewedAt: Timestamp,
  source: Type.Literal(EventOperationsSource.LOCAL_DEMO),
}, { additionalProperties: false });

export const AdminEventAuditDtoSchema = Type.Object({
  auditId: Id,
  requestKey: Id,
  action: Type.Union([Type.Literal('RULE_SAVED'), Type.Literal('EVENT_SIMULATED'), Type.Literal('EVENT_CANCELLED'), Type.Literal('DELIVERY_PREVIEWED')]),
  resourceId: Id,
  reason: Type.String({ minLength: 3, maxLength: 240 }),
  commandSignature: Type.String({ minLength: 1, maxLength: 512 }),
  createdAt: Timestamp,
  source: Type.Literal(EventOperationsSource.LOCAL_DEMO),
}, { additionalProperties: false });

export type AdminEventRuleDto = Static<typeof AdminEventRuleDtoSchema>;
export type AdminEventRuleSaveRequestDto = Static<typeof AdminEventRuleSaveRequestSchema>;
export type AdminEventTriggerRequestDto = Static<typeof AdminEventTriggerRequestSchema>;
export type AdminPlatformEventDto = Static<typeof AdminPlatformEventDtoSchema>;
export type AdminEventDeliveryDto = Static<typeof AdminEventDeliveryDtoSchema>;
export type AdminEventAuditDto = Static<typeof AdminEventAuditDtoSchema>;
