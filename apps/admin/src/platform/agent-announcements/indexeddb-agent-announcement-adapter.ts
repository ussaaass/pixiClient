import { AgentAuditActionCode, AgentAuditResultType, type AgentAuditEventDto } from '@gameing/contracts/agent-audit';
import { AgentAnnouncementStatus, type AgentAnnouncementDto } from '@gameing/contracts/agent-announcements';
import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase } from '../browser-development-database';
import type { AgentAnnouncementAudit, AgentAnnouncementRepositoryPort } from './agent-announcement-application';

export class IndexedDbAgentAnnouncementAdapter implements AgentAnnouncementRepositoryPort {
  private databasePromise: ReturnType<typeof openAdminDevelopmentDatabase> | null = null;
  constructor(private readonly actor = { agentDomainId: '92001', agentUserId: '92000' }, private readonly databaseName = ADMIN_DEVELOPMENT_DATABASE) {}
  close(): void { void this.databasePromise?.then((db) => db.close()); this.databasePromise = null; }
  async list(agentDomainId: string): Promise<AgentAnnouncementDto[]> {
    return (await this.database()).getAllFromIndex('agent_announcements', 'by-domain-created', IDBKeyRange.bound([agentDomainId, ''], [agentDomainId, '\uffff']));
  }
  async find(announcementId: string): Promise<AgentAnnouncementDto | null> { return (await (await this.database()).get('agent_announcements', announcementId)) ?? null; }
  async findAuditByRequestKey(requestKey: string) {
    const audit = await (await this.database()).getFromIndex('agent_audit_events', 'by-request-key', requestKey);
    return audit ? { actionCode: audit.actionCode, resourceKey: audit.resourceKey, purpose: audit.purpose, snapshot: audit.snapshot, createdAt: audit.createdAt } : null;
  }
  async create(announcement: AgentAnnouncementDto, audit: AgentAnnouncementAudit): Promise<void> { await this.commit(announcement, audit, false); }
  async update(announcement: AgentAnnouncementDto, audit: AgentAnnouncementAudit): Promise<void> { await this.commit(announcement, audit, true); }
  private async commit(announcement: AgentAnnouncementDto, command: AgentAnnouncementAudit, update: boolean): Promise<void> {
    const db = await this.database();
    const transaction = db.transaction(['agent_announcements', 'agent_audit_events'], 'readwrite');
    const audits = transaction.objectStore('agent_audit_events');
    if (await audits.index('by-request-key').get(command.requestKey)) { transaction.abort(); throw new Error('REQUEST_KEY_REUSED'); }
    const announcements = transaction.objectStore('agent_announcements');
    const current = await announcements.get(announcement.announcementId);
    if (update && !current) { transaction.abort(); throw new Error('NOT_FOUND'); }
    if (!update && current) { transaction.abort(); throw new Error('REQUEST_KEY_REUSED'); }
    await announcements.put(announcement);
    const actionCode = command.actionCode as typeof AgentAuditActionCode[keyof typeof AgentAuditActionCode];
    const audit: AgentAuditEventDto = {
      auditId: createAuditId(), agentDomainId: this.actor.agentDomainId, agentUserId: this.actor.agentUserId,
      actionCode, resourceType: 'ANNOUNCEMENT', resourceKey: announcement.announcementId, purpose: command.reason,
      requestKey: command.requestKey, resultType: AgentAuditResultType.SUCCESS,
      snapshot: { commandHash: command.commandHash, title: announcement.title, status: announcement.status }, createdAt: command.createdAt,
    };
    await audits.add(audit);
    await transaction.done;
  }
  private database(): ReturnType<typeof openAdminDevelopmentDatabase> { return this.databasePromise ??= openAdminDevelopmentDatabase(this.databaseName); }
}
function createAuditId(): string { return String(BigInt(Date.now()) * 1_000_000n + BigInt(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000)); }
