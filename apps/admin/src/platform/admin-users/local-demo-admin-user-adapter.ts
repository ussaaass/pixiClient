import type { AdminUserDetailSectionResponseDto, AdminUserSummaryDto } from '@gameing/admin-contracts/admin-users';
import type { AdminUserRepositoryPort } from './admin-user-application';
import { localDemoAdminUserSection, LOCAL_DEMO_ADMIN_USER_SUMMARIES } from './local-demo-admin-users';

export class LocalDemoAdminUserAdapter implements AdminUserRepositoryPort {
  async listSummaries(): Promise<AdminUserSummaryDto[]> {
    return structuredClone([...LOCAL_DEMO_ADMIN_USER_SUMMARIES]);
  }

  async readSection(userId: string, section: unknown): Promise<AdminUserDetailSectionResponseDto | null> {
    if (typeof section !== 'string') return null;
    return localDemoAdminUserSection(userId, section);
  }
}
