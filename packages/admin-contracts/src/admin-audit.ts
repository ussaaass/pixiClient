import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const IdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const UtcTimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });

export const AdminAuditResultType = { SUCCESS: 1, DENIED: 2, FAILED: 3 } as const;
export const AdminAuditSource = { LOCAL_DEMO: 1, SERVER: 2 } as const;
export const AdminAuditActionCode = {
  PERMISSIONS_UPDATED: 'ADMIN_PERMISSIONS_UPDATED',
  AGENT_DOMAIN_ACTION: 'AGENT_DOMAIN_ACTION',
  GAME_CATALOG_SAVED: 'GAME_CATALOG_SAVED',
  PAYMENT_CHANNEL_SAVED: 'PAYMENT_CHANNEL_SAVED',
  ANNOUNCEMENT_TEMPLATE_SAVED: 'ANNOUNCEMENT_TEMPLATE_SAVED',
  SOCIAL_MODERATION_DECIDED: 'SOCIAL_MODERATION_DECIDED',
} as const;

export const AdminAuditDtoSchema = Type.Object({
  auditId: Type.String({ minLength: 1, maxLength: 180 }),
  adminUserId: IdSchema,
  adminDisplayName: Type.String({ minLength: 1, maxLength: 80 }),
  targetUserId: Type.Union([IdSchema, Type.Null()]),
  requestId: Type.Union([Type.String({ minLength: 1, maxLength: 160 }), Type.Null()]),
  actionCode: Type.Union(Object.values(AdminAuditActionCode).map((action) => Type.Literal(action))),
  resultType: Type.Union(Object.values(AdminAuditResultType).map((result) => Type.Literal(result))),
  resourceType: Type.String({ minLength: 1, maxLength: 64 }),
  resourceKey: Type.String({ minLength: 1, maxLength: 160 }),
  reason: Type.String({ minLength: 1, maxLength: 500 }),
  beforeSummary: Type.Union([Type.String({ maxLength: 1000 }), Type.Null()]),
  afterSummary: Type.Union([Type.String({ maxLength: 1000 }), Type.Null()]),
  source: Type.Union(Object.values(AdminAuditSource).map((source) => Type.Literal(source))),
  createdAt: UtcTimestampSchema,
}, { additionalProperties: false });

export const AdminAuditQuerySchema = Type.Object({
  keyword: Type.Optional(Type.String({ maxLength: 100 })),
  adminUserId: Type.Optional(IdSchema),
  targetUserId: Type.Optional(IdSchema),
  actionCode: Type.Optional(Type.Union(Object.values(AdminAuditActionCode).map((action) => Type.Literal(action)))),
  resultType: Type.Optional(Type.Union(Object.values(AdminAuditResultType).map((result) => Type.Literal(result)))),
  fromCreatedAt: Type.Optional(UtcTimestampSchema),
  toCreatedAt: Type.Optional(UtcTimestampSchema),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });

export const AdminAuditListResponseSchema = Type.Object({
  items: Type.Array(AdminAuditDtoSchema, { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100 }),
}, { additionalProperties: false });

export const AdminAuditEndpoint = {
  list: { method: 'GET', path: '/api/v1/admin/audit-events', query: AdminAuditQuerySchema, response: AdminAuditListResponseSchema, successStatus: 200 },
} as const;

export type AdminAuditDto = Static<typeof AdminAuditDtoSchema>;
export type AdminAuditQueryDto = Static<typeof AdminAuditQuerySchema>;
export type AdminAuditListResponseDto = Static<typeof AdminAuditListResponseSchema>;
