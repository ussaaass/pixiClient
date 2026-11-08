import { describe, expect, it, vi } from 'vitest';
import { RoomStatus } from '../../../infrastructure/database/models/game.js';
import { R } from '../domain/errors.js';
import type { RoomDomainError } from '../domain/errors.js';
import { RoundStartUseCase } from './round-start.js';

describe('RoundStartUseCase preconditions', () => {
  it.each([
    { index: 0, member: { id: '0', userId: '42', seatNo: 1 } },
    { index: 1, member: { id: '2', userId: '0', seatNo: 2 } },
    { index: 2, member: { id: '3', userId: '88', seatNo: 0 } },
    { index: 3, member: { id: '4', userId: '90', seatNo: 5 } },
  ])('rejects malformed seated membership snapshot before state changes or funds', async ({ index, member }) => {
    const members = [
      { id: '1', userId: '42', seatNo: 1 },
      { id: '2', userId: '77', seatNo: 2 },
      { id: '3', userId: '88', seatNo: 3 },
      { id: '4', userId: '90', seatNo: 4 },
    ];
    members[index] = member;
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({
        id: '10',
        status: RoomStatus.WAITING,
        fencingToken: '3',
        capacity: 4,
        rulesSnapshot: { 'shisanshui.stake': { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' } },
      }),
      listSeated: vi.fn().mockResolvedValue(members),
      markRoomActive: vi.fn(),
    };
    const roundRepo = { findActiveRoundByRoom: vi.fn() };
    const ledger = new Proxy({}, { get: () => vi.fn() });
    const useCase = new RoundStartUseCase(
      roomRepo as never,
      roundRepo as never,
      {} as never,
      ledger as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '42', roomId: '10', fencingToken: '3', waterUnits: '1', tx: {} as never })).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(roomRepo.markRoomActive).not.toHaveBeenCalled();
    expect(roundRepo.findActiveRoundByRoom).not.toHaveBeenCalled();
  });
  it.each(['0', '01', '1'.repeat(21), '-1'])('rejects invalid fencing token %s before repository access', async (fencingToken) => {
    const roomRepo = { lockRoom: vi.fn() };
    const useCase = new RoundStartUseCase(roomRepo as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);

    await expect(
      useCase.run({
        userId: '42',
        roomId: '10',
        fencingToken,
        waterUnits: '1',
        tx: { transaction: {} } as never,
      } as never),
    ).rejects.toMatchObject<Partial<RoomDomainError>>({ code: R.INVALID_SUBMISSION });
    expect(roomRepo.lockRoom).not.toHaveBeenCalled();
  });
  it.each(['0', '-1', '01', '1.5'])('rejects invalid water unit selection %s before repository access', async (waterUnits) => {
    const roomRepo = { lockRoom: vi.fn() };
    const useCase = new RoundStartUseCase(roomRepo as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);

    await expect(
      useCase.run({
        userId: '42',
        roomId: '10',
        fencingToken: '3',
        waterUnits,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject<Partial<RoomDomainError>>({ code: R.INVALID_SUBMISSION });
    expect(roomRepo.lockRoom).not.toHaveBeenCalled();
  });

  it('does not permit client-supplied wager or hold amounts', async () => {
    const roomRepo = { lockRoom: vi.fn() };
    const useCase = new RoundStartUseCase(roomRepo as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);

    await expect(
      useCase.run({
        userId: '42',
        roomId: '10',
        fencingToken: '3',
        wagerCoins: '1',
        maxLossHoldCoins: '1',
        tx: { transaction: {} } as never,
      } as never),
    ).rejects.toMatchObject<Partial<RoomDomainError>>({ code: R.INVALID_SUBMISSION });
    expect(roomRepo.lockRoom).not.toHaveBeenCalled();
  });
});

describe('RoundStartUseCase room snapshot validation', () => {
  it.each([
    {
      fencingToken: '01',
      rulesSnapshot: { 'shisanshui.stake': { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' } },
    },
    { fencingToken: '3', rulesSnapshot: null },
    { fencingToken: '3', rulesSnapshot: [] },
  ])('rejects malformed persisted room state before migration or funds: %o', async (patch) => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({
        id: '10',
        status: RoomStatus.WAITING,
        ...patch,
        fencingToken: patch.fencingToken,
        capacity: 4,
        rulesSnapshot: patch.rulesSnapshot,
      }),
      listSeated: vi.fn().mockResolvedValue([
        { id: '1', userId: '42', seatNo: 1 },
        { id: '2', userId: '77', seatNo: 2 },
        { id: '3', userId: '88', seatNo: 3 },
        { id: '4', userId: '90', seatNo: 4 },
      ]),
      markRoomActive: vi.fn(),
    };
    const roundRepo = { findActiveRoundByRoom: vi.fn() };
    const ledger = new Proxy({}, { get: () => vi.fn() });
    const useCase = new RoundStartUseCase(
      roomRepo as never,
      roundRepo as never,
      {} as never,
      ledger as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '42', roomId: '10', fencingToken: '3', waterUnits: '1', tx: {} as never })).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(roomRepo.markRoomActive).not.toHaveBeenCalled();
    expect(roundRepo.findActiveRoundByRoom).not.toHaveBeenCalled();
  });
});

