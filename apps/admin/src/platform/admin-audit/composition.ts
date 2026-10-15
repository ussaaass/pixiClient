import { createAdminAuditApplication } from './admin-audit-application';
import { IndexedDbAdminAuditAdapter } from './indexeddb-admin-audit-adapter';

export const localAdminAuditApplication = createAdminAuditApplication(new IndexedDbAdminAuditAdapter());
