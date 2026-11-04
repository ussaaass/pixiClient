import type { AdminUserDetailSectionResponseDto, AdminUserSummaryDto, AdminUserListResponseDto } from '@gameing/admin-contracts/admin-users';
import { AdminApiClient } from '../admin-api-client.js';
import type { AdminUserRepositoryPort } from './admin-user-application';

export class RemoteAdminUserAdapter implements AdminUserRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async listSummaries(): Promise<AdminUserSummaryDto[]> {
    const response = await this.client.get<AdminUserListResponseDto>('/admin-users', { pageSize: 100 });
    return response.items;
  }

  async readSection(userId: string, section: unknown): Promise<AdminUserDetailSectionResponseDto | null> {
    if (typeof section !== 'string') return null;
    return this.client.get<AdminUserDetailSectionResponseDto | null>(
      `/admin-users/${encodeURIComponent(String(userId))}`,
      { section },
    );
  }
}
