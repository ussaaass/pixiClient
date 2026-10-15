import type { GameRoomSnapshotDto } from '@gameing/contracts/game-room';
import type { RoomRepositoryPort } from './room-application';

/** Isolated in-memory adapter for local frontend flow rehearsal. */
export class OfflineRoomAdapter implements RoomRepositoryPort {
  private readonly rooms = new Map<string, GameRoomSnapshotDto>();
  private readonly passwords = new Map<string, string>();
  private nextId = 1n;
  private nextCode = 1;

  constructor(includeJoinablePracticeRoom = true) {
    if (includeJoinablePracticeRoom) {
      const room: GameRoomSnapshotDto = {
        roomId: this.createId(), roomCode: 'LG3812', gameKey: 'SHISANSHUI', difficultyKey: 'BEGINNER',
        status: 'WAITING', ownerSeat: 1, capacity: 4, stateVersion: 1,
        members: [
          { seat: 1, displayName: '演练房主', participantType: 'PLAYER', isReady: true, isCurrentPlayer: false },
          { seat: 2, displayName: '练习机器人 2', participantType: 'BOT', isReady: true, isCurrentPlayer: false },
          { seat: 3, displayName: '练习机器人 3', participantType: 'BOT', isReady: true, isCurrentPlayer: false },
        ],
      };
      this.rooms.set(room.roomId, room);
    }
  }

  async findByCode(roomCode: string): Promise<GameRoomSnapshotDto | null> {
    return [...this.rooms.values()].find((room) => room.roomCode === roomCode) ?? null;
  }

  async findById(roomId: string): Promise<GameRoomSnapshotDto | null> {
    return this.rooms.get(roomId) ?? null;
  }

  async save(snapshot: GameRoomSnapshotDto): Promise<void> {
    this.rooms.set(snapshot.roomId, snapshot);
  }

  async listJoinable(): Promise<GameRoomSnapshotDto[]> {
    return [...this.rooms.values()].filter((room) => room.status === 'WAITING');
  }

  async checkPassword(roomCode: string, password?: string): Promise<boolean> {
    const expected = this.passwords.get(roomCode);
    return expected === undefined ? password === undefined || password.length === 0 : password === expected;
  }

  async storePassword(roomCode: string, password?: string): Promise<void> {
    if (password) this.passwords.set(roomCode, password);
  }

  createId(): string {
    const id = (1_000_000_000_000_000_000n + this.nextId).toString();
    this.nextId += 1n;
    return id;
  }

  async createCode(): Promise<string> {
    const roomCode = `LG${String(3812 + this.nextCode).padStart(4, '0')}`;
    this.nextCode += 1;
    return roomCode;
  }
}
