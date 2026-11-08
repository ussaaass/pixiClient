import { describe, expect, it, vi } from 'vitest';
import { RoomStatus, EntryStatus } from '../../../infrastructure/database/models/game.js';
import { RoomJoinUseCase } from './room-join.js';

describe('RoomJoinUseCase idempotent replay', () => {
  it.each([0, -1, 1.5, Number.NaN])('rejects invalid capacity %s before membership or entry access', async (capacity) => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({ status: RoomStatus.WAITING, capacity }),
      findSeatedMembership: vi.fn(),
      seatedCount: vi.fn(),
      joinRoom: vi.fn(),
    };
    const gameEntryRepo = { listEntriesByUser: vi.fn(), claimEntry: vi.fn() };
    const useCase = new RoomJoinUseCase(roomRepo as never, gameEntryRepo as never, {} as never, {
      now: () => new Date('2026-11-06T00:00:00.000Z'),
    });

    await expect(useCase.run({ userId: '42', roomId: '10', tx: {} as never })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(roomRepo.findSeatedMembership).not.toHaveBeenCalled();
    expect(gameEntryRepo.listEntriesByUser).not.toHaveBeenCalled();
  });

  it('rejects impossible seated count before assigning a seat', async () => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({ status: RoomStatus.WAITING, capacity: 4 }),
      findSeatedMembership: vi.fn().mockResolvedValue(null),
      seatedCount: vi.fn().mockResolvedValue(5),
      joinRoom: vi.fn(),
    };
    const gameEntryRepo = { listEntriesByUser: vi.fn(), claimEntry: vi.fn() };
    const useCase = new RoomJoinUseCase(roomRepo as never, gameEntryRepo as never, {} as never, {
      now: () => new Date('2026-11-06T00:00:00.000Z'),
    });

    await expect(useCase.run({ userId: '42', roomId: '10', tx: {} as never })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(roomRepo.joinRoom).not.toHaveBeenCalled();
  });
  it('rejects an inconsistent inserted membership before claiming the game entry', async () => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({ status: RoomStatus.WAITING, capacity: 4 }),
      findSeatedMembership: vi.fn().mockResolvedValue(null),
      seatedCount: vi.fn().mockResolvedValue(0),
      joinRoom: vi.fn().mockResolvedValue({ inserted: true, membership: { id: '90', roomId: '10', userId: '42', seatNo: 2 } }),
    };
    const gameEntryRepo = { listEntriesByUser: vi.fn(), claimEntry: vi.fn() };
    const useCase = new RoomJoinUseCase(roomRepo as never, gameEntryRepo as never, {} as never, {
      now: () => new Date('2026-11-06T00:00:00.000Z'),
    });

    await expect(useCase.run({ userId: '42', roomId: '10', tx: {} as never })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(gameEntryRepo.listEntriesByUser).not.toHaveBeenCalled();
    expect(gameEntryRepo.claimEntry).not.toHaveBeenCalled();
  });

  it.each([
    { id: '0', userId: '42', roomId: null, status: EntryStatus.QUEUED, expiresAt: '2026-12-01T00:00:00.000Z' },
    { id: '3', userId: '99', roomId: null, status: EntryStatus.QUEUED, expiresAt: '2026-12-01T00:00:00.000Z' },
    { id: '3', userId: '42', roomId: '11', status: EntryStatus.SEATED, expiresAt: '2026-12-01T00:00:00.000Z' },
  ])('rejects inconsistent active entry snapshot before claim: %o', async (entry) => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({ status: RoomStatus.WAITING, capacity: 4 }),
      findSeatedMembership: vi.fn().mockResolvedValue(null),
      seatedCount: vi.fn().mockResolvedValue(0),
      joinRoom: vi.fn().mockResolvedValue({ inserted: true, membership: { id: '90', roomId: '10', userId: '42', seatNo: 1 } }),
    };
    const gameEntryRepo = { listEntriesByUser: vi.fn().mockResolvedValue([entry]), claimEntry: vi.fn() };
    const useCase = new RoomJoinUseCase(roomRepo as never, gameEntryRepo as never, {} as never, {
      now: () => new Date('2026-11-06T00:00:00.000Z'),
    });

    await expect(useCase.run({ userId: '42', roomId: '10', tx: {} as never })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(gameEntryRepo.claimEntry).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid persisted entry expiry before seat or claim side effects', async () => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({ status: RoomStatus.WAITING, capacity: 4 }),
      findSeatedMembership: vi.fn().mockResolvedValue(null),
      seatedCount: vi.fn().mockResolvedValue(0),
      joinRoom: vi.fn().mockResolvedValue({ inserted: true, membership: { id: '90', roomId: '10', userId: '42', seatNo: 1 } }),
    };
    const gameEntryRepo = {
      listEntriesByUser: vi
        .fn()
        .mockResolvedValue([{ id: '3', userId: '42', roomId: null, status: EntryStatus.QUEUED, expiresAt: 'not-a-date' }]),
      claimEntry: vi.fn(),
    };
    const useCase = new RoomJoinUseCase(roomRepo as never, gameEntryRepo as never, {} as never, {
      now: () => new Date('2026-11-06T00:00:00.000Z'),
    });

    await expect(useCase.run({ userId: '42', roomId: '10', tx: {} as never })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(roomRepo.joinRoom).toHaveBeenCalledOnce();
    expect(gameEntryRepo.claimEntry).not.toHaveBeenCalled();
  });

  it.each([
    { id: '0', userId: '42', roomId: '10', status: EntryStatus.SEATED, expiresAt: '2026-12-01T00:00:00.000Z' },
    { id: '3', userId: '42', roomId: '11', status: EntryStatus.SEATED, expiresAt: '2026-12-01T00:00:00.000Z' },
  ])('rejects inconsistent replay entry snapshot: %o', async (entry) => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({ status: RoomStatus.WAITING, capacity: 4 }),
      findSeatedMembership: vi.fn().mockResolvedValue({ id: '90', roomId: '10', userId: '42', seatNo: 2 }),
      seatedCount: vi.fn(),
      joinRoom: vi.fn(),
    };
    const gameEntryRepo = { listEntriesByUser: vi.fn().mockResolvedValue([entry]), claimEntry: vi.fn() };
    const useCase = new RoomJoinUseCase(roomRepo as never, gameEntryRepo as never, {} as never, {
      now: () => new Date('2026-11-06T00:00:00.000Z'),
    });

    await expect(useCase.run({ userId: '42', roomId: '10', tx: {} as never })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(roomRepo.joinRoom).not.toHaveBeenCalled();
    expect(roomRepo.seatedCount).not.toHaveBeenCalled();
  });

  it('fails closed on invalid persisted expiry during same-room replay', async () => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({ status: RoomStatus.WAITING, capacity: 4 }),
      findSeatedMembership: vi.fn().mockResolvedValue({ id: '90', roomId: '10', userId: '42', seatNo: 2 }),
      seatedCount: vi.fn(),
      joinRoom: vi.fn(),
    };
    const gameEntryRepo = {
      listEntriesByUser: vi
        .fn()
        .mockResolvedValue([{ id: '3', userId: '42', roomId: '10', status: EntryStatus.SEATED, expiresAt: 'not-a-date' }]),
      claimEntry: vi.fn(),
    };
    const useCase = new RoomJoinUseCase(roomRepo as never, gameEntryRepo as never, {} as never, {
      now: () => new Date('2026-11-06T00:00:00.000Z'),
    });

    await expect(useCase.run({ userId: '42', roomId: '10', tx: {} as never })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(roomRepo.seatedCount).not.toHaveBeenCalled();
    expect(roomRepo.joinRoom).not.toHaveBeenCalled();
  });

  it('rejects replay when the matching seated entry has expired', async () => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({ status: RoomStatus.WAITING, capacity: 4 }),
      findSeatedMembership: vi.fn().mockResolvedValue({ id: '90', roomId: '10', userId: '42', seatNo: 2 }),
      seatedCount: vi.fn(),
      joinRoom: vi.fn(),
    };
    const gameEntryRepo = {
      listEntriesByUser: vi
        .fn()
        .mockResolvedValue([{ id: '3', userId: '42', roomId: '10', status: EntryStatus.SEATED, expiresAt: '2026-11-05T23:59:59.000Z' }]),
      claimEntry: vi.fn(),
    };
    const useCase = new RoomJoinUseCase(roomRepo as never, gameEntryRepo as never, {} as never, {
      now: () => new Date('2026-11-06T00:00:00.000Z'),
    });

    await expect(useCase.run({ userId: '42', roomId: '10', tx: {} as never })).rejects.toMatchObject({ code: 'GAME_ENTRY_EXPIRED' });
    expect(roomRepo.seatedCount).not.toHaveBeenCalled();
    expect(roomRepo.joinRoom).not.toHaveBeenCalled();
  });

  it.each([
    { id: '0', roomId: '10', userId: '42', seatNo: 2 },
    { id: '90', roomId: '11', userId: '42', seatNo: 2 },
    { id: '90', roomId: '10', userId: '99', seatNo: 2 },
    { id: '90', roomId: '10', userId: '42', seatNo: 0 },
    { id: '90', roomId: '10', userId: '42', seatNo: 5 },
  ])('rejects inconsistent persisted membership snapshot %# before entry lookup', async (membership) => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({ status: RoomStatus.WAITING, capacity: 4 }),
      findSeatedMembership: vi.fn().mockResolvedValue(membership),
      seatedCount: vi.fn(),
      joinRoom: vi.fn(),
    };
    const gameEntryRepo = { listEntriesByUser: vi.fn(), claimEntry: vi.fn() };
    const useCase = new RoomJoinUseCase(roomRepo as never, gameEntryRepo as never, {} as never, {
      now: () => new Date('2026-11-06T00:00:00.000Z'),
    });

    await expect(useCase.run({ userId: '42', roomId: '10', tx: {} as never })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(gameEntryRepo.listEntriesByUser).not.toHaveBeenCalled();
    expect(roomRepo.seatedCount).not.toHaveBeenCalled();
    expect(roomRepo.joinRoom).not.toHaveBeenCalled();
  });

  it('does not return success when a queued game entry claim loses its conditional update', async () => {
    const entry = { id: '3', userId: '42', roomId: null, status: EntryStatus.QUEUED, expiresAt: '2099-01-01T00:00:00.000Z' };
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({ status: RoomStatus.WAITING, capacity: 4 }),
      findSeatedMembership: vi.fn().mockResolvedValue(null),
      seatedCount: vi.fn().mockResolvedValue(0),
      joinRoom: vi.fn().mockResolvedValue({ inserted: true, membership: { id: '90', roomId: '10', userId: '42', seatNo: 1 } }),
    };
    const gameEntryRepo = {
      listEntriesByUser: vi.fn().mockResolvedValue([entry]),
      claimEntry: vi.fn().mockResolvedValue({ claimed: false, entry: { ...entry, status: EntryStatus.SEATED, roomId: '11' } }),
    };
    const useCase = new RoomJoinUseCase(roomRepo as never, gameEntryRepo as never, {} as never, {
      now: () => new Date('2026-11-06T00:00:00.000Z'),
    });

    await expect(useCase.run({ userId: '42', roomId: '10', tx: {} as never })).rejects.toMatchObject({ code: 'GAME_ENTRY_NOT_FOUND' });
  });

  it('rejects a successful claim whose reloaded entry belongs to a different room', async () => {
    const entry = { id: '3', userId: '42', roomId: null, status: EntryStatus.QUEUED, expiresAt: '2099-01-01T00:00:00.000Z' };
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({ status: RoomStatus.WAITING, capacity: 4 }),
      findSeatedMembership: vi.fn().mockResolvedValue(null),
      seatedCount: vi.fn().mockResolvedValue(0),
      joinRoom: vi.fn().mockResolvedValue({ inserted: true, membership: { id: '90', roomId: '10', userId: '42', seatNo: 1 } }),
    };
    const gameEntryRepo = {
      listEntriesByUser: vi.fn().mockResolvedValue([entry]),
      claimEntry: vi.fn().mockResolvedValue({ claimed: true, entry: { ...entry, status: EntryStatus.SEATED, roomId: '11' } }),
    };
    const useCase = new RoomJoinUseCase(roomRepo as never, gameEntryRepo as never, {} as never, {
      now: () => new Date('2026-11-06T00:00:00.000Z'),
    });

    await expect(useCase.run({ userId: '42', roomId: '10', tx: {} as never })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('returns existing seat before the full-room check when matching active entry exists', async () => {
    const membership = { id: '90', roomId: '10', userId: '42', seatNo: 2 };
    const entry = { id: '3', userId: '42', roomId: '10', status: EntryStatus.SEATED, expiresAt: '2099-01-01T00:00:00.000Z' };
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({ status: RoomStatus.WAITING, capacity: 4 }),
      findSeatedMembership: vi.fn().mockResolvedValue(membership),
      seatedCount: vi.fn(),
      joinRoom: vi.fn(),
    };
    const gameEntryRepo = { listEntriesByUser: vi.fn().mockResolvedValue([entry]), claimEntry: vi.fn() };
    const useCase = new RoomJoinUseCase(roomRepo as never, gameEntryRepo as never, {} as never, {
      now: () => new Date('2026-11-06T00:00:00.000Z'),
    });

    await expect(useCase.run({ userId: '42', roomId: '10', tx: {} as never })).resolves.toEqual({
      roomId: '10',
      seatNo: 2,
      membershipId: '90',
      roundPlayerId: null,
      replay: true,
    });
    expect(roomRepo.seatedCount).not.toHaveBeenCalled();
    expect(roomRepo.joinRoom).not.toHaveBeenCalled();
    expect(gameEntryRepo.claimEntry).not.toHaveBeenCalled();
  });
});
