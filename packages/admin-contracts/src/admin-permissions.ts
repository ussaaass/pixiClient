import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const IdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const UtcTimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });

export const AdminPermissionStatus = { ACTIVE: 1, DISABLED: 2 } as const;
export const AdminPermissionSource = { LOCAL_DEMO: 1, SERVER: 2 } as const;
export const AdminManagedUserStatus = { ACTIVE: 1, LOCKED: 2 } as const;
export const AdminManagedUserRoleType = { ADMIN: 4 } as const;
export const AdminPermissionAction = { PERMISSIONS_UPDATED: 'PERMISSIONS_UPDATED' } as const;

export const AdminPermissionPathDtoSchema = Type.Object({
  permissionCode: Type.String({ pattern: '^[a-z][a-z0-9_.-]{2,127}$' }),
  name: Type.String({ minLength: 1, maxLength: 100 }),
  httpMethod: Type.Union(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => Type.Literal(method))),
  pathPattern: Type.String({ pattern: '^/api/v1/admin(?:/[a-z0-9:_-]+)*$' }),
  status: Type.Union([Type.Literal(AdminPermissionStatus.ACTIVE), Type.Literal(AdminPermissionStatus.DISABLED)]),
}, { additionalProperties: false });

export const AdminManagedUserDtoSchema = Type.Object({
  userId: IdSchema,
  username: Type.String({ minLength: 1, maxLength: 64 }),
  roleType: Type.Literal(AdminManagedUserRoleType.ADMIN),
  status: Type.Union([Type.Literal(AdminManagedUserStatus.ACTIVE), Type.Literal(AdminManagedUserStatus.LOCKED)]),
  permissions: Type.Array(Type.String({ pattern: '^[a-z][a-z0-9_.-]{2,127}$' }), { uniqueItems: true, maxItems: 128 }),
  authVersion: Type.Integer({ minimum: 1 }),
  source: Type.Union([Type.Literal(AdminPermissionSource.LOCAL_DEMO), Type.Literal(AdminPermissionSource.SERVER)]),
}, { additionalProperties: false });

export const AdminPermissionAuditDtoSchema = Type.Object({
  auditId: Type.String({ minLength: 1, maxLength: 128 }),
  requestKey: Type.String({ minLength: 8, maxLength: 128 }),
  adminUserId: IdSchema,
  targetAdminUserId: IdSchema,
  action: Type.Literal(AdminPermissionAction.PERMISSIONS_UPDATED),
  previousPermissions: Type.Array(Type.String({ pattern: '^[a-z][a-z0-9_.-]{2,127}$' }), { uniqueItems: true, maxItems: 128 }),
  nextPermissions: Type.Array(Type.String({ pattern: '^[a-z][a-z0-9_.-]{2,127}$' }), { uniqueItems: true, maxItems: 128 }),
  previousAuthVersion: Type.Integer({ minimum: 1 }),
  nextAuthVersion: Type.Integer({ minimum: 2 }),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
  source: Type.Union([Type.Literal(AdminPermissionSource.LOCAL_DEMO), Type.Literal(AdminPermissionSource.SERVER)]),
  createdAt: UtcTimestampSchema,
}, { additionalProperties: false });

export const AdminPermissionListQuerySchema = Type.Object({
  keyword: Type.Optional(Type.String({ maxLength: 80 })),
  status: Type.Optional(Type.Union([Type.Literal(AdminManagedUserStatus.ACTIVE), Type.Literal(AdminManagedUserStatus.LOCKED)])),
  permissionCode: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9_.-]{2,127}$' })),
}, { additionalProperties: false });

export const AdminPermissionChangeRequestSchema = Type.Object({
  targetAdminUserId: IdSchema,
  permissionCodes: Type.Array(Type.String({ pattern: '^[a-z][a-z0-9_.-]{2,127}$' }), { uniqueItems: true, maxItems: 128 }),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
  requestKey: Type.String({ minLength: 8, maxLength: 128 }),
}, { additionalProperties: false });

export const AdminPermissionChangeResponseSchema = Type.Object({
  user: AdminManagedUserDtoSchema,
  audit: AdminPermissionAuditDtoSchema,
  replayed: Type.Boolean(),
}, { additionalProperties: false });

export type AdminPermissionPathDto = Static<typeof AdminPermissionPathDtoSchema>;
export type AdminManagedUserDto = Static<typeof AdminManagedUserDtoSchema>;
export type AdminPermissionAuditDto = Static<typeof AdminPermissionAuditDtoSchema>;
export type AdminPermissionListQueryDto = Static<typeof AdminPermissionListQuerySchema>;
export type AdminPermissionChangeRequestDto = Static<typeof AdminPermissionChangeRequestSchema>;
export type AdminPermissionChangeResponseDto = Static<typeof AdminPermissionChangeResponseSchema>;
