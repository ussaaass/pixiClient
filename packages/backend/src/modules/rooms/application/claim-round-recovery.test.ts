import { describe, expect, it, vi } from 'vitest';
import { RoomStatus, RoundStatus } from '../../../infrastructure/database/models/game.js';
import { R } from '../domain/errors.js';
import { createClaimRoundRecoveryUseCase } from './claim-round-recovery.js';

const tx = { transaction: {} };
const room = { id: '20', status: RoomStatus.ACTIVE, fencingToken: '4' };
const round = { id: '10', roomId: '20', status: RoundStatus.ACTIVE, fencingToken: '4' };

function create(replacements: { room?: Partial<typeof room>; round?: Partial<typeof round> } = {}) {
  const order: string[] = [];
  const roomRepo = {
    lockRoom: vi.fn<() => Promise<unknown>>(async () => {
      order.push('lockRoom');
      return { ...room, ...replacements.room };
    }),
    claimRoomRecovery: vi.fn(async () => {
      order.push('claimRoomRecovery');
    }),
  };
  const roundRepo = {
    findRoundRoomId: vi.fn<() => Promise<unknown>>(async () => {
      order.push('findRoundRoomId');
      return { roomId: round.roomId };
    }),
    lockRound: vi.fn<() => Promise<unknown>>(async () => {
      order.push('lockRound');
      return { ...round, ...replacements.round };
    }),
    recoverRound: vi.fn(async () => {
      order.push('recoverRound');
    }),
  };
  return { claim: createClaimRoundRecoveryUseCase({ roomRepo, roundRepo } as never), roomRepo, roundRepo, order };
}

describe('claim round recovery', () => {
  it('rejects a missing round before locking or mutating room state', async () => {
    const { claim, roomRepo, roundRepo } = create();
    roundRepo.findRoundRoomId.mockResolvedValue(null);
    await expect(claim({ roundId: '10', expectedFencingToken: '4', tx })).rejects.toMatchObject({ code: R.ROUND_NOT_FOUND });
    expect(roomRepo.lockRoom).not.toHaveBeenCalled();
    expect(roomRepo.claimRoomRecovery).not.toHaveBeenCalled();
  });

  it('rejects a missing or inactive room before locking or mutating the round', async () => {
    const missing = create();
    missing.roomRepo.lockRoom.mockResolvedValue(null);
    await expect(missing.claim({ roundId: '10', expectedFencingToken: '4', tx })).rejects.toMatchObject({ code: R.ROOM_NOT_FOUND });
    expect(missing.roundRepo.lockRound).not.toHaveBeenCalled();
    expect(missing.roundRepo.recoverRound).not.toHaveBeenCalled();

    const inactive = create({ room: { status: RoomStatus.RECOVERING } as never });
    await expect(inactive.claim({ roundId: '10', expectedFencingToken: '4', tx })).rejects.toMatchObject({ code: R.FENCING_CONFLICT });
    expect(inactive.roundRepo.lockRound).not.toHaveBeenCalled();
    expect(inactive.roundRepo.recoverRound).not.toHaveBeenCalled();
  });

  it('atomically fences room and ACTIVE round using parent-to-child lock order', async () => {
    const { claim, roomRepo, roundRepo, order } = create();
    await expect(claim({ roundId: '10', expectedFencingToken: '4', tx })).resolves.toEqual({
      roomId: '20',
      roundId: '10',
      status: RoundStatus.RECOVERING,
      fencingToken: '5',
    });
    expect(order).toEqual(['findRoundRoomId', 'lockRoom', 'lockRound', 'claimRoomRecovery', 'recoverRound']);
    expect(roomRepo.claimRoomRecovery).toHaveBeenCalledWith({ roomId: '20', expectedFencingToken: '4', newFencingToken: '5', tx });
    expect(roundRepo.recoverRound).toHaveBeenCalledWith({ roundId: '10', expectedFencingToken: '4', newFencingToken: '5', tx });
  });

  it.each([RoundStatus.PREPARING, RoundStatus.SETTLING, RoundStatus.SETTLED, RoundStatus.CANCELLED, RoundStatus.RECOVERING])(
    'refuses non-ACTIVE state %s without changing either fencing token',
    async (status) => {
      const { claim, roomRepo, roundRepo } = create({ round: { status } as never });
      await expect(claim({ roundId: '10', expectedFencingToken: '4', tx })).rejects.toMatchObject({ code: R.ROUND_NOT_ACTIVE });
      expect(roomRepo.claimRoomRecovery).not.toHaveBeenCalled();
      expect(roundRepo.recoverRound).not.toHaveBeenCalled();
    },
  );

  it('rejects a stale room token before locking or changing the round', async () => {
    const { claim, roomRepo, roundRepo } = create({ room: { fencingToken: '5' } });
    await expect(claim({ roundId: '10', expectedFencingToken: '4', tx })).rejects.toMatchObject({ code: R.FENCING_CONFLICT });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
    expect(roomRepo.claimRoomRecovery).not.toHaveBeenCalled();
    expect(roundRepo.recoverRound).not.toHaveBeenCalled();
  });

  it('rejects a stale round token and performs no mutation', async () => {
    const { claim, roomRepo, roundRepo } = create({ round: { fencingToken: '3' } });
    await expect(claim({ roundId: '10', expectedFencingToken: '4', tx })).rejects.toMatchObject({ code: R.FENCING_CONFLICT });
    expect(roomRepo.claimRoomRecovery).not.toHaveBeenCalled();
    expect(roundRepo.recoverRound).not.toHaveBeenCalled();
  });

  it('requires a caller-owned transaction and canonical bounded input', async () => {
    const { claim, roomRepo, roundRepo } = create();
    await expect(claim({ roundId: '10', expectedFencingToken: '4', tx: undefined as never })).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    await expect(claim({ roundId: '01', expectedFencingToken: '4', tx })).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    await expect(claim({ roundId: '10', expectedFencingToken: '18446744073709551616', tx })).rejects.toMatchObject({
      code: R.INVALID_SUBMISSION,
    });
    expect(roundRepo.findRoundRoomId).not.toHaveBeenCalled();
    expect(roomRepo.claimRoomRecovery).not.toHaveBeenCalled();
  });

  it('rejects exhausted room tokens without mutating', async () => {
    const max = '18446744073709551615';
    const { claim, roomRepo, roundRepo } = create({ room: { fencingToken: max }, round: { fencingToken: max } });
    await expect(claim({ roundId: '10', expectedFencingToken: max, tx })).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roomRepo.claimRoomRecovery).not.toHaveBeenCalled();
    expect(roundRepo.recoverRound).not.toHaveBeenCalled();
  });
});
