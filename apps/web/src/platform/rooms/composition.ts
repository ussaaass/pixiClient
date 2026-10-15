import { createRoomApplication } from './room-application';
import { OfflineRoomAdapter } from './offline-room-adapter';

// The production composition root will inject the HTTP/Socket.IO room adapters.
export const localRoomApplication = createRoomApplication(new OfflineRoomAdapter());
