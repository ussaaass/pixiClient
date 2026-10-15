import type { AnnouncementTemplateChangeDto, AnnouncementTemplateDto } from '@gameing/admin-contracts/announcement-template';
import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase } from '../browser-development-database';
import type { AnnouncementTemplateRepositoryPort } from './announcement-template-application';

export class IndexedDbAnnouncementTemplateAdapter implements AnnouncementTemplateRepositoryPort {
  private databasePromise: ReturnType<typeof openAdminDevelopmentDatabase> | undefined;

  constructor(private readonly databaseName = ADMIN_DEVELOPMENT_DATABASE) {}

  async list(): Promise<AnnouncementTemplateDto[]> { return (await this.database()).getAll('announcement_template_drafts'); }
  async find(templateId: string): Promise<AnnouncementTemplateDto | null> { return (await (await this.database()).get('announcement_template_drafts', templateId)) ?? null; }
  async findChangeByRequestKey(requestKey: string): Promise<AnnouncementTemplateChangeDto | null> {
    return (await (await this.database()).getFromIndex('announcement_template_change_snapshots', 'by-request-key', requestKey)) ?? null;
  }
  async listChanges(templateId: string): Promise<AnnouncementTemplateChangeDto[]> {
    return (await (await this.database()).getAllFromIndex('announcement_template_change_snapshots', 'by-template-created', IDBKeyRange.bound([templateId, ''], [templateId, '\uffff'])))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  async commit(template: AnnouncementTemplateDto, change: AnnouncementTemplateChangeDto): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(['announcement_template_drafts', 'announcement_template_change_snapshots'], 'readwrite');
    const completed = transaction.done;
    try {
      await Promise.all([
        change.previous === null ? transaction.objectStore('announcement_template_drafts').add({ ...template }) : transaction.objectStore('announcement_template_drafts').put({ ...template }),
        transaction.objectStore('announcement_template_change_snapshots').add({ ...change }),
      ]);
      await completed;
    } catch (error) {
      await completed.catch(() => undefined);
      throw error;
    }
  }
  createId(): string {
    if (!globalThis.crypto?.randomUUID) throw new Error('SECURE_UUID_UNAVAILABLE');
    return globalThis.crypto.randomUUID();
  }
  now(): string { return new Date().toISOString(); }
  async close(): Promise<void> {
    const promise = this.databasePromise;
    this.databasePromise = undefined;
    if (promise) (await promise).close();
  }
  private database(): ReturnType<typeof openAdminDevelopmentDatabase> {
    this.databasePromise ??= openAdminDevelopmentDatabase(this.databaseName);
    return this.databasePromise;
  }
}
