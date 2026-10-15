import { createClientPreferenceApplication } from './client-preference-application';
import { LocalStorageClientPreferenceAdapter } from './local-storage-client-preference-adapter';

export const localClientPreferenceApplication = createClientPreferenceApplication(
  new LocalStorageClientPreferenceAdapter(window.localStorage),
);
