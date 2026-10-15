import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const IdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const UtcTimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });

export const AdminUserSource = { LOCAL_DEMO: 1, SERVER: 2 } as const;
export const AdminUserStatus = { ACTIVE: 1, DISABLED: 2, CLOSED: 3 } as const;
export const AdminUserRoleType = { PLAYER: 1, PLAYER_AGENT: 3 } as const;
export const AdminUserRewardType = { RECHARGE: 1, CUSTOMER_LOSS: 2 } as const;
export const AdminUserDetailSection = {
  OVERVIEW: 'OVERVIEW', SECURITY: 'SECURITY', REFERRAL: 'REFERRAL', ASSETS: 'ASSETS', GAMES: 'GAMES', SOCIAL: 'SOCIAL',
} as const;

export const AdminUserSummaryDtoSchema = Type.Object({
  userId: IdSchema,
  username: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  nickname: Type.String({ minLength: 1, maxLength: 64 }),
  roleType: Type.Union([Type.Literal(AdminUserRoleType.PLAYER), Type.Literal(AdminUserRoleType.PLAYER_AGENT)]),
  status: Type.Union(Object.values(AdminUserStatus).map((status) => Type.Literal(status))),
  parent1UserId: Type.Union([IdSchema, Type.Null()]),
  createdAt: UtcTimestampSchema,
  source: Type.Union(Object.values(AdminUserSource).map((source) => Type.Literal(source))),
}, { additionalProperties: false });

