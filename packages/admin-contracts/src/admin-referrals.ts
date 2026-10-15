import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const IdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const TimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });

export const AdminReferralSource = { LOCAL_DEMO: 1, SERVER: 2 } as const;
export const AdminReferralBindingSource = { IP_ATTRIBUTION: 1, INVITE_CODE: 2, ADMIN: 3 } as const;
export const AdminReferralRewardType = { RECHARGE: 1, CUSTOMER_LOSS: 2 } as const;
export const AdminReferralRewardStatus = { POSTED: 1, SKIPPED: 2 } as const;
export const AdminReferralMigrationStatus = { PENDING: 1, COMPLETED: 2, FAILED: 3 } as const;
export const AdminReferralAction = { REBIND: 'REBIND' } as const;

const AncestorsSchema = Type.Object({
  parent1UserId: Type.Union([IdSchema, Type.Null()]), parent2UserId: Type.Union([IdSchema, Type.Null()]),
  parent3UserId: Type.Union([IdSchema, Type.Null()]), parent4UserId: Type.Union([IdSchema, Type.Null()]),
}, { additionalProperties: false });
const BenefitsSchema = Type.Object({ parent1Cents: Type.String({ pattern: '^[0-9]+$' }), parent2Cents: Type.String({ pattern: '^[0-9]+$' }), parent3Cents: Type.String({ pattern: '^[0-9]+$' }), parent4Cents: Type.String({ pattern: '^[0-9]+$' }) }, { additionalProperties: false });

export const AdminReferralQuerySchema = Type.Object({
  keyword: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  parent1UserId: Type.Optional(IdSchema),
  bindingSource: Type.Optional(Type.Union(Object.values(AdminReferralBindingSource).map((value) => Type.Literal(value)))),
  rewardType: Type.Optional(Type.Union(Object.values(AdminReferralRewardType).map((value) => Type.Literal(value)))),
  cursor: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,8}$' })), pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });

export const AdminReferralListItemSchema = Type.Object({
  userId: IdSchema, nickname: Type.String({ minLength: 1, maxLength: 64 }), username: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  ancestors: AncestorsSchema, benefitsCents: BenefitsSchema,
  rewardType: Type.Union(Object.values(AdminReferralRewardType).map((value) => Type.Literal(value))),
  bindingSource: Type.Union(Object.values(AdminReferralBindingSource).map((value) => Type.Literal(value))), boundAt: TimestampSchema,
  currentDomainName: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]), source: Type.Union(Object.values(AdminReferralSource).map((value) => Type.Literal(value))),
}, { additionalProperties: false });
export const AdminReferralListResponseSchema = Type.Object({ items: Type.Array(AdminReferralListItemSchema, { maxItems: 100 }), total: Type.Integer({ minimum: 0 }), nextCursor: Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,9}$' }), Type.Null()]), source: Type.Union(Object.values(AdminReferralSource).map((value) => Type.Literal(value))) }, { additionalProperties: false });

export const AdminReferralAncestorSchema = Type.Object({ userId: IdSchema, nickname: Type.String({ minLength: 1, maxLength: 64 }), rewardType: Type.Union(Object.values(AdminReferralRewardType).map((value) => Type.Literal(value))), level: Type.Integer({ minimum: 1, maximum: 4 }), domainName: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]) }, { additionalProperties: false });
export const AdminReferralAllocationSchema = Type.Object({
  allocationId: IdSchema, orderId: IdSchema, sourceUserId: IdSchema, sourceNickname: Type.String({ minLength: 1, maxLength: 64 }),
  beneficiaryUserId: IdSchema, beneficiaryNickname: Type.String({ minLength: 1, maxLength: 64 }), ancestorDepth: Type.Integer({ minimum: 1, maximum: 4 }),
  rewardType: Type.Union(Object.values(AdminReferralRewardType).map((value) => Type.Literal(value))), rewardStatus: Type.Union(Object.values(AdminReferralRewardStatus).map((value) => Type.Literal(value))),
  rewardCents: Type.String({ pattern: '^[0-9]+$' }), ancestrySnapshot: AncestorsSchema, createdAt: TimestampSchema,
  unlockAt: Type.Union([TimestampSchema, Type.Null()]), skipReason: Type.Union([Type.String({ maxLength: 255 }), Type.Null()]),
}, { additionalProperties: false });
export const AdminReferralEventSchema = Type.Object({
  eventId: IdSchema, requestKey: Type.String({ minLength: 8, maxLength: 128 }), userId: IdSchema,
  adminUserId: IdSchema, previousAncestors: AncestorsSchema, nextAncestors: AncestorsSchema, reason: Type.String({ minLength: 3, maxLength: 500 }),
  sourceType: Type.Literal(AdminReferralBindingSource.ADMIN), createdAt: TimestampSchema,
}, { additionalProperties: false });
export const AdminSocialMigrationTaskSchema = Type.Object({
  taskId: IdSchema, requestKey: Type.String({ minLength: 8, maxLength: 128 }), userId: IdSchema, nickname: Type.String({ minLength: 1, maxLength: 64 }),
  sourceDomainName: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]), targetDomainName: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  contentCounts: Type.Object({ topics: Type.Integer({ minimum: 0 }), posts: Type.Integer({ minimum: 0 }), replies: Type.Integer({ minimum: 0 }), friendships: Type.Integer({ minimum: 0 }), conversations: Type.Integer({ minimum: 0 }), messages: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  status: Type.Union(Object.values(AdminReferralMigrationStatus).map((value) => Type.Literal(value))), retryCount: Type.Integer({ minimum: 0 }),
  failureReason: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]), createdAt: TimestampSchema, completedAt: Type.Union([TimestampSchema, Type.Null()]),
}, { additionalProperties: false });

