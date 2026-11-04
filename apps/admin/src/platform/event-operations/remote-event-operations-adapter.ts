import type { AdminEventAuditDto } from '@gameing/contracts/event-operations';
import { AdminApiClient } from '../admin-api-client.js';
import type { AdminEventWorkspaceRepository, AdminEventWorkspaceSnapshot } from './event-operations-types';

export class RemoteEventOperationsAdapter implements AdminEventWorkspaceRepository {
  constructor(private readonly client: AdminApiClient) {}

  async read(): Promise<AdminEventWorkspaceSnapshot> {
    return this.client.get<AdminEventWorkspaceSnapshot>('/event-operations/workspace');
  }

  async transact<T>(change: (current: AdminEventWorkspaceSnapshot) => { readonly next: AdminEventWorkspaceSnapshot; readonly result: T }): Promise<T> {
    const current = await this.read();
    const transition = change(current);
    const result = transition.result;
    if (transition.next !== current) await this.sync(transition.next, result);
    return result;
  }

  private async sync(snapshot: AdminEventWorkspaceSnapshot, result: unknown): Promise<void> {
    const value = result as { ok: boolean; value?: unknown };
    const latestAudit = [...snapshot.audits].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const audit = latestAudit as AdminEventAuditDto | undefined;
    if (audit) {
      await this.client.post('/event-operations/sync', {
        action: audit.action,
        resourceId: audit.resourceId,
        requestKey: audit.requestKey,
        reason: audit.reason,
        result: value && value.ok ? value.value : null,
      });
      return;
    }
    await this.client.post('/event-operations/workspace/sync', snapshot);
  }

  createId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-event-op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  now(): string {
    return new Date().toISOString();
  }
}
