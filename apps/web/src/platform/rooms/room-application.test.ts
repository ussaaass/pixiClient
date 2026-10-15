import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { GameRoomSnapshotSchema } from '@gameing/contracts/game-room';
import { createRoomApplication } from './room-application';
import { OfflineRoomAdapter } from './offline-room-adapter';

describe('offline room application', () => {
  it('creates, fills, readies and starts a practice room using the shared DTO', async () => {
    const repository = new OfflineRoomAdapter(false);
    const application = createRoomApplication(repository);
    const created = await application.createRoom({ gameKey: 'SHISANSHUI', difficultyKey: 'ADVANCED' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(Value.Check(GameRoomSnapshotSchema, created.value)).toBe(true);
    expect(application.canStart(created.value)).toBe(false);

    const filled = await application.addPracticeBots(created.value.roomId);
    expect(filled.ok).toBe(true);
    if (!filled.ok) return;
    expect(filled.value.members).toHaveLength(4);
    expect(filled.value.members.filter((member) => member.participantType === 'BOT')).toHaveLength(3);

    const ready = await application.setReady(created.value.roomId, true);
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(application.canStart(ready.value)).toBe(true);

    const started = await application.start(created.value.roomId);
    expect(started).toMatchObject({ ok: true, value: { status: 'PLAYING', stateVersion: 4 } });
    expect((await application.listJoinableRooms())).toHaveLength(0);
  });

  it('joins the local sample room, preserves the owner and requires the current player to ready', async () => {
    const repository = new OfflineRoomAdapter();
    const application = createRoomApplication(repository);
    const joined = await application.joinRoom({ roomCode: 'LG3812' });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.value.members.find((member) => member.isCurrentPlayer)?.seat).toBe(4);
    expect(joined.value.members.find((member) => member.seat === 1)?.displayName).toBe('演练房主');
    expect(application.canStart(joined.value)).toBe(false);

    const ready = await application.setReady(joined.value.roomId, true);
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(application.canStart(ready.value)).toBe(true);
    expect((await application.start(joined.value.roomId)).ok).toBe(true);
  });

  it('returns recoverable business failures and lets the user create instead', async () => {
    const repository = new OfflineRoomAdapter(false);
    const application = createRoomApplication(repository);
    expect(await application.joinRoom({ roomCode: 'ZZ9999' })).toEqual({ ok: false, code: 'ROOM_NOT_FOUND' });

    const privateRoom = await application.createRoom({
      gameKey: 'SHISANSHUI', difficultyKey: 'STRATEGY', roomPassword: 'room-pass',
    });
    expect(privateRoom.ok).toBe(true);
    if (!privateRoom.ok) return;
    expect(await application.joinRoom({ roomCode: privateRoom.value.roomCode, roomPassword: 'wrong' }))
      .toEqual({ ok: false, code: 'INVALID_PASSWORD' });
    expect((await application.listJoinableRooms()).some((room) => room.roomId === privateRoom.value.roomId)).toBe(true);
  });

  it('does not start an incomplete or unready room and closes it on confirmed leave', async () => {
    const repository = new OfflineRoomAdapter(false);
    const application = createRoomApplication(repository);
    const created = await application.createRoom({ gameKey: 'SHISANSHUI', difficultyKey: 'BEGINNER' });
    if (!created.ok) throw new Error('expected room creation');
    expect(await application.start(created.value.roomId)).toEqual({ ok: false, code: 'ROOM_NOT_READY' });

    const closed = await application.leave(created.value.roomId);
    expect(closed).toMatchObject({ ok: true, value: { status: 'CLOSED' } });
    expect(await application.joinRoom({ roomCode: created.value.roomCode })).toEqual({ ok: false, code: 'ROOM_NOT_FOUND' });
  });
});
