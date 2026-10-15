import { createAdminEventOperationsApplication } from './event-operations-application';
import { IndexedDbAdminEventWorkspaceAdapter } from './indexeddb-event-operations-adapter';

export const localAdminEventOperations = createAdminEventOperationsApplication(new IndexedDbAdminEventWorkspaceAdapter());
