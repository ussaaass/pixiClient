import { describe, expect, it, vi } from 'vitest';
import { RoomStatus, RoundStatus } from '../../../infrastructure/database/models/game.js';
import { R } from '../domain/errors.js';
import { SequelizeRoomRepo, SequelizeRoundRepo } from './sequelize-rooms.js';

const transaction = {};
const tx = { transaction };

describe('Sequelize recovery fencing adapters', () => {
  it('claims room with ACTIVE status and expected token compare-and-swap', async () => {
    const update = vi.fn(async () => [1]);
    const repo = new SequelizeRoomRepo({ RoomModel: { update } } as never);
    await repo.claimRoomRecovery({ roomId: '20', expectedFencingToken: '4', newFencingToken: '5', tx });
    expect(update).toHaveBeenCalledWith(
      { status: RoomStatus.RECOVERING, fencingToken: '5' },
      { where: { id: '20', status: RoomStatus.ACTIVE, fencingToken: '4' }, transaction: tx.transaction },
    );
  });

  it('rejects a lost room CAS rather than claiming recovery', async () => {
    const update = vi.fn(async () => [0]);
    const repo = new SequelizeRoomRepo({ RoomModel: { update } } as never);
    await expect(repo.claimRoomRecovery({ roomId: '20', expectedFencingToken: '4', newFencingToken: '5', tx })).rejects.toMatchObject({
      code: R.FENCING_CONFLICT,
    });
  });

  it('reads only the immutable parent id, never handler or ciphertext columns', async () => {
    const findByPk = vi.fn(async () => ({ roomId: '20' }));
    const repo = new SequelizeRoundRepo({ RoundModel: { findByPk } } as never);
    await expect(repo.findRoundRoomId('10', tx)).resolves.toEqual({ roomId: '20' });
    expect(findByPk).toHaveBeenCalledWith('10', { attributes: ['roomId'], transaction });
  });

  it('updates only ACTIVE round rows still carrying the prior token', async () => {
    const update = vi.fn(async () => [1]);
    const repo = new SequelizeRoundRepo({ RoundModel: { update } } as never);
    await repo.recoverRound({ roundId: '10', expectedFencingToken: '4', newFencingToken: '5', tx });
    expect(update).toHaveBeenCalledWith(
      { status: RoundStatus.RECOVERING, fencingToken: '5' },
      { where: { id: '10', status: RoundStatus.ACTIVE, fencingToken: '4' }, transaction: tx.transaction },
    );
  });

  it('rejects lost round CAS, including concurrent status transitions', async () => {
    const update = vi.fn(async () => [0]);
    const repo = new SequelizeRoundRepo({ RoundModel: { update } } as never);
    await expect(repo.recoverRound({ roundId: '10', expectedFencingToken: '4', newFencingToken: '5', tx })).rejects.toMatchObject({
      code: R.FENCING_CONFLICT,
    });
  });
});
