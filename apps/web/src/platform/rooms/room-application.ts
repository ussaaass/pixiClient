import { Value } from '@sinclair/typebox/value';
import {
  CreateGameRoomRequestSchema,
  GameRoomSnapshotSchema,
  JoinGameRoomRequestSchema,
  type CreateGameRoomRequestDto,
  type GameRoomSnapshotDto,
  type JoinGameRoomRequestDto,
} from '@gameing/contracts/game-room';
import {
  addCurrentPlayer,
  addPracticeBots,
  canStartRoom,
  closeRoom,
  setCurrentPlayerReady,
  startRoom,
  type RoomFailureCode,
  type RoomResult,
} from './room-domain';

export interface RoomRepositoryPort {
  findById(roomId: string): Promise<GameRoomSnapshotDto | null>;
  findByCode(roomCode: string): Promise<GameRoomSnapshotDto | null>;
  save(snapshot: GameRoomSnapshotDto): Promise<void>;
  listJoinable(): Promise<GameRoomSnapshotDto[]>;
  checkPassword(roomCode: string, password?: string): Promise<boolean>;
  storePassword(roomCode: string, password?: string): Promise<void>;
  createId(): string;
  createCode(): Promise<string>;
}

export type RoomApplicationFailureCode = RoomFailureCode | 'INVALID_REQUEST' | 'ROOM_NOT_FOUND' | 'INVALID_PASSWORD' | 'DUPLICATE_ROOM_CODE';
export type RoomApplicationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: RoomApplicationFailureCode };

function failed<T>(code: RoomApplicationFailureCode): RoomApplicationResult<T> {
  return { ok: false, code };
}

function fromDomain<T>(result: RoomResult<T>): RoomApplicationResult<T> {
  return result.ok ? result : failed(result.code);
}

export interface RoomApplication {
  listJoinableRooms(): Promise<GameRoomSnapshotDto[]>;
  createRoom(request: CreateGameRoomRequestDto): Promise<RoomApplicationResult<GameRoomSnapshotDto>>;
  quickMatch(difficultyKey: CreateGameRoomRequestDto['difficultyKey']): Promise<RoomApplicationResult<GameRoomSnapshotDto>>;
  joinRoom(request: JoinGameRoomRequestDto): Promise<RoomApplicationResult<GameRoomSnapshotDto>>;
  addPracticeBots(roomId: string): Promise<RoomApplicationResult<GameRoomSnapshotDto>>;
  setReady(roomId: string, isReady: boolean): Promise<RoomApplicationResult<GameRoomSnapshotDto>>;
  start(roomId: string): Promise<RoomApplicationResult<GameRoomSnapshotDto>>;
  leave(roomId: string): Promise<RoomApplicationResult<GameRoomSnapshotDto>>;
  canStart(snapshot: GameRoomSnapshotDto): boolean;
}

export function createRoomApplication(repository: RoomRepositoryPort): RoomApplication {
  async function get(roomId: string): Promise<GameRoomSnapshotDto | null> {
    return repository.findById(roomId);
  }

  return {
    listJoinableRooms: () => repository.listJoinable(),

    async createRoom(request) {
      if (!Value.Check(CreateGameRoomRequestSchema, request)) return failed('INVALID_REQUEST');
      const roomCode = await repository.createCode();
      if (await repository.findByCode(roomCode)) return failed('DUPLICATE_ROOM_CODE');
      const initial: GameRoomSnapshotDto = {
        roomId: repository.createId(), roomCode, gameKey: request.gameKey,
        difficultyKey: request.difficultyKey, status: 'WAITING', ownerSeat: 1,
        capacity: 4, stateVersion: 1,
        members: [{ seat: 1, displayName: '你', participantType: 'PLAYER', isReady: false, isCurrentPlayer: true }],
      };
      if (!Value.Check(GameRoomSnapshotSchema, initial)) return failed('INVALID_REQUEST');
      await repository.storePassword(roomCode, request.roomPassword);
      await repository.save(initial);
      return { ok: true, value: initial };
    },

    async quickMatch(difficultyKey) {
      const created = await this.createRoom({ gameKey: 'SHISANSHUI', difficultyKey });
      if (!created.ok) return created;
      const filled = addPracticeBots(created.value);
      if (!filled.ok) return fromDomain(filled);
      await repository.save(filled.value);
      return { ok: true, value: filled.value };
    },

    async joinRoom(request) {
      if (!Value.Check(JoinGameRoomRequestSchema, request)) return failed('INVALID_REQUEST');
      const room = await repository.findByCode(request.roomCode);
      if (!room || room.status !== 'WAITING') return failed('ROOM_NOT_FOUND');
      if (!await repository.checkPassword(request.roomCode, request.roomPassword)) return failed('INVALID_PASSWORD');
      const joined = addCurrentPlayer(room, '你');
      if (!joined.ok) return fromDomain(joined);
      await repository.save(joined.value);
      return { ok: true, value: joined.value };
    },

    async addPracticeBots(roomId) {
      const room = await get(roomId);
      if (!room) return failed('ROOM_NOT_FOUND');
      const updated = addPracticeBots(room);
      if (!updated.ok) return fromDomain(updated);
      await repository.save(updated.value);
      return { ok: true, value: updated.value };
    },

    async setReady(roomId, isReady) {
      const room = await get(roomId);
      if (!room) return failed('ROOM_NOT_FOUND');
      const updated = setCurrentPlayerReady(room, isReady);
      if (!updated.ok) return fromDomain(updated);
      await repository.save(updated.value);
      return { ok: true, value: updated.value };
    },

    async start(roomId) {
      const room = await get(roomId);
      if (!room) return failed('ROOM_NOT_FOUND');
      const started = startRoom(room);
      if (!started.ok) return fromDomain(started);
      await repository.save(started.value);
      return { ok: true, value: started.value };
    },

    async leave(roomId) {
      const room = await get(roomId);
      if (!room) return failed('ROOM_NOT_FOUND');
      const closed = closeRoom(room);
      if (!closed.ok) return fromDomain(closed);
      await repository.save(closed.value);
      return { ok: true, value: closed.value };
    },

    canStart: canStartRoom,
  };
}
