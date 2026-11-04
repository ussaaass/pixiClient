import type { AdminManagedUserDto, AdminPermissionAuditDto } from '@gameing/admin-contracts/admin-permissions';
import { AdminApiClient, AdminApiError } from '../admin-api-client.js';
import type { AdminPermissionRepositoryPort } from './admin-permission-application';

export class RemoteAdminPermissionAdapter implements AdminPermissionRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async listUsers(): Promise<AdminManagedUserDto[]> {
    return this.client.get<AdminManagedUserDto[]>('/admin-permissions/users', { pageSize: 100 });
  }

  async findUser(userId: string): Promise<AdminManagedUserDto | null> {
    try {
      return await this.client.get<AdminManagedUserDto>(`/admin-permissions/users/${encodeURIComponent(userId)}`);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async listAudits(targetAdminUserId?: string): Promise<AdminPermissionAuditDto[]> {
    return this.client.get<AdminPermissionAuditDto[]>('/admin-permissions/audits', targetAdminUserId ? { targetAdminUserId } : undefined);
  }

  async findAuditByRequestKey(requestKey: string): Promise<AdminPermissionAuditDto | null> {
    try {
      return await this.client.get<AdminPermissionAuditDto>(`/admin-permissions/audits/request/${encodeURIComponent(requestKey)}`);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async commit(user: AdminManagedUserDto, audit: AdminPermissionAuditDto): Promise<void> {
    try {
      await this.client.post('/admin-permissions/permissions', { user, audit });
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'CONFLICT') {
        throw new Error('ADMIN_PERMISSION_CONFLICT');
      }
      throw error;
    }
  }

  createId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-admin-permission-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  now(): string {
    return new Date().toISOString();
  }
}
