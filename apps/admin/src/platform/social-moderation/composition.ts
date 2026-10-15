import { createSocialModerationApplication } from './social-moderation-application';
import { IndexedDbSocialModerationAdapter } from './indexeddb-social-moderation-adapter';

export const localSocialModerationAdapter = new IndexedDbSocialModerationAdapter();
export const localSocialModerationApplication = createSocialModerationApplication(localSocialModerationAdapter);
