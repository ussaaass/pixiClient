import type { GameRoomSnapshotDto, RoomMemberSnapshotDto } from '@gameing/contracts/game-room';

export type RoomFailureCode =
  | 'ROOM_CLOSED'
  | 'ROOM_FULL'
  | 'PLAYER_ALREADY_SEATED'
  | 'PLAYER_NOT_FOUND'
  | 'ROOM_NOT_READY'
  | 'ROOM_OWNER_REQUIRED';

export type RoomResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: RoomFailureCode };

function failure<T>(code: RoomFailureCode): RoomResult<T> {
  return { ok: false, code };
}

function updatedRoom(room: GameRoomSnapshotDto, members: RoomMemberSnapshotDto[], status = room.status): GameRoomSnapshotDto {
  return { ...room, members, status, stateVersion: room.stateVersion + 1 };
}

export function addCurrentPlayer(room: GameRoomSnapshotDto, displayName: string): RoomResult<GameRoomSnapshotDto> {
  if (room.status !== 'WAITING') return failure('ROOM_CLOSED');
  if (room.members.some((member) => member.isCurrentPlayer)) return failure('PLAYER_ALREADY_SEATED');
  const seat = [1, 2, 3, 4].find((candidate) => !room.members.some((member) => member.seat === candidate));
  if (seat === undefined) return failure('ROOM_FULL');
  const member: RoomMemberSnapshotDto = { seat, displayName, participantType: 'PLAYER', isReady: false, isCurrentPlayer: true };
  return { ok: true, value: updatedRoom(room, [...room.members, member]) };
}

export function addPracticeBots(room: GameRoomSnapshotDto): RoomResult<GameRoomSnapshotDto> {
  if (room.status !== 'WAITING') return failure('ROOM_CLOSED');
  const members = [...room.members];
  for (const seat of [1, 2, 3, 4]) {
    if (members.some((member) => member.seat === seat)) continue;
    members.push({ seat, displayName: `练习机器人 ${seat}`, participantType: 'BOT', isReady: true, isCurrentPlayer: false });
  }
  if (members.length === room.members.length) return failure('ROOM_FULL');
  return { ok: true, value: updatedRoom(room, members) };
}

export function setCurrentPlayerReady(room: GameRoomSnapshotDto, isReady: boolean): RoomResult<GameRoomSnapshotDto> {
  if (room.status !== 'WAITING') return failure('ROOM_CLOSED');
  const playerIndex = room.members.findIndex((member) => member.isCurrentPlayer);
  if (playerIndex < 0) return failure('PLAYER_NOT_FOUND');
  const members = room.members.map((member, index) => index === playerIndex ? { ...member, isReady } : member);
  return { ok: true, value: updatedRoom(room, members) };
}

export function startRoom(room: GameRoomSnapshotDto): RoomResult<GameRoomSnapshotDto> {
  if (room.status !== 'WAITING') return failure('ROOM_CLOSED');
  if (room.members.length !== room.capacity || room.members.some((member) => !member.isReady)) return failure('ROOM_NOT_READY');
  return { ok: true, value: updatedRoom(room, room.members, 'PLAYING') };
}

export function closeRoom(room: GameRoomSnapshotDto): RoomResult<GameRoomSnapshotDto> {
  if (room.status === 'CLOSED') return failure('ROOM_CLOSED');
  const currentPlayer = room.members.find((member) => member.isCurrentPlayer);
  if (!currentPlayer) return failure('PLAYER_NOT_FOUND');
  if (currentPlayer.seat === room.ownerSeat) return { ok: true, value: updatedRoom(room, room.members, 'CLOSED') };
  return { ok: true, value: updatedRoom(room, room.members.filter((member) => !member.isCurrentPlayer)) };
}

export function canStartRoom(room: GameRoomSnapshotDto): boolean {
  return room.status === 'WAITING' && room.members.length === room.capacity && room.members.every((member) => member.isReady);
}
