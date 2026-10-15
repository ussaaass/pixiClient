import type { AgentDomainDto } from '@gameing/contracts/invite-agent';
import type { AgentDomainReviewAuditDto } from '@gameing/admin-contracts/agent-domain-review';
import type { AgentDomainReviewRepositoryPort, LocalAgentDomainDemoRepositoryPort } from './agent-domain-review-application';
import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase } from '../browser-development-database';

export class IndexedDbAgentDomainReviewAdapter implements AgentDomainReviewRepositoryPort, LocalAgentDomainDemoRepositoryPort {
  private databasePromise: ReturnType<typeof openAdminDevelopmentDatabase> | undefined;

  constructor(private readonly databaseName = ADMIN_DEVELOPMENT_DATABASE) {}

  async listDomains(): Promise<AgentDomainDto[]> {
    return (await this.database()).getAll('agent_domains');
  }

  async listAudits(userId: string): Promise<AgentDomainReviewAuditDto[]> {
    const audits = await (await this.database()).getAll('agent_domain_review_audit_snapshots');
    return audits.filter((audit) => audit.userId === userId).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async findDomain(userId: string): Promise<AgentDomainDto | null> {
    return (await (await this.database()).get('agent_domains', userId)) ?? null;
  }

  async findAuditByRequestKey(requestKey: string): Promise<AgentDomainReviewAuditDto | null> {
    return (await (await this.database()).getFromIndex('agent_domain_review_audit_snapshots', 'by-request-key', requestKey)) ?? null;
  }

  async createLocalDemoApplication(domain: AgentDomainDto): Promise<void> {
    await (await this.database()).add('agent_domains', { ...domain });
  }

  async commitReview(domain: AgentDomainDto, audit: AgentDomainReviewAuditDto): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(['agent_domains', 'agent_domain_review_audit_snapshots'], 'readwrite');
    const completed = transaction.done;
    try {
      await Promise.all([
        transaction.objectStore('agent_domains').put({ ...domain }),
        transaction.objectStore('agent_domain_review_audit_snapshots').add({ ...audit }),
      ]);
      await completed;
    } catch (error) {
      await completed.catch(() => undefined);
      throw error;
    }
  }

  createUserId(): string {
    const random = new Uint32Array(1);
    globalThis.crypto.getRandomValues(random);
    return `9${Date.now()}${String((random[0] ?? 1) % 100_000).padStart(5, '0')}`;
  }

  createId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-agent-review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  now(): string {
    return new Date().toISOString();
  }

  async close(): Promise<void> {
    const databasePromise = this.databasePromise;
    this.databasePromise = undefined;
    if (databasePromise) (await databasePromise).close();
  }

  private database(): ReturnType<typeof openAdminDevelopmentDatabase> {
    this.databasePromise ??= openAdminDevelopmentDatabase(this.databaseName);
    return this.databasePromise;
  }
}
