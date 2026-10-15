import type { AdminEventAuditDto, AdminEventDeliveryDto, AdminEventRuleDto, AdminPlatformEventDto } from '@gameing/contracts/event-operations';

export interface AdminEventWorkspaceSnapshot {
  readonly key: 'workspace';
  readonly revision: number;
  readonly rules: readonly AdminEventRuleDto[];
  readonly events: readonly AdminPlatformEventDto[];
  readonly deliveries: readonly AdminEventDeliveryDto[];
  readonly audits: readonly AdminEventAuditDto[];
}

export interface AdminEventWorkspaceRepository {
  read(): Promise<AdminEventWorkspaceSnapshot>;
  transact<T>(change: (current: AdminEventWorkspaceSnapshot) => { readonly next: AdminEventWorkspaceSnapshot; readonly result: T }): Promise<T>;
  createId(): string;
  now(): string;
}
