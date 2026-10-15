import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase } from '../browser-development-database';
import type { AdminEventWorkspaceRepository, AdminEventWorkspaceSnapshot } from './event-operations-types';
import { createEmptyAdminEventWorkspace } from './event-operations-application';

export class IndexedDbAdminEventWorkspaceAdapter implements AdminEventWorkspaceRepository {
  private databasePromise: ReturnType<typeof openAdminDevelopmentDatabase> | undefined;
  constructor(private readonly databaseName = ADMIN_DEVELOPMENT_DATABASE) {}

  async read(): Promise<AdminEventWorkspaceSnapshot> {
    const database = await this.database();
    const existing = await database.get('admin_event_workspace_snapshots', 'workspace');
    if (existing) return existing;
    const initial = createEmptyAdminEventWorkspace();
    await database.put('admin_event_workspace_snapshots', initial);
    return initial;
  }
  async transact<T>(change: (current: AdminEventWorkspaceSnapshot) => { readonly next: AdminEventWorkspaceSnapshot; readonly result: T }): Promise<T> {
    const database = await this.database();
    const transaction = database.transaction('admin_event_workspace_snapshots', 'readwrite');
    const store = transaction.objectStore('admin_event_workspace_snapshots');
    const current = await store.get('workspace') ?? createEmptyAdminEventWorkspace();
    const result = change(current);
    if (result.next !== current) await store.put(result.next);
    await transaction.done;
    return result.result;
  }
  createId(): string {
    if (!globalThis.crypto?.randomUUID) throw new Error('SECURE_UUID_UNAVAILABLE');
    return globalThis.crypto.randomUUID();
  }
  now(): string { return new Date().toISOString(); }
  async close(): Promise<void> { const promise = this.databasePromise; this.databasePromise = undefined; if (promise) (await promise).close(); }
  private database(): ReturnType<typeof openAdminDevelopmentDatabase> {
    this.databasePromise ??= openAdminDevelopmentDatabase(this.databaseName);
    return this.databasePromise;
  }
}
