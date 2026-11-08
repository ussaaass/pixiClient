import { describe, expect, it, vi } from 'vitest';
import { RoundPlayerStatus, RoundStatus } from '../../../infrastructure/database/models/game.js';
import { R } from '../domain/errors.js';
import { createRoundSnapshotUseCase } from './round-snapshot.js';

const round = {
  id: '10', roomId: '20', roundNo: '3', status: RoundStatus.SETTLED,
  handlerVersion: 'classic-v1', rulesSnapshot: { game: 'shisanshui' }, fencingToken: '4',
};
const players = ['1', '2', '3', '4'].map((userId, index) => ({
  id: String(index + 31), roundId: '10', userId, seatNo: index + 1,
  status: RoundPlayerStatus.SUBMITTED,
  submissionSnapshot: { heldCards: [index], arrangement: { front: [], middle: [], back: [] } },
  netCoinDelta: null,
}));
const event = { roundId: '10', seq: '7', eventKey: 'submit:7', eventType: 2, roundPlayerId: '31', payloadCiphertext: new Uint8Array([1, 2]) };

function create(replacements: Record<string, unknown> = {}) {
  const roundRepo = {
    lockRound: vi.fn(async () => round),
    listRoundPlayers: vi.fn(async () => players),
  };
  const roundEventRepo = { listRoundEventsAfterSeq: vi.fn(async () => [event]) };
  const run = createRoundSnapshotUseCase({ roundRepo, roundEventRepo, ...replacements } as never);
  return { run, roundRepo, roundEventRepo };
}

describe('round snapshot recovery use case', () => {
  it('returns caller-authorized snapshot and cursor events without ciphertext', async () => {
    const { run, roundEventRepo } = create();
    const result = await run({ userId: '1', roundId: '10', afterSeq: '6', limit: 10 }, {} as never);
    expect(result.players[0]?.submissionSnapshot).toEqual({ heldCards: [0], arrangement: { front: [], middle: [], back: [] } });
    expect(result.players.slice(1).every((player) => player.submissionSnapshot === null)).toBe(true);
    expect(result.events).toEqual([{ seq: '7', eventKey: 'submit:7', eventType: 2, roundPlayerId: '31' }]);
    expect(result).not.toHaveProperty('ciphertext');
    expect(roundEventRepo.listRoundEventsAfterSeq).toHaveBeenCalledWith('10', '6', 11, expect.anything());
  });

  it('hides player arrangements before settlement even from their owner', async () => {
    const { run } = create({ roundRepo: { lockRound: vi.fn(async () => ({ ...round, status: RoundStatus.ACTIVE })), listRoundPlayers: vi.fn(async () => players) } });
    const result = await run({ userId: '1', roundId: '10' }, {} as never);
    expect(result.players[0]?.submissionSnapshot).toBeNull();
  });

  it('rejects nonmember before reading events', async () => {
    const { run, roundEventRepo } = create();
    await expect(run({ userId: '99', roundId: '10' }, {} as never)).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundEventRepo.listRoundEventsAfterSeq).not.toHaveBeenCalled();
  });

  it('rejects malformed cursor before repository access', async () => {
    const { run, roundRepo } = create();
    await expect(run({ userId: '1', roundId: '10', afterSeq: '01' })).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects events bound to another round', async () => {
    const { run } = create({ roundEventRepo: { listRoundEventsAfterSeq: vi.fn(async () => [{ ...event, roundId: '99' }]) } });
    await expect(run({ userId: '1', roundId: '10' }, {} as never)).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
  });

  it('does not expose another player event id', async () => {
    const { run } = create({ roundEventRepo: { listRoundEventsAfterSeq: vi.fn(async () => [{ ...event, roundPlayerId: '32' }]) } });
    const result = await run({ userId: '1', roundId: '10' }, {} as never);
    expect(result.events[0]?.roundPlayerId).toBeNull();
  });

  it('returns ROUND_NOT_FOUND for missing rounds', async () => {
    const { run } = create({ roundRepo: { lockRound: vi.fn(async () => null) } });
    await expect(run({ userId: '1', roundId: '10' }, {} as never)).rejects.toMatchObject({ code: R.ROUND_NOT_FOUND });
  });
});
