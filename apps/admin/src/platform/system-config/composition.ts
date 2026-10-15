import { createSystemConfigApplication } from './system-config-application';
import { IndexedDbSystemConfigAdapter } from './indexeddb-system-config-adapter';

export const localSystemConfigApplication = createSystemConfigApplication(new IndexedDbSystemConfigAdapter());