describe('RoundStartUseCase persisted round snapshot validation', () => {
  it.each([
    { id: '0', roundKey: 'round', status: 1, fencingToken: '3' },
    { id: '20', roundKey: '', status: 1, fencingToken: '3' },
    { id: '20', roundKey: 'round', status: 99, fencingToken: '3' },
    { id: '20', roundKey: 'round', status: 1, fencingToken: '01' },
  ])('rejects malformed active-round replay snapshot before round-player reads: %o', async (round) => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({
        id: '10',
        status: RoomStatus.ACTIVE,
        fencingToken: '4',
        capacity: 4,
        rulesSnapshot: { 'shisanshui.stake': { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' } },
      }),
      listSeated: vi.fn().mockResolvedValue([
        { id: '1', userId: '42', seatNo: 1 },
        { id: '2', userId: '77', seatNo: 2 },
        { id: '3', userId: '88', seatNo: 3 },
        { id: '4', userId: '90', seatNo: 4 },
      ]),
    };
    const roundRepo = { findActiveRoundByRoom: vi.fn().mockResolvedValue(round), listRoundPlayers: vi.fn() };
    const useCase = new RoundStartUseCase(
      roomRepo as never,
      roundRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '42', roomId: '10', fencingToken: '3', waterUnits: '1', tx: {} as never })).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(roundRepo.listRoundPlayers).not.toHaveBeenCalled();
  });
});

