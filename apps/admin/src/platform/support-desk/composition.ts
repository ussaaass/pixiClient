import { createSupportDeskApplication } from './support-desk-application';
import { IndexedDbSupportDeskAdapter } from './indexeddb-support-desk-adapter';

export const localSupportDeskAdapter = new IndexedDbSupportDeskAdapter();
export const localSupportDeskApplication = createSupportDeskApplication(localSupportDeskAdapter);
