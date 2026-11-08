import { Value } from '@sinclair/typebox/value';
import {
  AdminManagedUserDtoSchema,
  AdminPermissionAuditDtoSchema,
  AdminPermissionChangeResponseSchema,
  AdminPermissionPathDtoSchema,
  type AdminManagedUserDto,
  type AdminPermissionAuditDto,
  type AdminPermissionChangeResponseDto,
  type AdminPermissionPathDto,
} from '@gameing/admin-contracts/admin-permissions';
import { AdminApiError } from '../admin-api-client.js';
import type { AdminApiClient } from '../admin-api-client.js';
import type { AdminPermissionRepositoryPort } from './admin-permission-application';

export class RemoteAdminPermissionAdapter implements AdminPermissionRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async listPaths(): Promise<AdminPermissionPathDto[]> {
    const paths = await this.client.get<AdminPermissionPathDto[]>('/admin-permissions/permissions');
    if (!Array.isArray(paths) || !paths.every((path) => Value.Check(AdminPermissionPathDtoSchema, path))) {
      throw new AdminApiError('INVALID_RESPONSE', '权限目录 DTO 格式不合法。');
    }
    return paths;
  }

  async listUsers(): Promise<AdminManagedUserDto[]> {
    const users = await this.client.get<Array<AdminManagedUserDto & { authVersion: number | string }>>('/admin-permissions/users', {
      limit: 100,
    });
    if (!Array.isArray(users)) throw new AdminApiError('INVALID_RESPONSE', 'Admin 用户列表 DTO 格式不合法。');
    const normalized = users.map((user) => ({ ...user, authVersion: Number(user.authVersion) }));
    if (!normalized.every((user) => Value.Check(AdminManagedUserDtoSchema, user))) {
      throw new AdminApiError('INVALID_RESPONSE', 'Admin 用户列表 DTO 格式不合法。');
    }
    return normalized;
  }

  async findUser(userId: string): Promise<AdminManagedUserDto | null> {
    try {
      const user = await this.client.get<AdminManagedUserDto & { authVersion: number | string }>(
        `/admin-permissions/users/${encodeURIComponent(userId)}`,
      );
      const normalized = { ...user, authVersion: Number(user.authVersion) };
      if (!Value.Check(AdminManagedUserDtoSchema, normalized)) throw new AdminApiError('INVALID_RESPONSE', 'Admin 用户 DTO 格式不合法。');
      return normalized;
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async listAudits(targetAdminUserId?: string): Promise<AdminPermissionAuditDto[]> {
    if (!targetAdminUserId) return [];
    const audits = await this.client.get<
      Array<AdminPermissionAuditDto & { previousAuthVersion: number | string; nextAuthVersion: number | string }>
    >('/admin-permissions/audits', { targetAdminUserId });
    if (!Array.isArray(audits)) throw new AdminApiError('INVALID_RESPONSE', '权限变更审计 DTO 格式不合法。');
    const normalized = audits.map((audit) => ({
      ...audit,
      previousAuthVersion: Number(audit.previousAuthVersion),
      nextAuthVersion: Number(audit.nextAuthVersion),
    }));
    if (!normalized.every((audit) => Value.Check(AdminPermissionAuditDtoSchema, audit))) {
      throw new AdminApiError('INVALID_RESPONSE', '权限变更审计 DTO 格式不合法。');
    }
    return normalized;
  }

  async findAuditByRequestKey(requestKey: string): Promise<AdminPermissionAuditDto | null> {
    try {
      const audit = await this.client.get<Record<string, unknown>>(`/admin-permissions/audits/request/${encodeURIComponent(requestKey)}`);
      const normalized: AdminPermissionAuditDto = {
        auditId: String(audit.auditId),
        requestKey: String(audit.requestKey),
        adminUserId: String(audit.adminUserId),
        targetAdminUserId: String(audit.targetAdminUserId),
        action: 'PERMISSIONS_UPDATED',
        previousPermissions: audit.previousPermissions as string[],
        nextPermissions: audit.nextPermissions as string[],
        previousAuthVersion: Number(audit.previousAuthVersion),
        nextAuthVersion: Number(audit.nextAuthVersion),
        reason: String(audit.reason),
        source: 2,
        createdAt: String(audit.createdAt),
      };
      if (!Value.Check(AdminPermissionAuditDtoSchema, normalized)) throw new AdminApiError('INVALID_RESPONSE', '权限审计 DTO 格式不合法。');
      return normalized;
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async commit(user: AdminManagedUserDto, audit: AdminPermissionAuditDto): Promise<void> {
    const response = await this.client.patch<{
      replayed: boolean;
      user: Omit<AdminManagedUserDto, 'authVersion'> & { authVersion: number | string };
      audit: Omit<AdminPermissionAuditDto, 'previousAuthVersion' | 'nextAuthVersion'> & {
        previousAuthVersion: number | string;
        nextAuthVersion: number | string;
      };
    }>(`/admin-permissions/users/${encodeURIComponent(user.userId)}/permissions`, {
      targetAdminUserId: user.userId,
      permissionCodes: user.permissions,
      reason: audit.reason,
      requestKey: audit.requestKey,
    });
    const normalized: AdminPermissionChangeResponseDto | null =
      response && response.user && response.audit
        ? {
            replayed: response.replayed,
            user: { ...response.user, authVersion: Number(response.user.authVersion) },
            audit: {
              ...response.audit,
              previousAuthVersion: Number(response.audit.previousAuthVersion),
              nextAuthVersion: Number(response.audit.nextAuthVersion),
            },
          }
        : null;
    if (!normalized || !Value.Check(AdminPermissionChangeResponseSchema, normalized))
      throw new AdminApiError('INVALID_RESPONSE', '权限 API 返回 DTO 格式不合法。');
    if (
      normalized.user.authVersion !== user.authVersion ||
      normalized.user.permissions.slice().sort().join('\n') !== user.permissions.slice().sort().join('\n')
    ) {
      throw new AdminApiError('CONFLICT', '服务端最终权限与本次请求不一致。');
    }
    Object.assign(audit, normalized.audit);
  }

  createId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-admin-permission-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  now(): string {
    return new Date().toISOString();
  }
}
