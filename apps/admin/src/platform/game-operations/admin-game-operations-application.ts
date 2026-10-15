import { Value } from '@sinclair/typebox/value';
import {
  AdminOperationsSource, AdminRoomDetailSchema, AdminRoomListResponseSchema, AdminRoomQuerySchema, AdminRoomSummarySchema,
  AdminRoundDetailSchema, AdminRoundListResponseSchema, AdminRoundQuerySchema,
  type AdminRoomDetailDto, type AdminRoomListResponseDto, type AdminRoomQueryDto,
  type AdminRoomSummaryDto, type AdminRoundDetailDto, type AdminRoundListResponseDto,
  type AdminRoundQueryDto, type AdminRoundSummaryDto,
} from '@gameing/admin-contracts/admin-game-operations';

export type GameOperationsError = 'INVALID_QUERY' | 'NOT_FOUND' | 'INVALID_DATA' | 'READ_FAILED';
export type GameOperationsResult<T> = { ok: true; value: T } | { ok: false; code: GameOperationsError };
export interface AdminGameOperationsRepository {
  listRooms(): Promise<AdminRoomSummaryDto[]>;
  roomDetail(roomId: string): Promise<AdminRoomDetailDto | null>;
  listRounds(): Promise<AdminRoundSummaryDto[]>;
  listRoundParticipantIds(roundIds: readonly string[]): Promise<Array<{ roundId: string; playerUserIds: string[] }>>;
  roundDetail(roundId: string): Promise<AdminRoundDetailDto | null>;
}
export interface AdminGameOperationsApplication {
  rooms(query: unknown): Promise<GameOperationsResult<AdminRoomListResponseDto>>;
  room(roomId: unknown): Promise<GameOperationsResult<AdminRoomDetailDto>>;
  rounds(query: unknown): Promise<GameOperationsResult<AdminRoundListResponseDto>>;
  round(roundId: unknown): Promise<GameOperationsResult<AdminRoundDetailDto>>;
}

const maxId = '18446744073709551615';
const isId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
  && !(value.length === maxId.length && value > maxId);
const page = <T>(items: T[], cursor: string | undefined, pageSize: number | undefined): { items: T[]; total: number; nextCursor: string | null } | null => {
  const offset = cursor ? Number(cursor) : 0;
  const size = pageSize ?? 25;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) return null;
  const selected = items.slice(offset, offset + size);
  const next = offset + selected.length;
  return { items: selected, total: items.length, nextCursor: next < items.length ? String(next) : null };
};
const includes = (source: string, keyword: string | undefined) => !keyword || source.toLocaleLowerCase().includes(keyword.trim().toLocaleLowerCase());

export function createAdminGameOperationsApplication(repository: AdminGameOperationsRepository): AdminGameOperationsApplication {
  return {
    async rooms(query) {
      if (!Value.Check(AdminRoomQuerySchema, query)) return { ok: false, code: 'INVALID_QUERY' };
      try {
        const typed = query as AdminRoomQueryDto;
        const records = await repository.listRooms();
        if (!records.every((entry) => Value.Check(AdminRoomSummarySchema, entry) && isId(entry.roomId))) return { ok: false, code: 'INVALID_DATA' };
        const filtered = records.filter((room) => includes(`${room.roomKey} ${room.roomId}`, typed.keyword)
          && (!typed.gameKey || room.gameKey === typed.gameKey) && (!typed.tierKey || room.tierKey === typed.tierKey)
          && (typed.status === undefined || room.status === typed.status)).sort((a, b) => b.lastChangedAt.localeCompare(a.lastChangedAt));
        const result = page(filtered, typed.cursor, typed.pageSize);
        if (!result) return { ok: false, code: 'INVALID_QUERY' };
        const response: AdminRoomListResponseDto = { ...result, source: AdminOperationsSource.LOCAL_DEMO };
        return Value.Check(AdminRoomListResponseSchema, response) ? { ok: true, value: response } : { ok: false, code: 'INVALID_DATA' };
      } catch { return { ok: false, code: 'READ_FAILED' }; }
    },
    async room(roomId) {
      if (!isId(roomId)) return { ok: false, code: 'INVALID_QUERY' };
      try {
        const result = await repository.roomDetail(roomId);
        if (!result) return { ok: false, code: 'NOT_FOUND' };
        const valid = Value.Check(AdminRoomDetailSchema, result) && isId(result.summary.roomId) && result.members.every((member) => isId(member.userId));
        return valid ? { ok: true, value: result } : { ok: false, code: 'INVALID_DATA' };
      }
      catch { return { ok: false, code: 'READ_FAILED' }; }
    },
    async rounds(query) {
      if (!Value.Check(AdminRoundQuerySchema, query)) return { ok: false, code: 'INVALID_QUERY' };
      const typed = query as AdminRoundQueryDto;
      if (typed.playerUserId !== undefined && !isId(typed.playerUserId)) return { ok: false, code: 'INVALID_QUERY' };
      if (typed.fromCreatedAt && typed.toCreatedAt && typed.fromCreatedAt > typed.toCreatedAt) return { ok: false, code: 'INVALID_QUERY' };
      try {
        const records = await repository.listRounds();
        if (!records.every((entry) => isId(entry.roundId) && isId(entry.roomId) && Value.Check(AdminRoundListResponseSchema, { items: [entry], total: 1, nextCursor: null, source: entry.source }))) return { ok: false, code: 'INVALID_DATA' };
        const participantIds = typed.playerUserId ? await repository.listRoundParticipantIds(records.map((entry) => entry.roundId)) : [];
        if (participantIds.some((item) => !isId(item.roundId) || !records.some((record) => record.roundId === item.roundId) || !item.playerUserIds.every(isId))) return { ok: false, code: 'INVALID_DATA' };
        const playerIds = new Map(participantIds.map((item) => [item.roundId, new Set(item.playerUserIds)]));
        const filtered = records.filter((round) => includes(`${round.roundKey} ${round.roomKey} ${round.roomId}`, typed.keyword)
          && (!typed.gameKey || round.gameKey === typed.gameKey)
          && (!typed.playerUserId || playerIds.get(round.roundId)?.has(typed.playerUserId))
          && (!typed.fromCreatedAt || round.createdAt >= typed.fromCreatedAt)
          && (!typed.toCreatedAt || round.createdAt <= typed.toCreatedAt)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const result = page(filtered, typed.cursor, typed.pageSize);
        if (!result) return { ok: false, code: 'INVALID_QUERY' };
        const response: AdminRoundListResponseDto = { ...result, source: AdminOperationsSource.LOCAL_DEMO };
        return Value.Check(AdminRoundListResponseSchema, response) ? { ok: true, value: response } : { ok: false, code: 'INVALID_DATA' };
      } catch { return { ok: false, code: 'READ_FAILED' }; }
    },
    async round(roundId) {
      if (!isId(roundId)) return { ok: false, code: 'INVALID_QUERY' };
      try {
        const result = await repository.roundDetail(roundId);
        if (!result) return { ok: false, code: 'NOT_FOUND' };
        const valid = Value.Check(AdminRoundDetailSchema, result) && isId(result.summary.roundId) && isId(result.summary.roomId)
          && result.players.every((player) => isId(player.userId)) && result.assetOperationIds.every(isId);
        return valid ? { ok: true, value: result } : { ok: false, code: 'INVALID_DATA' };
      }
      catch { return { ok: false, code: 'READ_FAILED' }; }
    },
  };
}