export const AdminUserQuerySchema = Type.Object({
  userId: Type.Optional(IdSchema),
  username: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  roleType: Type.Optional(Type.Union([Type.Literal(AdminUserRoleType.PLAYER), Type.Literal(AdminUserRoleType.PLAYER_AGENT)])),
  status: Type.Optional(Type.Union(Object.values(AdminUserStatus).map((status) => Type.Literal(status)))),
  cursor: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,8}$' })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });

export const AdminUserListResponseSchema = Type.Object({
  items: Type.Array(AdminUserSummaryDtoSchema, { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  nextCursor: Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,8}$' }), Type.Null()]),
}, { additionalProperties: false });

export const AdminUserOverviewDtoSchema = Type.Object({
  user: AdminUserSummaryDtoSchema,
  rewardType: Type.Union([Type.Literal(AdminUserRewardType.RECHARGE), Type.Literal(AdminUserRewardType.CUSTOMER_LOSS)]),
  publicCode: Type.String({ minLength: 4, maxLength: 32 }),
  emailMasked: Type.Union([Type.String({ maxLength: 254 }), Type.Null()]),
  emailVerified: Type.Boolean(),
  phoneMasked: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
  phoneVerified: Type.Boolean(),
  lastLoginAt: Type.Union([UtcTimestampSchema, Type.Null()]),
}, { additionalProperties: false });

export const AdminUserSecurityDtoSchema = Type.Object({
  userId: IdSchema,
  totpEnabled: Type.Boolean(),
  deviceCount: Type.Integer({ minimum: 0 }),
  securityEvents: Type.Array(Type.Object({ action: Type.String({ minLength: 1, maxLength: 48 }), result: Type.String({ minLength: 1, maxLength: 24 }), createdAt: UtcTimestampSchema }, { additionalProperties: false }), { maxItems: 100 }),
  source: Type.Union(Object.values(AdminUserSource).map((source) => Type.Literal(source))),
}, { additionalProperties: false });

export const AdminUserReferralDtoSchema = Type.Object({
  userId: IdSchema,
  rewardType: Type.Union([Type.Literal(AdminUserRewardType.RECHARGE), Type.Literal(AdminUserRewardType.CUSTOMER_LOSS)]),
  ancestors: Type.Array(Type.Object({ level: Type.Integer({ minimum: 1, maximum: 4 }), userId: IdSchema, nickname: Type.String({ minLength: 1, maxLength: 64 }), rewardType: Type.Union([Type.Literal(AdminUserRewardType.RECHARGE), Type.Literal(AdminUserRewardType.CUSTOMER_LOSS)]) }, { additionalProperties: false }), { maxItems: 4 }),
  source: Type.Union(Object.values(AdminUserSource).map((source) => Type.Literal(source))),
}, { additionalProperties: false });

export const AdminUserAssetDtoSchema = Type.Object({
  userId: IdSchema,
  accounts: Type.Array(Type.Object({ assetType: Type.Union([Type.Literal('COIN'), Type.Literal('CNY_BALANCE')]), currency: Type.String({ minLength: 1, maxLength: 8 }), available: Type.String({ pattern: '^-?[0-9]+$' }), frozen: Type.String({ pattern: '^[0-9]+$' }) }, { additionalProperties: false }), { maxItems: 8 }),
  operations: Type.Array(Type.Object({ operationId: IdSchema, operationType: Type.String({ minLength: 1, maxLength: 48 }), assetType: Type.Union([Type.Literal('COIN'), Type.Literal('CNY_BALANCE')]), amount: Type.String({ pattern: '^-?[0-9]+$' }), createdAt: UtcTimestampSchema }, { additionalProperties: false }), { maxItems: 50 }),
  source: Type.Union(Object.values(AdminUserSource).map((source) => Type.Literal(source))),
}, { additionalProperties: false });

export const AdminUserGamesDtoSchema = Type.Object({
  userId: IdSchema,
  rounds: Type.Array(Type.Object({ roundId: IdSchema, gameKey: Type.String({ minLength: 1, maxLength: 64 }), status: Type.String({ minLength: 1, maxLength: 24 }), wagerCoins: Type.String({ pattern: '^[0-9]+$' }), netCoins: Type.String({ pattern: '^-?[0-9]+$' }), createdAt: UtcTimestampSchema }, { additionalProperties: false }), { maxItems: 50 }),
  source: Type.Union(Object.values(AdminUserSource).map((source) => Type.Literal(source))),
}, { additionalProperties: false });

export const AdminUserSocialAuditDtoSchema = Type.Object({
  userId: IdSchema,
  events: Type.Array(Type.Object({ auditId: Type.String({ minLength: 1, maxLength: 128 }), actionCode: Type.String({ minLength: 1, maxLength: 64 }), resourceType: Type.String({ minLength: 1, maxLength: 64 }), createdAt: UtcTimestampSchema }, { additionalProperties: false }), { maxItems: 50 }),
  source: Type.Union(Object.values(AdminUserSource).map((source) => Type.Literal(source))),
}, { additionalProperties: false });

export const AdminUserDetailSectionResponseSchema = Type.Union([
  Type.Object({ section: Type.Literal(AdminUserDetailSection.OVERVIEW), data: AdminUserOverviewDtoSchema }, { additionalProperties: false }),
  Type.Object({ section: Type.Literal(AdminUserDetailSection.SECURITY), data: AdminUserSecurityDtoSchema }, { additionalProperties: false }),
  Type.Object({ section: Type.Literal(AdminUserDetailSection.REFERRAL), data: AdminUserReferralDtoSchema }, { additionalProperties: false }),
  Type.Object({ section: Type.Literal(AdminUserDetailSection.ASSETS), data: AdminUserAssetDtoSchema }, { additionalProperties: false }),
  Type.Object({ section: Type.Literal(AdminUserDetailSection.GAMES), data: AdminUserGamesDtoSchema }, { additionalProperties: false }),
  Type.Object({ section: Type.Literal(AdminUserDetailSection.SOCIAL), data: AdminUserSocialAuditDtoSchema }, { additionalProperties: false }),
]);

export const AdminUserEndpoint = {
  list: { method: 'GET', path: '/api/v1/admin/users', query: AdminUserQuerySchema, response: AdminUserListResponseSchema, successStatus: 200 },
  detail: { method: 'GET', path: '/api/v1/admin/users/:userId/:section', response: AdminUserDetailSectionResponseSchema, successStatus: 200 },
} as const;

export type AdminUserSummaryDto = Static<typeof AdminUserSummaryDtoSchema>;
export type AdminUserQueryDto = Static<typeof AdminUserQuerySchema>;
export type AdminUserListResponseDto = Static<typeof AdminUserListResponseSchema>;
export type AdminUserOverviewDto = Static<typeof AdminUserOverviewDtoSchema>;
export type AdminUserSecurityDto = Static<typeof AdminUserSecurityDtoSchema>;
export type AdminUserReferralDto = Static<typeof AdminUserReferralDtoSchema>;
export type AdminUserAssetDto = Static<typeof AdminUserAssetDtoSchema>;
export type AdminUserGamesDto = Static<typeof AdminUserGamesDtoSchema>;
export type AdminUserSocialAuditDto = Static<typeof AdminUserSocialAuditDtoSchema>;
export type AdminUserDetailSectionResponseDto = Static<typeof AdminUserDetailSectionResponseSchema>;
