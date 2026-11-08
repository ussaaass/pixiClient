import { describe, expect, it, vi } from 'vitest';
import { EntryStatus, RoundPlayerStatus, RoundStatus, SettlementStatus } from '../../../infrastructure/database/models/game.js';
import { R } from '../domain/errors.js';
import type { RoomDomainError } from '../domain/errors.js';
import { SequelizeGameEntryRepo, SequelizeRoomRepo, SequelizeRoundRepo, SequelizeSettlementRepo } from './sequelize-rooms.js';

function createModels(overrides: {
  status?: number;
  submissionKey?: string | null;
  submissionHash?: Uint8Array | null;
  updatedResult?: Record<string, unknown> | null;
  existingResult?: Record<string, unknown>;
  updateRows?: number;
}) {
  const existing = {
    id: '51',
    roundId: '10',
    userId: '42',
    status: overrides.status ?? RoundPlayerStatus.SUBMITTED,
    submissionType: 1,
    submittedAt: new Date('2026-11-06T13:00:00.000Z'),
    submissionKey: overrides.submissionKey ?? 'sub:rk:42:1',
    submissionHash: overrides.submissionHash ?? Uint8Array.from([1, 2, 3]),
  };
  const RoundPlayerModel = {
    findOne: vi.fn(async () =>
      RoundPlayerModel.update.mock.calls.length > 0
        ? (overrides.updatedResult ?? { ...existing, status: RoundPlayerStatus.SUBMITTED })
        : (overrides.existingResult ?? existing),
    ),
    update: vi.fn(async () => [overrides.updateRows ?? 1]),
  };
  return { models: { RoundPlayerModel } as never, RoundPlayerModel, existing };
}

const input = {
  roundId: '10',
  userId: '42',
  submissionKey: 'sub:rk:42:1',
  submissionSnapshot: { arrangement: {} },
  submissionHash: Uint8Array.from([1, 2, 3]),
  submissionType: 1,
  tx: { transaction: undefined } as never,
};

describe('SequelizeSettlementRepo commit transition', () => {
  it.each([0, 2])('fails closed when commit updates %s rows without reading a row', async (affectedRows) => {
    const SettlementModel = {
      update: vi.fn().mockResolvedValue([affectedRows]),
      findByPk: vi.fn(),
    };
    const repo = new SequelizeSettlementRepo({ SettlementModel } as never);
    await expect(repo.commitSettlement('20', new Date(), {} as never)).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(SettlementModel.findByPk).not.toHaveBeenCalled();
  });

  it('accepts one conditional update and returns the committed row', async () => {
    const row = { id: '20', status: SettlementStatus.COMMITTED };
    const SettlementModel = { update: vi.fn().mockResolvedValue([1]), findByPk: vi.fn().mockResolvedValue(row) };
    const repo = new SequelizeSettlementRepo({ SettlementModel } as never);
    await expect(repo.commitSettlement('20', new Date(), {} as never)).resolves.toBe(row);
  });

  it('fails closed when the committed row cannot be read back', async () => {
    const SettlementModel = { update: vi.fn().mockResolvedValue([1]), findByPk: vi.fn().mockResolvedValue(null) };
    const repo = new SequelizeSettlementRepo({ SettlementModel } as never);
    await expect(repo.commitSettlement('20', new Date(), {} as never)).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
  });
});

