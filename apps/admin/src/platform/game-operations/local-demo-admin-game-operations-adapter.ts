import type { AdminGameOperationsRepository } from './admin-game-operations-application';
import { localDemoRoomDetails, localDemoRooms, localDemoRoundDetails, localDemoRounds } from './local-demo-admin-game-operations';

export class LocalDemoAdminGameOperationsAdapter implements AdminGameOperationsRepository {
  async listRooms() { return structuredClone([...localDemoRooms]); }
  async roomDetail(roomId: string) { const room = localDemoRoomDetails[roomId]; return room ? structuredClone(room) : null; }
  async listRounds() { return structuredClone([...localDemoRounds]); }
  async listRoundParticipantIds(roundIds: readonly string[]) {
    return roundIds.flatMap((roundId) => {
      const detail = localDemoRoundDetails[roundId];
      return detail ? [{ roundId, playerUserIds: detail.players.map((player) => player.userId) }] : [];
    });
  }
  async roundDetail(roundId: string) { const round = localDemoRoundDetails[roundId]; return round ? structuredClone(round) : null; }
}
