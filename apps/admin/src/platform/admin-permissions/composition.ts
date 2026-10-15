import { createAdminPermissionApplication } from './admin-permission-application';
import { IndexedDbAdminPermissionAdapter } from './indexeddb-admin-permission-adapter';

export const localAdminPermissionApplication = createAdminPermissionApplication(new IndexedDbAdminPermissionAdapter());
