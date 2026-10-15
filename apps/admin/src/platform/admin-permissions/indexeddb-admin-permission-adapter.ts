import type { AdminManagedUserDto, AdminPermissionAuditDto } from '@gameing/admin-contracts/admin-permissions';
import { AdminManagedUserRoleType, AdminManagedUserStatus, AdminPermissionSource } from '@gameing/admin-contracts/admin-permissions';
import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase } from '../browser-development-database';
import type { AdminPermissionRepositoryPort } from './admin-permission-application';

const LOCAL_ADMIN_PERMISSION_OPERATOR_ID = '90001';
const DEMO_ADMIN_USERS: readonly AdminManagedUserDto[] = [
  { userId: '90002', username: '运营演练管理员', roleType: AdminManagedUserRoleType.ADMIN, status: AdminManagedUserStatus.ACTIVE, permissions: ['admin.users.read', 'admin.audit.read'], authVersion: 1, source: AdminPermissionSource.LOCAL_DEMO },
  { userId: '90003', username: '财务演练管理员', roleType: AdminManagedUserRoleType.ADMIN, status: AdminManagedUserStatus.ACTIVE, permissions: ['admin.users.read', 'admin.support.read'], authVersion: 2, source: AdminPermissionSource.LOCAL_DEMO },
  { userId: '90004', username: '停用演练管理员', roleType: AdminManagedUserRoleType.ADMIN, status: AdminManagedUserStatus.LOCKED, permissions: ['admin.users.read'], authVersion: 3, source: AdminPermissionSource.LOCAL_DEMO },
];

export class IndexedDbAdminPermissionAdapter implements AdminPermissionRepositoryPort {
  private databasePromise: ReturnType<typeof openAdminDevelopmentDatabase> | undefined;
  private seedPromise: Promise<void> | undefined;

  constructor(private readonly databaseName = ADMIN_DEVELOPMENT_DATABASE) {}

  async listUsers(): Promise<AdminManagedUserDto[]> {
    await this.ensureDemoUsers();
    const database = await this.database();
    return (await database.getAll('admin_permission_users')).map((user) => ({ ...user, permissions: [...user.permissions] }));
  }

  async findUser(userId: string): Promise<AdminManagedUserDto | null> {
    await this.ensureDemoUsers();
    const user = await (await this.database()).get('admin_permission_users', userId);
    return user ? { ...user, permissions: [...user.permissions] } : null;
  }

  async listAudits(targetAdminUserId?: string): Promise<AdminPermissionAuditDto[]> {
    const database = await this.database();
    if (!targetAdminUserId) return database.getAll('admin_permission_audit');
    return database.getAllFromIndex('admin_permission_audit', 'by-target-created', IDBKeyRange.bound([targetAdminUserId, ''], [targetAdminUserId, '\uffff']));
  }

  async findAuditByRequestKey(requestKey: string): Promise<AdminPermissionAuditDto | null> {
    return (await (await this.database()).getFromIndex('admin_permission_audit', 'by-request-key', requestKey)) ?? null;
  }

  async commit(user: AdminManagedUserDto, audit: AdminPermissionAuditDto): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(['admin_permission_users', 'admin_permission_audit'], 'readwrite');
    const completed = transaction.done;
    try {
      const current = await transaction.objectStore('admin_permission_users').get(user.userId);
      if (!current || current.status !== AdminManagedUserStatus.ACTIVE || current.authVersion !== audit.previousAuthVersion) throw new Error('ADMIN_PERMISSION_CONFLICT');
      await Promise.all([
        transaction.objectStore('admin_permission_users').put({ ...user, permissions: [...user.permissions] }),
        transaction.objectStore('admin_permission_audit').add({ ...audit, adminUserId: LOCAL_ADMIN_PERMISSION_OPERATOR_ID }),
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

  private ensureDemoUsers(): Promise<void> {
    if (this.seedPromise) return this.seedPromise;
    this.seedPromise = (async () => {
      const database = await this.database();
      const transaction = database.transaction('admin_permission_users', 'readwrite');
      const completed = transaction.done;
      const users = transaction.objectStore('admin_permission_users');
      if (await users.count() === 0) {
        for (const user of DEMO_ADMIN_USERS) await users.add({ ...user, permissions: [...user.permissions] });
      }
      await completed;
    })().catch((error: unknown) => {
      this.seedPromise = undefined;
      throw error;
    });
    return this.seedPromise;
  }
}
