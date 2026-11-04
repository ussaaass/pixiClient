import type {
  AdminRoomDetailDto,
  AdminRoomListResponseDto,
  AdminRoomSummaryDto,
  AdminRoundDetailDto,
  AdminRoundListResponseDto,
  AdminRoundSummaryDto,
} from '@gameing/admin-contracts/admin-game-operations';
import { AdminApiClient } from '../admin-api-client.js';
import type { AdminGameOperationsRepository } from './admin-game-operations-application';

export class RemoteAdminGameOperationsAdapter implements AdminGameOperationsRepository {
  constructor(private readonly client: AdminApiClient) {}

  async listRooms(): Promise<AdminRoomSummaryDto[]> {
    const response = await this.client.get<AdminRoomListResponseDto>('/game-operations/rooms', { pageSize: 100 });
    return response.items;
  }

  async roomDetail(roomId: string): Promise<AdminRoomDetailDto | null> {
    return this.client.get<AdminRoomDetailDto | null>(`/game-operations/rooms/${encodeURIComponent(roomId)}`);
  }

  async listRounds(): Promise<AdminRoundSummaryDto[]> {
    const response = await this.client.get<AdminRoundListResponseDto>('/game-operations/rounds', { pageSize: 100 });
    return response.items;
  }

  async listRoundParticipantIds(roundIds: readonly string[]): Promise<Array<{ roundId: string; playerUserIds: string[] }>> {
    const response = await this.client.post<Record<string, string[]>>('/game-operations/rounds/participant-ids', { roundIds: [...roundIds] });
    return roundIds.map((roundId) => ({ roundId, playerUserIds: response[roundId] ?? [] }));
  }

  async roundDetail(roundId: string): Promise<AdminRoundDetailDto | null> {
    return this.client.get<AdminRoundDetailDto | null>(`/game-operations/rounds/${encodeURIComponent(roundId)}`);
  }
}
