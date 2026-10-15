import { createAdminReferralApplication } from './admin-referral-application';
import { createIndexedDbAdminReferralRepository } from './indexeddb-admin-referral-adapter';

export const localDemoAdminReferralApplication = createAdminReferralApplication(createIndexedDbAdminReferralRepository());
