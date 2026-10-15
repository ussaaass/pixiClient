import type {
  AdminReferralAllocationDto,
  AdminReferralEventDto,
  AdminReferralListItemDto,
  AdminReferralRebindResponseDto,
  AdminSocialMigrationTaskDto,
} from '@gameing/admin-contracts/admin-referrals';

export interface AdminReferralWorkspaceSnapshot {
  key: 'workspace';
  revision: number;
  bindings: AdminReferralListItemDto[];
  allocations: AdminReferralAllocationDto[];
  events: AdminReferralEventDto[];
  migrationTasks: AdminSocialMigrationTaskDto[];
  socialCountsByUser: Record<string, AdminSocialMigrationTaskDto['contentCounts']>;
  rebindReceipts: Record<string, AdminReferralRebindResponseDto>;
}

export interface AdminReferralWorkspaceRepository {
  read(): Promise<AdminReferralWorkspaceSnapshot>;
  transact<T>(change: (current: AdminReferralWorkspaceSnapshot) => { next: AdminReferralWorkspaceSnapshot; result: T }): Promise<T>;
}
