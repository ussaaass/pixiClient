import { createAdminUserApplication } from './admin-user-application';
import { LocalDemoAdminUserAdapter } from './local-demo-admin-user-adapter';

export const localDemoAdminUserApplication = createAdminUserApplication(new LocalDemoAdminUserAdapter());
