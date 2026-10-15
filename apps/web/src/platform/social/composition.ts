import { createSocialApplication } from './social-application';
import { OfflineSocialAdapter } from './offline-social-adapter';

export const localSocialApplication = createSocialApplication(new OfflineSocialAdapter());
