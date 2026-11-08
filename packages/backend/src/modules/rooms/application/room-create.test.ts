import { describe, expect, it, vi } from 'vitest';
import { RoomStatus } from '../../../infrastructure/database/models/game.js';
import { RoomCreateUseCase } from './room-create.js';

const stakePolicy = { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' };
const validInput = {
  userId: '42',
  gameId: '7',
  gameTierId: '3',
  rulesSnapshot: { version: 1, 'shisanshui.stake': stakePolicy },
  capacity: 4,
  roomType: 1,
  ownerKey: 'server:test',
  tx: {} as never,
};

describe('RoomCreateUseCase input validation', () => {
  it.each([
    { id: '0', roomKey: 'ABC123', status: RoomStatus.WAITING, capacity: 4, ownerKey: 'server:test' },
    { id: '8', roomKey: 'bad', status: RoomStatus.WAITING, capacity: 4, ownerKey: 'server:test' },
    { id: '8', roomKey: 'ABC123', status: 99, capacity: 4, ownerKey: 'server:test' },
    { id: '8', roomKey: 'ABC123', status: RoomStatus.WAITING, capacity: 0, ownerKey: 'server:test' },
    { id: '8', roomKey: 'ABC123', status: RoomStatus.WAITING, capacity: 4, ownerKey: '' },
  ])('rejects malformed persisted room replay before returning it: %o', async (room) => {
    const roomRepo = { createRoom: vi.fn().mockResolvedValue({ inserted: false, room }) };
    const gameEntryRepo = { createEntry: vi.fn() };
    const useCase = new RoomCreateUseCase(roomRepo as never, gameEntryRepo as never, { now: () => new Date('2026-01-01T00:00:00Z') });

    await expect(useCase.run(validInput)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(roomRepo.createRoom).toHaveBeenCalledOnce();
    expect(gameEntryRepo.createEntry).not.toHaveBeenCalled();
  });

  it.each([
    { userId: '0' },
    { userId: '01' },
    { gameId: '-1' },
    { gameTierId: '' },
    { capacity: 0 },
    { capacity: 1.5 },
    { roomType: 0 },
    { ownerKey: '' },
    { rulesSnapshot: [] },
    { rulesSnapshot: null },
  ])('rejects invalid creation fields before repository access: %o', async (patch) => {
    const roomRepo = { createRoom: vi.fn() };
    const gameEntryRepo = { createEntry: vi.fn() };
    const useCase = new RoomCreateUseCase(roomRepo as never, gameEntryRepo as never, { now: () => new Date('2026-01-01T00:00:00Z') });

    await expect(useCase.run({ ...validInput, ...patch } as never)).rejects.toMatchObject({ code: 'INVALID_SUBMISSION' });
    expect(roomRepo.createRoom).not.toHaveBeenCalled();
    expect(gameEntryRepo.createEntry).not.toHaveBeenCalled();
  });

  it('rejects a missing or malformed stake policy before writing a room', async () => {
    const roomRepo = { createRoom: vi.fn() };
    const gameEntryRepo = { createEntry: vi.fn() };
    const useCase = new RoomCreateUseCase(roomRepo as never, gameEntryRepo as never, { now: () => new Date('2026-01-01T00:00:00Z') });

    await expect(useCase.run({ ...validInput, rulesSnapshot: { version: 1 } })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(
      useCase.run({ ...validInput, rulesSnapshot: { 'shisanshui.stake': { ...stakePolicy, maxWaterUnits: '0' } } }),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(roomRepo.createRoom).not.toHaveBeenCalled();
    expect(gameEntryRepo.createEntry).not.toHaveBeenCalled();
  });
});