describe('RoundStartUseCase idempotent replay', () => {
  it('accepts the original fencing token only when it matches the active round', async () => {
    const seated = [
      { id: '1', userId: '42', seatNo: 1 },
      { id: '2', userId: '77', seatNo: 2 },
      { id: '3', userId: '88', seatNo: 3 },
      { id: '4', userId: '90', seatNo: 4 },
    ];
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({
        id: '10',
        status: RoomStatus.ACTIVE,
        fencingToken: '4',
        capacity: 4,
        rulesSnapshot: { 'shisanshui.stake': { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' } },
      }),
      listSeated: vi.fn().mockResolvedValue(seated),
    };
    const roundRepo = {
      findActiveRoundByRoom: vi.fn().mockResolvedValue({ id: '20', roundKey: 'round', status: 1, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValue([
        { userId: '42', roomMembershipId: '1', seatNo: 1 },
        { userId: '77', roomMembershipId: '2', seatNo: 2 },
        { userId: '88', roomMembershipId: '3', seatNo: 3 },
        { userId: '90', roomMembershipId: '4', seatNo: 4 },
      ]),
    };
    const ledger = new Proxy({}, { get: () => vi.fn() });
    const useCase = new RoundStartUseCase(
      roomRepo as never,
      roundRepo as never,
      {} as never,
      ledger as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '42', roomId: '10', fencingToken: '3', waterUnits: '1', tx: {} as never })).resolves.toMatchObject({
      roundId: '20',
      replay: true,
    });
  });

  it('rejects an active round whose player membership snapshot differs from seated room members', async () => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({
        id: '10',
        status: RoomStatus.ACTIVE,
        fencingToken: '4',
        capacity: 4,
        rulesSnapshot: { 'shisanshui.stake': { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' } },
      }),
      listSeated: vi.fn().mockResolvedValue([
        { id: '1', userId: '42', seatNo: 1 },
        { id: '2', userId: '77', seatNo: 2 },
        { id: '3', userId: '88', seatNo: 3 },
        { id: '4', userId: '90', seatNo: 4 },
      ]),
    };
    const roundRepo = {
      findActiveRoundByRoom: vi.fn().mockResolvedValue({ id: '20', roundKey: 'round', status: 1, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValue([
        { userId: '42', roomMembershipId: '1', seatNo: 1 },
        { userId: '77', roomMembershipId: '2', seatNo: 2 },
        { userId: '88', roomMembershipId: '3', seatNo: 3 },
        { userId: '999', roomMembershipId: 'foreign-membership', seatNo: 4 },
      ]),
    };
    const useCase = new RoundStartUseCase(
      roomRepo as never,
      roundRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '42', roomId: '10', fencingToken: '3', waterUnits: '1', tx: {} as never })).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
  });

  it('rejects an active round with duplicate or mismatched seat assignments', async () => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({
        id: '10',
        status: RoomStatus.ACTIVE,
        fencingToken: '4',
        capacity: 4,
        rulesSnapshot: { 'shisanshui.stake': { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' } },
      }),
      listSeated: vi.fn().mockResolvedValue([
        { id: '1', userId: '42', seatNo: 1 },
        { id: '2', userId: '77', seatNo: 2 },
        { id: '3', userId: '88', seatNo: 3 },
        { id: '4', userId: '90', seatNo: 4 },
      ]),
    };
    const roundRepo = {
      findActiveRoundByRoom: vi.fn().mockResolvedValue({ id: '20', roundKey: 'round', status: 1, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValue([
        { userId: '42', roomMembershipId: '1', seatNo: 1 },
        { userId: '77', roomMembershipId: '2', seatNo: 2 },
        { userId: '88', roomMembershipId: '3', seatNo: 3 },
        { userId: '90', roomMembershipId: '4', seatNo: 3 },
      ]),
    };
    const useCase = new RoundStartUseCase(
      roomRepo as never,
      roundRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '42', roomId: '10', fencingToken: '3', waterUnits: '1', tx: {} as never })).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
  });

  it('rejects replay of a settling round through the start endpoint', async () => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({
        id: '10',
        status: RoomStatus.ACTIVE,
        fencingToken: '4',
        capacity: 4,
        rulesSnapshot: { 'shisanshui.stake': { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' } },
      }),
      listSeated: vi.fn().mockResolvedValue([
        { id: '1', userId: '42', seatNo: 1 },
        { id: '2', userId: '77', seatNo: 2 },
        { id: '3', userId: '88', seatNo: 3 },
        { id: '4', userId: '90', seatNo: 4 },
      ]),
    };
    const roundRepo = {
      findActiveRoundByRoom: vi.fn().mockResolvedValue({ id: '20', roundKey: 'round', status: 3, fencingToken: '3' }),
    };
    const useCase = new RoundStartUseCase(
      roomRepo as never,
      roundRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '42', roomId: '10', fencingToken: '3', waterUnits: '1', tx: {} as never })).rejects.toMatchObject({
      code: R.ROUND_IN_PROGRESS,
    });
  });

  it('rejects an unrelated fencing token when replaying an active round', async () => {
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({
        id: '10',
        status: RoomStatus.ACTIVE,
        fencingToken: '4',
        capacity: 4,
        rulesSnapshot: { 'shisanshui.stake': { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' } },
      }),
      listSeated: vi.fn().mockResolvedValue([
        { id: '1', userId: '42', seatNo: 1 },
        { id: '2', userId: '77', seatNo: 2 },
        { id: '3', userId: '88', seatNo: 3 },
        { id: '4', userId: '90', seatNo: 4 },
      ]),
    };
    const roundRepo = {
      findActiveRoundByRoom: vi.fn().mockResolvedValue({ id: '20', roundKey: 'round', status: 1, fencingToken: '2' }),
    };
    const useCase = new RoundStartUseCase(
      roomRepo as never,
      roundRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '42', roomId: '10', fencingToken: '3', waterUnits: '1', tx: {} as never })).rejects.toMatchObject({
      code: R.FENCING_CONFLICT,
    });
  });
});

