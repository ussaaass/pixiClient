import { createAdminGameOperationsApplication } from './admin-game-operations-application';
import { LocalDemoAdminGameOperationsAdapter } from './local-demo-admin-game-operations-adapter';

export const localDemoAdminGameOperationsApplication = createAdminGameOperationsApplication(new LocalDemoAdminGameOperationsAdapter());
