import { createPlayerEntryApplication } from './player-entry-application';
import { OfflinePlayerIdentityAdapter } from './offline-player-identity-adapter';

export const localPlayerEntryApplication = createPlayerEntryApplication(new OfflinePlayerIdentityAdapter());