export const AdminReferralDetailSchema = Type.Object({
  binding: AdminReferralListItemSchema, ancestors: Type.Array(AdminReferralAncestorSchema, { maxItems: 4 }),
  allocations: Type.Array(AdminReferralAllocationSchema, { maxItems: 100 }), events: Type.Array(AdminReferralEventSchema, { maxItems: 100 }),
  migrationTasks: Type.Array(AdminSocialMigrationTaskSchema, { maxItems: 100 }), source: Type.Union(Object.values(AdminReferralSource).map((value) => Type.Literal(value))),
}, { additionalProperties: false });

export const AdminReferralPreviewRequestSchema = Type.Object({ userId: IdSchema, newParent1UserId: IdSchema }, { additionalProperties: false });
export const AdminReferralPreviewSchema = Type.Object({
  previewKey: Type.String({ minLength: 8, maxLength: 160 }), workspaceRevision: Type.Integer({ minimum: 1 }),
  userId: IdSchema, targetNickname: Type.String({ minLength: 1, maxLength: 64 }), newParent1UserId: IdSchema, newParentNickname: Type.String({ minLength: 1, maxLength: 64 }),
  previousAncestors: AncestorsSchema, nextAncestors: AncestorsSchema,
  affectedUsers: Type.Array(Type.Object({ userId: IdSchema, nickname: Type.String({ minLength: 1, maxLength: 64 }), previousAncestors: AncestorsSchema, nextAncestors: AncestorsSchema, sourceDomainName: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]), targetDomainName: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]), socialCounts: Type.Object({ topics: Type.Integer({ minimum: 0 }), posts: Type.Integer({ minimum: 0 }), replies: Type.Integer({ minimum: 0 }), friendships: Type.Integer({ minimum: 0 }), conversations: Type.Integer({ minimum: 0 }), messages: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }) }, { additionalProperties: false }), { maxItems: 100 }),
  historicalAllocationsUnchanged: Type.Literal(true), source: Type.Union(Object.values(AdminReferralSource).map((value) => Type.Literal(value))),
}, { additionalProperties: false });
export const AdminReferralRebindRequestSchema = Type.Object({
  requestKey: Type.String({ minLength: 8, maxLength: 128 }), previewKey: Type.String({ minLength: 8, maxLength: 160 }), workspaceRevision: Type.Integer({ minimum: 1 }),
  userId: IdSchema, newParent1UserId: IdSchema, reason: Type.String({ minLength: 3, maxLength: 500 }), totpCode: Type.String({ pattern: '^[0-9]{6}$' }),
}, { additionalProperties: false });
export const AdminReferralRebindResponseSchema = Type.Object({ requestKey: Type.String({ minLength: 8, maxLength: 128 }), affectedCount: Type.Integer({ minimum: 1 }), eventIds: Type.Array(IdSchema, { minItems: 1, maxItems: 100 }), migrationTasks: Type.Array(AdminSocialMigrationTaskSchema, { maxItems: 100 }), source: Type.Union(Object.values(AdminReferralSource).map((value) => Type.Literal(value))) }, { additionalProperties: false });
export const AdminSocialMigrationProcessResponseSchema = Type.Object({ task: AdminSocialMigrationTaskSchema, remainingPendingTasks: Type.Integer({ minimum: 0 }), source: Type.Union(Object.values(AdminReferralSource).map((value) => Type.Literal(value))) }, { additionalProperties: false });

export const AdminReferralEndpoint = {
  list: { method: 'GET', path: '/api/v1/admin/referrals', query: AdminReferralQuerySchema, response: AdminReferralListResponseSchema, successStatus: 200 },
  detail: { method: 'GET', path: '/api/v1/admin/referrals/:userId', response: AdminReferralDetailSchema, successStatus: 200 },
  previewRebind: { method: 'POST', path: '/api/v1/admin/referrals/:userId/rebind-preview', request: AdminReferralPreviewRequestSchema, response: AdminReferralPreviewSchema, successStatus: 200 },
  rebind: { method: 'POST', path: '/api/v1/admin/referrals/:userId/rebind', request: AdminReferralRebindRequestSchema, response: AdminReferralRebindResponseSchema, successStatus: 200 },
  processSocialMigration: { method: 'POST', path: '/api/v1/admin/referrals/migration-tasks/:taskId/process', response: AdminSocialMigrationProcessResponseSchema, successStatus: 200 },
} as const;

export type AdminReferralQueryDto = Static<typeof AdminReferralQuerySchema>;
export type AdminReferralListItemDto = Static<typeof AdminReferralListItemSchema>;
export type AdminReferralListResponseDto = Static<typeof AdminReferralListResponseSchema>;
export type AdminReferralAllocationDto = Static<typeof AdminReferralAllocationSchema>;
export type AdminReferralEventDto = Static<typeof AdminReferralEventSchema>;
export type AdminSocialMigrationTaskDto = Static<typeof AdminSocialMigrationTaskSchema>;
export type AdminReferralDetailDto = Static<typeof AdminReferralDetailSchema>;
export type AdminReferralPreviewRequestDto = Static<typeof AdminReferralPreviewRequestSchema>;
export type AdminReferralPreviewDto = Static<typeof AdminReferralPreviewSchema>;
export type AdminReferralRebindRequestDto = Static<typeof AdminReferralRebindRequestSchema>;
export type AdminReferralRebindResponseDto = Static<typeof AdminReferralRebindResponseSchema>;
export type AdminSocialMigrationProcessResponseDto = Static<typeof AdminSocialMigrationProcessResponseSchema>;
