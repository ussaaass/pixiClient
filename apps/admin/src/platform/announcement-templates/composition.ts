import { createAnnouncementTemplateApplication } from './announcement-template-application';
import { IndexedDbAnnouncementTemplateAdapter } from './indexeddb-announcement-template-adapter';

export const localAnnouncementTemplateApplication = createAnnouncementTemplateApplication(new IndexedDbAnnouncementTemplateAdapter());