describe('SequelizeRoundRepo status transitions', () => {
  it.each([
    ['markRoundActive', RoundStatus.PREPARING, RoundStatus.ACTIVE, { status: RoundStatus.ACTIVE, playingStartedAt: expect.any(Date) }],
    ['markRoundSettling', RoundStatus.ACTIVE, RoundStatus.SETTLING, { status: RoundStatus.SETTLING }],
    ['markRoundSettled', RoundStatus.SETTLING, RoundStatus.SETTLED, { status: RoundStatus.SETTLED, settledAt: expect.any(Date) }],
  ] as const)('%s fails closed unless exactly one source-state row is updated', async (method, sourceStatus, _targetStatus, values) => {
    const RoundModel = { update: vi.fn().mockResolvedValue([0]) };
    const repo = new SequelizeRoundRepo({ RoundModel } as never);

    await expect(repo[method]('10', {} as never)).rejects.toMatchObject<Partial<RoomDomainError>>({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(RoundModel.update).toHaveBeenCalledWith(values, expect.objectContaining({ where: { id: '10', status: sourceStatus } }));
  });

  it.each(['', '01', '+1', '-0', ' 1', '1.0'])('rejects non-canonical round-player delta %j before update', async (netCoinDelta) => {
    const RoundPlayerModel = { update: vi.fn() };
    const repo = new SequelizeRoundRepo({ RoundPlayerModel } as never);
    await expect(repo.markRoundPlayerSettled('51', netCoinDelta, {} as never)).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(RoundPlayerModel.update).not.toHaveBeenCalled();
  });

  it('fails closed when a round-player settlement transition updates no row', async () => {
    const RoundPlayerModel = { update: vi.fn().mockResolvedValue([0]) };
    const repo = new SequelizeRoundRepo({ RoundPlayerModel } as never);

    await expect(repo.markRoundPlayerSettled('51', '0', {} as never)).rejects.toMatchObject<Partial<RoomDomainError>>({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(RoundPlayerModel.update).toHaveBeenCalledWith(
      { status: RoundPlayerStatus.SETTLED, netCoinDelta: '0' },
      expect.objectContaining({ where: { id: '51', status: RoundPlayerStatus.SUBMITTED } }),
    );
  });
});

describe('SequelizeGameEntryRepo.claimEntry', () => {
  it('reports whether the conditional queued-to-seated update actually changed the row', async () => {
    const entry = { id: '3', userId: '42', roomId: '10', status: EntryStatus.SEATED };
    const GameEntryModel = {
      update: vi.fn().mockResolvedValue([0]),
      findByPk: vi.fn().mockResolvedValue(entry),
    };
    const repo = new SequelizeGameEntryRepo({ GameEntryModel } as never);

    await expect(repo.claimEntry({ entryId: '3', roomId: '10', tx: {} as never })).resolves.toEqual({ claimed: false, entry });
    expect(GameEntryModel.update).toHaveBeenCalledWith(
      { status: EntryStatus.SEATED, roomId: '10' },
      expect.objectContaining({ where: { id: '3', status: EntryStatus.QUEUED } }),
    );
  });
});

describe('SequelizeRoomRepo.listRoomsByUser', () => {
  it('only looks up rooms through active seated memberships', async () => {
    const RoomMembershipModel = { findAll: vi.fn().mockResolvedValue([{ roomId: '10' }]) };
    const RoomModel = { findAll: vi.fn().mockResolvedValue([{ id: '10' }]) };
    const repo = new SequelizeRoomRepo({ RoomMembershipModel, RoomModel } as never);
    const transaction = {};
    const tx = { transaction } as never;

    await expect(repo.listRoomsByUser('42', tx)).resolves.toEqual([{ id: '10' }]);

    expect(RoomMembershipModel.findAll).toHaveBeenCalledWith({ where: { userId: '42', status: 1 }, transaction });
    expect(RoomModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: ['10'] }),
        transaction,
      }),
    );
  });
});

describe('SequelizeRoundRepo.submitRound idempotency', () => {
  it('replays only the same key and same content hash', async () => {
    const { models, RoundPlayerModel, existing } = createModels({});
    const repo = new SequelizeRoundRepo(models);

    const result = await repo.submitRound(input);

    expect(result).toEqual({ inserted: false, roundPlayer: existing });
    expect(RoundPlayerModel.update).not.toHaveBeenCalled();
  });

  it.each([
    { roundId: '11' },
    { userId: '43' },
    { submissionType: 2 },
    { id: '0' },
    { submittedAt: null },
    { submittedAt: new Date('invalid') },
  ])('rejects malformed matching replay snapshot: %o', async (mismatch) => {
    const { models, RoundPlayerModel } = createModels({
      existingResult: {
        id: '51',
        roundId: '10',
        userId: '42',
        status: RoundPlayerStatus.SUBMITTED,
        submissionType: 1,
        submittedAt: new Date(),
        submissionKey: input.submissionKey,
        submissionHash: input.submissionHash,
        ...mismatch,
      },
    });
    const repo = new SequelizeRoundRepo(models);
    await expect(repo.submitRound(input)).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(RoundPlayerModel.update).not.toHaveBeenCalled();
  });

  it('rejects updates that report more than one affected row without re-reading', async () => {
    const { models, RoundPlayerModel } = createModels({ status: RoundPlayerStatus.ACTIVE, updateRows: 2 });
    const repo = new SequelizeRoundRepo(models);
    await expect(repo.submitRound(input)).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(RoundPlayerModel.findOne).toHaveBeenCalledOnce();
  });

  it.each([
    { roundId: '11' },
    { userId: '43' },
    { status: RoundPlayerStatus.ACTIVE },
    { submissionKey: 'sub:rk:42:2' },
    { submissionHash: Uint8Array.from([9, 9, 9]) },
    { submissionType: 2 },
  ])('rejects mismatched reloaded row after update: %o', async (mismatch) => {
    const { models } = createModels({
      status: RoundPlayerStatus.ACTIVE,
      updatedResult: {
        id: '51',
        roundId: '10',
        userId: '42',
        status: RoundPlayerStatus.SUBMITTED,
        submissionKey: input.submissionKey,
        submissionHash: input.submissionHash,
        submissionType: 1,
        submittedAt: new Date(),
        ...mismatch,
      },
    });
    const repo = new SequelizeRoundRepo(models);
    await expect(repo.submitRound(input)).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
  });

  it.each([
    { submissionKey: 'sub:rk:42:2', submissionHash: Uint8Array.from([1, 2, 3]) },
    { submissionKey: 'sub:rk:42:1', submissionHash: Uint8Array.from([4, 5, 6]) },
  ])('rejects a submitted row when key or content differs', async ({ submissionKey, submissionHash }) => {
    const { models, RoundPlayerModel } = createModels({});
    const repo = new SequelizeRoundRepo(models);

    await expect(repo.submitRound({ ...input, submissionKey, submissionHash })).rejects.toMatchObject<Partial<RoomDomainError>>({
      code: R.ROUND_NOT_ACTIVE,
    });
    expect(RoundPlayerModel.update).not.toHaveBeenCalled();
  });
});
