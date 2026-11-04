import { type AdminReferralRebindResponseDto, type AdminSocialMigrationProcessResponseDto } from '@gameing/admin-contracts/admin-referrals';
import { AdminApiClient } from '../admin-api-client.js';
import type { AdminReferralWorkspaceRepository, AdminReferralWorkspaceSnapshot } from './admin-referral-types';

export class RemoteAdminReferralAdapter implements AdminReferralWorkspaceRepository {
  constructor(private readonly client: AdminApiClient) {}

  async read(): Promise<AdminReferralWorkspaceSnapshot> {
    return this.client.get<AdminReferralWorkspaceSnapshot>('/admin-referrals/workspace');
  }

  async transact<T>(change: (current: AdminReferralWorkspaceSnapshot) => { next: AdminReferralWorkspaceSnapshot; result: T }): Promise<T> {
    const current = await this.read();
    const transition = change(current);
    const result = transition.result;
    if (transition.next !== current) await this.sync(transition.next, result);
    return result;
  }

  private async sync(snapshot: AdminReferralWorkspaceSnapshot, result: unknown): Promise<void> {
    const response = result as AdminReferralRebindResponseDto | AdminSocialMigrationProcessResponseDto | undefined;
    if (response && 'migrationTasks' in response && Array.isArray(response.migrationTasks)) {
      await this.client.post('/admin-referrals/rebinds', {
        requestKey: response.requestKey,
        affectedCount: response.affectedCount,
        eventIds: response.eventIds,
        migrationTasks: response.migrationTasks,
      });
      return;
    }
    if (response && 'task' in response && response.task) {
      await this.client.post(`/admin-referrals/migration-tasks/${encodeURIComponent(response.task.taskId)}/process`);
      return;
    }
    void snapshot;
    await this.client.post('/admin-referrals/workspace/sync');
  }
}
