import { createPlayerEntryApplication } from '@gameing/domain/player-entry';
import { OfflinePlayerIdentityAdapter } from './offline-player-identity-adapter';

export const localPlayerEntryApplication = createPlayerEntryApplication(new OfflinePlayerIdentityAdapter());