describe('RoundStartUseCase malformed room fencing token', () => {
  it('rejects a token above BIGINT UNSIGNED range before state or financial mutations', async () => {
    const members = [
      { id: '1', userId: '42', seatNo: 1 },
      { id: '2', userId: '77', seatNo: 2 },
      { id: '3', userId: '88', seatNo: 3 },
      { id: '4', userId: '90', seatNo: 4 },
    ];
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({
        id: '10',
        status: RoomStatus.WAITING,
        fencingToken: '18446744073709551616',
        capacity: 4,
        rulesSnapshot: { 'shisanshui.stake': { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' } },
      }),
      listSeated: vi.fn().mockResolvedValue(members),
      markRoomActive: vi.fn(),
    };
    const roundRepo = { findActiveRoundByRoom: vi.fn() };
    const ledger = new Proxy({}, { get: () => vi.fn() });
    const useCase = new RoundStartUseCase(
      roomRepo as never,
      roundRepo as never,
      {} as never,
      ledger as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      useCase.run({
        userId: '42',
        roomId: '10',
        fencingToken: '3',
        waterUnits: '1',
        tx: {} as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roomRepo.markRoomActive).not.toHaveBeenCalled();
    expect(roundRepo.findActiveRoundByRoom).not.toHaveBeenCalled();
  });
});

describe('RoundStartUseCase round sequence exhaustion', () => {
  it.each([18_446_744_073_709_551_615n, -1n, 'invalid'])(
    'rejects invalid max round number %s before creating a round',
    async (maxRoundNo) => {
      const members = [
        { id: '1', userId: '42', seatNo: 1 },
        { id: '2', userId: '77', seatNo: 2 },
        { id: '3', userId: '88', seatNo: 3 },
        { id: '4', userId: '90', seatNo: 4 },
      ];
      const roomRepo = {
        lockRoom: vi.fn().mockResolvedValue({
          id: '10',
          status: RoomStatus.WAITING,
          fencingToken: '3',
          capacity: 4,
          rulesSnapshot: { 'shisanshui.stake': { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' } },
        }),
        listSeated: vi.fn().mockResolvedValue(members),
        markRoomActive: vi.fn(),
      };
      const roundRepo = {
        findActiveRoundByRoom: vi.fn().mockResolvedValue(null),
        maxRoundNoByRoom: vi.fn().mockResolvedValue(maxRoundNo),
        createRound: vi.fn(),
      };
      const useCase = new RoundStartUseCase(
        roomRepo as never,
        roundRepo as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(useCase.run({ userId: '42', roomId: '10', fencingToken: '3', waterUnits: '1', tx: {} as never })).rejects.toMatchObject({
        code: R.STORAGE_UNAVAILABLE,
      });
      expect(roundRepo.createRound).not.toHaveBeenCalled();
    },
  );
});

describe('RoundStartUseCase duplicate seated seat validation', () => {
  it('rejects duplicate seat numbers before room transition or financial side effects', async () => {
    const members = [
      { id: '1', userId: '42', seatNo: 1 },
      { id: '2', userId: '77', seatNo: 1 },
      { id: '3', userId: '88', seatNo: 3 },
      { id: '4', userId: '90', seatNo: 4 },
    ];
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({
        id: '10',
        status: RoomStatus.WAITING,
        fencingToken: '3',
        capacity: 4,
        rulesSnapshot: { 'shisanshui.stake': { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' } },
      }),
      listSeated: vi.fn().mockResolvedValue(members),
      markRoomActive: vi.fn(),
    };
    const roundRepo = { findActiveRoundByRoom: vi.fn() };
    const ledger = new Proxy({}, { get: () => vi.fn() });
    const useCase = new RoundStartUseCase(
      roomRepo as never,
      roundRepo as never,
      {} as never,
      ledger as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '42', roomId: '10', fencingToken: '3', waterUnits: '1', tx: {} as never })).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(roomRepo.markRoomActive).not.toHaveBeenCalled();
    expect(roundRepo.findActiveRoundByRoom).not.toHaveBeenCalled();
  });
});

describe('RoundStartUseCase duplicate create snapshot validation', () => {
  it.each([
    { id: '0', roundKey: 'round', status: 1, fencingToken: '3' },
    { id: '20', roundKey: 'round', status: 99, fencingToken: '3' },
  ])('rejects malformed duplicate create result: %o', async (round) => {
    const members = [
      { id: '1', userId: '42', seatNo: 1 },
      { id: '2', userId: '77', seatNo: 2 },
      { id: '3', userId: '88', seatNo: 3 },
      { id: '4', userId: '90', seatNo: 4 },
    ];
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({
        id: '10',
        status: RoomStatus.WAITING,
        fencingToken: '3',
        capacity: 4,
        rulesSnapshot: { 'shisanshui.stake': { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' } },
      }),
      listSeated: vi.fn().mockResolvedValue(members),
      markRoomActive: vi.fn(),
    };
    const roundRepo = {
      findActiveRoundByRoom: vi.fn().mockResolvedValue(null),
      maxRoundNoByRoom: vi.fn().mockResolvedValue(0n),
      createRound: vi.fn().mockResolvedValue({ inserted: false, round }),
      listRoundPlayers: vi.fn(),
    };
    const useCase = new RoundStartUseCase(
      roomRepo as never,
      roundRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '42', roomId: '10', fencingToken: '3', waterUnits: '1', tx: {} as never })).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(roundRepo.listRoundPlayers).not.toHaveBeenCalled();
  });
});

describe('RoundStartUseCase authorization', () => {
  it('derives round wager/hold from the frozen tier policy and locks player balances before affordability checks', async () => {
    const calls: string[] = [];
    const members = [
      { id: '1', userId: '42', seatNo: 1 },
      { id: '2', userId: '77', seatNo: 2 },
      { id: '3', userId: '88', seatNo: 3 },
      { id: '4', userId: '90', seatNo: 4 },
    ];
    const accounts = new Map(
      members.map((member, index) => [
        member.userId,
        { id: String([30, 4, 12, 2][index]), userId: member.userId, assetType: 1, accountType: 1, amount: '100', frozenAmount: '0' },
      ]),
    );
    const roomRepo = {
      lockRoom: vi.fn().mockResolvedValue({
        id: '10',
        status: RoomStatus.WAITING,
        fencingToken: '3',
        capacity: 4,
        rulesSnapshot: { 'shisanshui.stake': { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' } },
      }),
      listSeated: vi.fn().mockResolvedValue(members),
      markRoomActive: vi.fn().mockResolvedValue(undefined),
    };
    const roundRepo = {
      findActiveRoundByRoom: vi.fn().mockResolvedValue(null),
      maxRoundNoByRoom: vi.fn().mockResolvedValue(0n),
      createRound: vi.fn().mockResolvedValue({ inserted: true, round: { id: '20', roundKey: 'round-1', status: 1, fencingToken: '3' } }),
      createRoundPlayer: vi.fn().mockResolvedValue(undefined),
      markRoundActive: vi.fn().mockResolvedValue(undefined),
    };
    const ledger = new Proxy(
      {},
      {
        get:
          (_target, property) =>
          async (...args: unknown[]) => {
            if (property === 'readAccount') return accounts.get(String(args[0]));
            if (property === 'lockAccountsByIds') {
              const ids = args[0] as string[];
              calls.push(`lock:${ids.join(',')}`);
              return ids.map((id) => [...accounts.values()].find((account) => account.id === id));
            }
            if (property === 'claimOperation') {
              calls.push(`claim:${String((args[0] as { initiatedByUserId: string }).initiatedByUserId)}`);
              return { inserted: true, operation: { id: 'op' } };
            }
            if (property === 'postEntries' || property === 'createHold' || property === 'setCommitted')
              return property === 'postEntries' ? [] : property === 'createHold' ? { inserted: true, hold: { id: 'h' } } : undefined;
            return undefined;
          },
      },
    );
    const useCase = new RoundStartUseCase(
      roomRepo as never,
      roundRepo as never,
      { appendRoundEvent: async () => undefined } as never,
      ledger as never,
      { now: () => new Date('2026-01-01T00:00:00.000Z') } as never,
      {} as never,
      {} as never,
    );

    await expect(
      useCase.run({
        userId: '42',
        roomId: '10',
        fencingToken: '3',
        waterUnits: '1',
        tx: { transaction: {} } as never,
      }),
    ).resolves.toMatchObject({ replay: false });
    expect(calls[0]).toBe('lock:2,4,12,30');
    expect(roundRepo.createRound).toHaveBeenCalledWith(
      expect.objectContaining({
        rulesSnapshot: expect.objectContaining({
          appliedStake: {
            policyKey: 'shisanshui.stake',
            coinPerWater: '1',
            waterUnits: '1',
            wagerCoins: '13',
            maxLossHoldCoins: '100',
          },
        }),
      }),
    );
    expect(calls.slice(1)).toEqual(['claim:42', 'claim:77', 'claim:88', 'claim:90']);
  });

  it.each([
    {
      userId: '99',
      members: [
        { id: '1', userId: '42', seatNo: 1 },
        { id: '2', userId: '77', seatNo: 2 },
        { id: '3', userId: '88', seatNo: 3 },
        { id: '4', userId: '90', seatNo: 4 },
      ],
      capacity: 4,
      code: R.ROUND_PLAYER_NOT_FOUND,
    },
    {
      userId: '42',
      members: [
        { id: '1', userId: '42', seatNo: 1 },
        { id: '2', userId: '77', seatNo: 2 },
        { id: '3', userId: '88', seatNo: 3 },
        { id: '4', userId: '90', seatNo: 4 },
      ].slice(0, 1),
      capacity: 4,
      code: R.ROUND_IN_PROGRESS,
    },
    {
      userId: '42',
      members: [
        { id: '1', userId: '42', seatNo: 1 },
        { id: '2', userId: '77', seatNo: 2 },
        { id: '3', userId: '88', seatNo: 3 },
        { id: '4', userId: '90', seatNo: 4 },
      ].slice(0, 2),
      capacity: 4,
      code: R.ROUND_IN_PROGRESS,
    },
    {
      userId: '42',
      members: [
        { id: '1', userId: '42', seatNo: 1 },
        { id: '2', userId: '77', seatNo: 2 },
        { id: '3', userId: '88', seatNo: 3 },
        { id: '4', userId: '42', seatNo: 4 },
      ],
      capacity: 4,
      code: R.STORAGE_UNAVAILABLE,
    },
    {
      userId: '42',
      members: [
        { id: '1', userId: '42', seatNo: 1 },
        { id: '2', userId: '77', seatNo: 2 },
        { id: '3', userId: '88', seatNo: 3 },
        { id: '4', userId: '90', seatNo: 4 },
      ],
      capacity: 2,
      code: R.STORAGE_UNAVAILABLE,
    },
  ])('rejects invalid starters before changing room or touching funds ($code)', async ({ userId, members, capacity, code }) => {
    const calls = { markRoomActive: 0, findActiveRound: 0, ledger: 0 };
    const roomRepo = {
      lockRoom: vi.fn(async () => ({
        id: '10',
        status: RoomStatus.WAITING,
        fencingToken: '3',
        capacity,
        rulesSnapshot: { 'shisanshui.stake': { coinPerWater: '1', minWaterUnits: '1', maxWaterUnits: '10', maxLossHoldCoins: '100' } },
      })),
      listSeated: vi.fn(async () => members),
      markRoomActive: vi.fn(async () => {
        calls.markRoomActive += 1;
      }),
    };
    const roundRepo = {
      findActiveRoundByRoom: vi.fn(async () => {
        calls.findActiveRound += 1;
        return null;
      }),
    };
    const ledger = new Proxy(
      {},
      {
        get: () => async () => {
          calls.ledger += 1;
          throw new Error('ledger must not be touched');
        },
      },
    );
    const useCase = new RoundStartUseCase(
      roomRepo as never,
      roundRepo as never,
      {} as never,
      ledger as never,
      { now: () => new Date('2026-01-01T00:00:00.000Z') } as never,
      {} as never,
      {} as never,
    );

    await expect(
      useCase.run({
        userId,
        roomId: '10',
        fencingToken: '3',
        waterUnits: '1',
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject<Partial<RoomDomainError>>({ code });

    expect(roomRepo.listSeated).toHaveBeenCalledWith('10', { transaction: expect.any(Object) });
    expect(calls).toEqual({ markRoomActive: 0, findActiveRound: 0, ledger: 0 });
  });
});
