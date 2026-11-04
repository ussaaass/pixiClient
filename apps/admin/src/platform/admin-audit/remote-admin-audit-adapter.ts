import type { AdminAuditDto } from '@gameing/admin-contracts/admin-audit';
import { AdminApiClient } from '../admin-api-client.js';
import type { AdminAuditRepositoryPort } from './admin-audit-application';

export class RemoteAdminAuditAdapter implements AdminAuditRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async listEvents(): Promise<AdminAuditDto[]> {
    return this.client.get<AdminAuditDto[]>('/admin-audit/events', { pageSize: 100 });
  }
}
