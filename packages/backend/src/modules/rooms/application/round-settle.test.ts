import { describe, expect, it } from 'vitest';
import { RoundPlayerStatus, RoundStatus, SettlementStatus } from '../../../infrastructure/database/models/game.js';
import { R } from '../domain/errors.js';
import { resultHashOf, settlementInputHashOf } from '../domain/round-rules.js';
import { RoundSettleUseCase } from './round-settle.js';

const tx = { transaction: { finished: undefined } };
const makeRound = (status: number) => ({
  id: '10',
  roundKey: 'round-key',
  status,
  fencingToken: '3',
  rulesSnapshot: {},
});
const makePlayer = (userId: string, status: number = RoundPlayerStatus.SUBMITTED) => {
  const hand = Array.from({ length: 13 }, (_, index) => ((Number(userId) - 1) * 13 + index) % 52);
  return {
    id: `rp-${userId}`,
    roundId: '10',
    userId,
    status,
    submissionSnapshot: {
      heldCards: hand,
      arrangement: {
        front: hand.slice(0, 3),
        middle: hand.slice(3, 8),
        back: hand.slice(8),
      },
    },
    wagerCoins: '100',
    maxLossHoldCoins: '500',
    assetHoldId: '10',
  };
};
const makeSettlement = (
  inputHash: Uint8Array<ArrayBufferLike> = new Uint8Array(32),
  resultHash: Uint8Array<ArrayBufferLike> = new Uint8Array(32),
  status: number = SettlementStatus.PREPARED,
) => ({
  id: '20',
  roundId: '10',
  status,
  inputHash,
  resultHash,
  resultSnapshot: {
    players: [
      { playerId: '1', water: 0, foul: false },
      { playerId: '2', water: 0, foul: false },
      { playerId: '3', water: 0, foul: false },
      { playerId: '4', water: 0, foul: false },
    ],
  },
});

function makeUseCase(options: { status: number; players: ReturnType<typeof makePlayer>[]; settlementResult?: unknown }) {
  const settlement = { players: [1, 2, 3, 4].map((seat) => ({ playerId: String(seat), water: 0, foul: false })) };
  const inputHash = new Uint8Array(
    settlementInputHashOf(
      {},
      options.players.map((player) => player.submissionSnapshot as Record<string, unknown>),
    ),
  );
  const resultHash = resultHashOf(settlement);
  const returnedSettlement = { ...makeSettlement(inputHash, resultHash), resultSnapshot: settlement };
  const calls = { findSettlement: 0, settle: 0, ledger: 0, rules: 0, turnover: 0, appendEvent: 0, outbox: 0 };
  const roundRepo = {
    lockRound: async () => ({ ...makeRound(options.status), rulesSnapshot: {} }),
    listRoundPlayers: async () => options.players,
    settleRound: async () => {
      calls.settle += 1;
      return options.settlementResult ?? { inserted: true, settlement: returnedSettlement };
    },
  };
  const settlementRepo = {
    findSettlementByRoundId: async () => {
      calls.findSettlement += 1;
      return makeSettlement();
    },
  };
  const ledger = new Proxy(
    {},
    {
      get: (_target, property) => async () => {
        if (property === 'consumeTurnover') {
          calls.turnover += 1;
          return null;
        }
        calls.ledger += 1;
        throw new Error('ledger must not be touched by these tests');
      },
    },
  );
  const rules = {
    settle: () => {
      calls.rules += 1;
      return settlement;
    },
  };
  const useCase = new RoundSettleUseCase(
    roundRepo as never,
    {} as never,
    settlementRepo as never,
    rules as never,
    ledger as never,
    {} as never,
    { now: () => new Date('2026-01-01T00:00:00.000Z') } as never,
    { append: async () => undefined } as never,
  );
  return { useCase, calls };
}

describe('RoundSettleUseCase fencing token bounds', () => {
  it.each(['0', '01', '18446744073709551616', '1'.repeat(21)])(
    'rejects out-of-range request fencing token %s before reads and writes',
    async (fencingToken) => {
      let settlementReads = 0;
      const roundRepo = {
        lockRound: async () => makeRound(RoundStatus.SETTLING),
        listRoundPlayers: async () => [
          { ...makePlayer('42'), assetHoldId: '1', maxLossHoldCoins: '1' },
          { ...makePlayer('77'), assetHoldId: '2', maxLossHoldCoins: '1' },
          { ...makePlayer('88'), assetHoldId: '3', maxLossHoldCoins: '1' },
          { ...makePlayer('90'), assetHoldId: '4', maxLossHoldCoins: '1' },
        ],
        settleRound: async () => {
          throw new Error('must not persist');
        },
      };
      const settlementRepo = {
        findSettlementByRoundId: async () => {
          settlementReads += 1;
          return makeSettlement();
        },
      };
      const useCase = new RoundSettleUseCase(
        roundRepo as never,
        {} as never,
        settlementRepo as never,
        {} as never,
        {} as never,
        {} as never,
        { now: () => new Date('2026-01-01T00:00:00.000Z') } as never,
        { append: async () => undefined } as never,
      );

      await expect(useCase.run({ userId: '42', roundId: '10', fencingToken, tx: tx as never })).rejects.toMatchObject({
        code: R.FENCING_CONFLICT,
      });
      expect(settlementReads).toBe(0);
    },
  );

  it('rejects malformed stored fencing token before any settlement work', async () => {
    const malformedRound = { ...makeRound(RoundStatus.SETTLING), fencingToken: '18446744073709551616' };
    let settlementReads = 0;
    const useCase = new RoundSettleUseCase(
      {
        lockRound: async () => malformedRound,
        listRoundPlayers: async () => [makePlayer('42')],
        settleRound: async () => {
          throw new Error('must not persist');
        },
      } as never,
      {} as never,
      {
        findSettlementByRoundId: async () => {
          settlementReads += 1;
          return makeSettlement();
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      { now: () => new Date('2026-01-01T00:00:00.000Z') } as never,
      { append: async () => undefined } as never,
    );

    await expect(useCase.run({ userId: '42', roundId: '10', fencingToken: '3', tx: tx as never })).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(settlementReads).toBe(0);
  });
});

describe('RoundSettleUseCase authoritative hand snapshots', () => {
  it.each([
    null,
    {},
    { heldCards: [], arrangement: { front: [], middle: [], back: [] } },
    {
      heldCards: Array.from({ length: 13 }, (_, index) => index),
      arrangement: { front: [0, 1, 2, 3], middle: [4, 5, 6, 7, 8], back: [9, 10, 11, 12] },
    },
    {
      heldCards: Array.from({ length: 13 }, (_, index) => index),
      arrangement: { front: [13, 14, 15], middle: [16, 17, 18, 19, 20], back: [21, 22, 23, 24, 25] },
    },
  ])('rejects absent, malformed, or out-of-hand arrangement snapshots before scoring and ledger writes: %o', async (submissionSnapshot) => {
    const players = [1, 2, 3, 4].map((id) => ({
      ...makePlayer(String(id)),
      submissionSnapshot: id === 1 ? submissionSnapshot : makePlayer(String(id)).submissionSnapshot,
    }));
    let settleCalls = 0;
    let ledgerCalls = 0;
    const useCase = new RoundSettleUseCase(
      {
        lockRound: async () => makeRound(RoundStatus.SETTLING),
        listRoundPlayers: async () => players,
      } as never,
      {} as never,
      {
        findSettlementByRoundId: async () => null,
        createSettlement: async () => {
          throw new Error('must not persist');
        },
      } as never,
      {
        settle: () => {
          settleCalls += 1;
          return { players: [1, 2, 3, 4].map((id) => ({ playerId: String(id), water: 0, foul: false })) };
        },
      } as never,
      new Proxy(
        {},
        {
          get: () => async () => {
            ledgerCalls += 1;
            return null;
          },
        },
      ) as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never)).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(settleCalls).toBe(0);
    expect(ledgerCalls).toBe(0);
  });

  it('rejects sparse and accessor-based authoritative hands before scoring', async () => {
    const sparse = Array.from({ length: 13 }, (_, index) => index);
    delete sparse[5];
    let handGetterCalls = 0;
    const accessor = Array.from({ length: 13 }, (_, index) => index);
    Object.defineProperty(accessor, '0', {
      get: () => {
        handGetterCalls += 1;
        return 0;
      },
      enumerable: true,
      configurable: true,
    });
    let pileGetterCalls = 0;
    let snapshotGetterCalls = 0;
    let metadataGetterCalls = 0;
    const accessorArrangement = { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] };
    Object.defineProperty(accessorArrangement, 'front', {
      get: () => {
        pileGetterCalls += 1;
        return [0, 1, 2];
      },
      enumerable: true,
      configurable: true,
    });
    for (const submissionSnapshot of [
      { ...makePlayer('1').submissionSnapshot, heldCards: sparse },
      { ...makePlayer('1').submissionSnapshot, heldCards: accessor },
      (() => {
        const snapshot = { ...makePlayer('1').submissionSnapshot } as Record<string, unknown>;
        Object.defineProperty(snapshot, 'submissionKey', {
          get: () => {
            metadataGetterCalls += 1;
            return 'not-read';
          },
          enumerable: true,
          configurable: true,
        });
        Object.defineProperty(snapshot, 'heldCards', {
          get: () => {
            snapshotGetterCalls += 1;
            return makePlayer('1').submissionSnapshot.heldCards;
          },
          enumerable: true,
          configurable: true,
        });
        Object.defineProperty(snapshot, 'arrangement', {
          value: accessorArrangement,
          enumerable: true,
        });
        return snapshot;
      })(),
    ]) {
      const players = [1, 2, 3, 4].map((id) => ({
        ...makePlayer(String(id)),
        submissionSnapshot: id === 1 ? submissionSnapshot : makePlayer(String(id)).submissionSnapshot,
      }));
      let settleCalls = 0;
      const useCase = new RoundSettleUseCase(
        { lockRound: async () => makeRound(RoundStatus.SETTLING), listRoundPlayers: async () => players } as never,
        {} as never,
        { findSettlementByRoundId: async () => null } as never,
        {
          settle: () => {
            settleCalls += 1;
            return { players: [] };
          },
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      await expect(useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never)).rejects.toMatchObject({
        code: R.STORAGE_UNAVAILABLE,
      });
      expect(settleCalls).toBe(0);
    }
    expect(handGetterCalls).toBe(0);
    expect(pileGetterCalls).toBe(0);
    expect(snapshotGetterCalls).toBe(0);
    expect(metadataGetterCalls).toBe(0);
  });

  it('rejects duplicate cards across authoritative players before scoring or ledger access', async () => {
    const sharedHand = Array.from({ length: 13 }, (_, index) => index);
    const sharedArrangement = { front: sharedHand.slice(0, 3), middle: sharedHand.slice(3, 8), back: sharedHand.slice(8) };
    const players = [1, 2, 3, 4].map((id) => ({
      ...makePlayer(String(id)),
      submissionSnapshot: { heldCards: [...sharedHand], arrangement: sharedArrangement },
    }));
    let settleCalls = 0;
    const useCase = new RoundSettleUseCase(
      { lockRound: async () => makeRound(RoundStatus.SETTLING), listRoundPlayers: async () => players } as never,
      {} as never,
      { findSettlementByRoundId: async () => null } as never,
      {
        settle: () => {
          settleCalls += 1;
          return { players: [] };
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never)).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(settleCalls).toBe(0);
  });
});

describe('RoundSettleUseCase player authorization and fencing', () => {
  it.each([
    ['wrong round', { roundId: '999' }],
    ['wrong status', { status: SettlementStatus.COMMITTED }],
    ['wrong input hash', { inputHash: new Uint8Array(32).fill(1) }],
    ['short result hash', { resultHash: new Uint8Array(2) }],
    ['malformed envelope', { inserted: 'yes', settlement: makeSettlement() }],
  ])('rejects repository settlement result with %s before ledger access', async (_label, settlementResult) => {
    const resultSnapshot = { players: [1, 2, 3, 4].map((seat) => ({ playerId: String(seat), water: 0, foul: false })) };
    const testPlayers = [1, 2, 3, 4].map((seat) => ({
      ...makePlayer(String(seat)),
      assetHoldId: String(seat + 10),
      maxLossHoldCoins: '10',
    }));
    const validReturnedRow = {
      ...makeSettlement(
        new Uint8Array(
          settlementInputHashOf(
            {},
            testPlayers.map((player) => player.submissionSnapshot as Record<string, unknown>),
          ),
        ),
        resultHashOf(resultSnapshot),
      ),
      resultSnapshot,
    };
    const testUseCase = new RoundSettleUseCase(
      {
        lockRound: async () => ({ ...makeRound(RoundStatus.SETTLING), rulesSnapshot: {} }),
        listRoundPlayers: async () => testPlayers,
        settleRound: async () =>
          settlementResult && typeof settlementResult === 'object' && 'inserted' in settlementResult
            ? settlementResult
            : { inserted: true, settlement: { ...validReturnedRow, ...(settlementResult as Record<string, unknown>) } },
      } as never,
      {} as never,
      {} as never,
      { settle: () => ({ players: resultSnapshot.players }) } as never,
      {
        readAccount: async () => ({ id: '500' }),
        lockAccountsByIds: async () => [{ id: '500', userId: 'system-user', assetType: 1, accountType: 2 }],
      } as never,
      { systemUserId: 'system-user' } as never,
      {} as never,
      {} as never,
    );
    await expect(testUseCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never)).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
  });
  it('rejects scoring output outside safe integer range before persistence and ledger access', async () => {
    const calls = { persist: 0, ledger: 0 };
    const useCase = new RoundSettleUseCase(
      {
        lockRound: async () => makeRound(RoundStatus.SETTLING),
        listRoundPlayers: async () =>
          [1, 2, 3, 4].map((seat) => ({
            ...makePlayer(String(seat)),
            assetHoldId: String(seat + 10),
            maxLossHoldCoins: '10',
          })),
        settleRound: async () => {
          calls.persist += 1;
          throw new Error('settlement must not be persisted');
        },
      } as never,
      {} as never,
      {} as never,
      {
        settle: () => ({
          players: [
            { playerId: '1', water: Number.MAX_SAFE_INTEGER + 1, foul: false },
            { playerId: '2', water: -Number.MAX_SAFE_INTEGER, foul: false },
            { playerId: '3', water: -1, foul: false },
            { playerId: '4', water: 0, foul: false },
          ],
        }),
      } as never,
      new Proxy({}, { get: () => async () => (calls.ledger += 1) }) as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never)).rejects.toBeInstanceOf(RangeError);
    expect(calls).toEqual({ persist: 0, ledger: 0 });
  });
  it.each([RoundStatus.SETTLED, RoundStatus.SETTLING])(
    'rejects a non-member before replay or settlement side effects (status %s)',
    async (status) => {
      const players = [1, 2, 3, 4].map((userId) =>
        status === RoundStatus.SETTLED ? { userId: String(userId), status: RoundPlayerStatus.SETTLED } : makePlayer(String(userId)),
      ) as ReturnType<typeof makePlayer>[];
      const { useCase, calls } = makeUseCase({ status, players });

      await expect(useCase.run({ userId: '99', roundId: '10', tx } as never)).rejects.toMatchObject({
        code: R.ROUND_PLAYER_NOT_FOUND,
      });
      expect(calls).toMatchObject({ findSettlement: 0, settle: 0, ledger: 0, rules: 0, turnover: 0 });
    },
  );

  it.each([undefined, '2', '0', '01', '-1', '1'.repeat(21)])(
    'rejects a member-triggered settlement with invalid fencing token %s',
    async (fencingToken) => {
      const { useCase, calls } = makeUseCase({
        status: RoundStatus.SETTLING,
        players: [makePlayer('1'), makePlayer('2'), makePlayer('3'), makePlayer('4')],
      });

      await expect(useCase.run({ userId: '1', roundId: '10', fencingToken, tx } as never)).rejects.toMatchObject({
        code: R.FENCING_CONFLICT,
      });
      expect(calls).toMatchObject({ findSettlement: 0, settle: 0, ledger: 0, rules: 0, turnover: 0 });
    },
  );

  it.each([
    (() => {
      const players = [makePlayer('1'), makePlayer('2'), makePlayer('3'), makePlayer('4')];
      delete players[2];
      return players;
    })(),
    new Proxy([makePlayer('1'), makePlayer('2'), makePlayer('3'), makePlayer('4')], {
      ownKeys: () => {
        throw new Error('trap');
      },
    }),
    [makePlayer('1'), makePlayer('2'), makePlayer('3'), Object.assign(Object.create({ inherited: true }), makePlayer('4'))],
    [
      makePlayer('1'),
      makePlayer('2'),
      makePlayer('3'),
      Object.defineProperty(makePlayer('4'), 'userId', { get: () => '4', enumerable: true }),
    ],
  ] as unknown[])('rejects malformed player set before settlement effects', async (players: unknown) => {
    const useCase = new RoundSettleUseCase(
      { lockRound: async () => makeRound(RoundStatus.SETTLING), listRoundPlayers: async () => players } as never,
      {} as never,
      {
        findSettlementByRoundId: async () => {
          throw new Error('must not read settlement');
        },
      } as never,
      {
        settle: () => {
          throw new Error('must not score');
        },
      } as never,
      new Proxy(
        {},
        {
          get: () => async () => {
            throw new Error('must not use ledger');
          },
        },
      ) as never,
      {} as never,
      { now: () => new Date('2026-01-01T00:00:00.000Z') } as never,
      {
        append: async () => {
          throw new Error('must not append outbox');
        },
      } as never,
    );
    await expect(useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx: tx as never })).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
  });

  it('rejects SETTLING rounds containing duplicate player identities before settlement effects', async () => {
    const { useCase, calls } = makeUseCase({
      status: RoundStatus.SETTLING,
      players: [makePlayer('1'), makePlayer('2'), makePlayer('3'), makePlayer('1')],
    });

    await expect(useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never)).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(calls).toMatchObject({ findSettlement: 0, settle: 0, ledger: 0, rules: 0, turnover: 0 });
  });

  it.each([RoundPlayerStatus.ACTIVE, RoundPlayerStatus.ABORTED])(
    'rejects SETTLING rounds with a player not submitted (status %s)',
    async (invalidStatus) => {
      const { useCase, calls } = makeUseCase({
        status: RoundStatus.SETTLING,
        players: [makePlayer('1'), makePlayer('2'), makePlayer('3'), makePlayer('4', invalidStatus)],
      });

      await expect(useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never)).rejects.toMatchObject({
        code: R.STORAGE_UNAVAILABLE,
      });
      expect(calls).toMatchObject({ findSettlement: 0, settle: 0, ledger: 0, rules: 0, turnover: 0 });
    },
  );

  it.each([{ players: [] }, { players: [1, 2, 3, 4, 5] }])(
    'rejects settled replay snapshots with invalid player count %j',
    async ({ players }) => {
      const snapshot = {
        id: '20',
        roundId: '10',
        resultSnapshot: { players: players.map((playerId) => ({ playerId: String(playerId), water: 0, foul: false })) },
      };
      const replayUseCase = new RoundSettleUseCase(
        { lockRound: async () => makeRound(RoundStatus.SETTLED), listRoundPlayers: async () => [makePlayer('1')] } as never,
        {} as never,
        { findSettlementByRoundId: async () => snapshot } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      await expect(replayUseCase.run({ userId: '1', roundId: '10', tx } as never)).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    },
  );

  it('rejects scoring output with missing or foreign players before persistence', async () => {
    const roundPlayers = [makePlayer('1'), makePlayer('2'), makePlayer('3'), makePlayer('4')];
    const settleRound = async () => {
      throw new Error('settlement must not be persisted');
    };
    const useCase = new RoundSettleUseCase(
      { lockRound: async () => makeRound(RoundStatus.SETTLING), listRoundPlayers: async () => roundPlayers, settleRound } as never,
      {} as never,
      {} as never,
      {
        settle: () => ({
          players: [
            { playerId: '1', water: 0, foul: false },
            { playerId: '2', water: 0, foul: false },
            { playerId: '3', water: 0, foul: false },
            { playerId: '99', water: 0, foul: false },
          ],
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never)).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
  });

  it('rejects a concurrent settlement replay with an invalid persisted result before ledger effects', async () => {
    const players = [1, 2, 3, 4].map((seat) => ({
      ...makePlayer(String(seat), RoundPlayerStatus.SETTLED),
      id: `rp${seat}`,
      assetHoldId: String(seat + 10),
      maxLossHoldCoins: '10',
    }));
    const calls = { ledger: 0 };
    const badReplaySnapshot = { players: [1, 2, 3, 4].map((seat) => ({ playerId: String(seat), water: seat === 1 ? 1 : 0, foul: false })) };
    const badReplayRow = { ...makeSettlement(new Uint8Array(32), resultHashOf(badReplaySnapshot)), resultSnapshot: badReplaySnapshot };
    const useCase = new RoundSettleUseCase(
      {
        lockRound: async () => ({ ...makeRound(RoundStatus.SETTLING), rulesSnapshot: {} }),
        listRoundPlayers: async () => players,
        settleRound: async () => ({ inserted: false, settlement: badReplayRow }),
      } as never,
      {} as never,
      {
        findSettlementByRoundId: async () => badReplayRow,
      } as never,
      { settle: () => ({ players: [1, 2, 3, 4].map((seat) => ({ playerId: String(seat), water: 0, foul: false })) }) } as never,
      new Proxy(
        {},
        {
          get:
            (_target, property) =>
            async (...args: unknown[]) => {
              calls.ledger += 1;
              if (property === 'readAccount')
                return args[0] === 'system-user'
                  ? { id: '90', userId: 'system-user', assetType: 1, accountType: 2 }
                  : { id: String(args[0]), userId: String(args[0]), assetType: 1, accountType: 1 };
              if (property === 'lockAccountsByIds') return [];
              return undefined;
            },
        },
      ) as never,
      { systemUserId: 'system-user' } as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never)).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(calls.ledger).toBe(6);
  });

  it('returns a valid concurrent settlement replay without repeating ledger effects', async () => {
    const players = [1, 2, 3, 4].map((seat) => ({
      ...makePlayer(String(seat)),
      id: `rp${seat}`,
      assetHoldId: String(seat + 10),
      maxLossHoldCoins: '10',
    }));
    const calls = { ledger: 0, turnover: 0 };
    const replaySnapshot = { players: [1, 2, 3, 4].map((seat) => ({ playerId: String(seat), water: 0, foul: false })) };
    const replaySettlement = {
      ...makeSettlement(
        new Uint8Array(
          settlementInputHashOf(
            {},
            players.map((player) => player.submissionSnapshot as Record<string, unknown>),
          ),
        ),
        resultHashOf(replaySnapshot),
      ),
      resultSnapshot: replaySnapshot,
    };
    const useCase = new RoundSettleUseCase(
      {
        lockRound: async () => ({ ...makeRound(RoundStatus.SETTLING), rulesSnapshot: {} }),
        listRoundPlayers: async () => players,
        settleRound: async () => ({ inserted: false, settlement: replaySettlement }),
      } as never,
      {} as never,
      { findSettlementByRoundId: async () => replaySettlement } as never,
      { settle: () => ({ players: [1, 2, 3, 4].map((seat) => ({ playerId: String(seat), water: 0, foul: false })) }) } as never,
      new Proxy(
        {},
        {
          get:
            (_target, property) =>
            async (...args: unknown[]) => {
              calls.ledger += 1;
              if (property === 'readAccount')
                return args[0] === 'system-user'
                  ? { id: '90', userId: 'system-user', assetType: 1, accountType: 2 }
                  : { id: String(args[0]), userId: String(args[0]), assetType: 1, accountType: 1 };
              if (property === 'lockAccountsByIds')
                return (args[0] as string[]).map((id) => ({
                  id,
                  userId: id === '90' ? 'system-user' : id,
                  assetType: 1,
                  accountType: id === '90' ? 2 : 1,
                }));
              if (property === 'consumeTurnover') {
                calls.turnover += 1;
                return null;
              }
              return undefined;
            },
        },
      ) as never,
      { systemUserId: 'system-user' } as never,
      {} as never,
      {} as never,
    );

    const result = await useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never);
    expect(result.replay).toBe(true);
    expect(calls.ledger).toBe(6);
    expect(calls.turnover).toBe(0);
  });

  it('rejects malformed player wager and hold snapshots before scoring or ledger access', async () => {
    for (const malformed of [
      { wagerCoins: '0', maxLossHoldCoins: '10', assetHoldId: '11' },
      { wagerCoins: '01', maxLossHoldCoins: '10', assetHoldId: '11' },
      { wagerCoins: '-1', maxLossHoldCoins: '10', assetHoldId: '11' },
      { wagerCoins: '10000000000000000000', maxLossHoldCoins: '10', assetHoldId: '11' },
      { maxLossHoldCoins: '0', assetHoldId: '11' },
      { maxLossHoldCoins: '01', assetHoldId: '11' },
      { maxLossHoldCoins: '-1', assetHoldId: '11' },
      { maxLossHoldCoins: '10', assetHoldId: '0' },
      { maxLossHoldCoins: '100000000000000000000', assetHoldId: '11' },
    ]) {
      const players = [1, 2, 3, 4].map((seat) => ({
        ...makePlayer(String(seat)),
        maxLossHoldCoins: '10',
        assetHoldId: String(seat + 10),
      }));
      Object.assign(players[0]!, malformed);
      let scoreCalls = 0;
      let ledgerCalls = 0;
      const useCase = new RoundSettleUseCase(
        { lockRound: async () => makeRound(RoundStatus.SETTLING), listRoundPlayers: async () => players } as never,
        {} as never,
        {} as never,
        {
          settle: () => {
            scoreCalls += 1;
            throw new Error('scoring must not run');
          },
        } as never,
        new Proxy(
          {},
          {
            get: () => async () => {
              ledgerCalls += 1;
            },
          },
        ) as never,
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never)).rejects.toMatchObject({
        code: R.STORAGE_UNAVAILABLE,
      });
      expect(scoreCalls).toBe(0);
      expect(ledgerCalls).toBe(0);
    }
  });

  it('rejects incomplete or misowned settlement account lock snapshot before settlement ledger operations', async () => {
    const calls: string[] = [];
    const players = [1, 2, 3, 4].map((seat) => ({
      ...makePlayer(String(seat)),
      id: `rp${seat}`,
      assetHoldId: String(seat + 10),
      maxLossHoldCoins: '10',
    }));
    const useCase = new RoundSettleUseCase(
      {
        lockRound: async () => makeRound(RoundStatus.SETTLING),
        listRoundPlayers: async () => players,
        settleRound: async () => ({ inserted: true, settlement: { id: '20', roundId: '10', resultSnapshot: {} } }),
      } as never,
      {} as never,
      {
        findSettlementByRoundId: async () => ({
          id: '20',
          roundId: '10',
          resultSnapshot: { players: [1, 2, 3, 4].map((seat) => ({ playerId: String(seat), water: 0, foul: false })) },
        }),
      } as never,
      { settle: () => ({ players: [1, 2, 3, 4].map((seat) => ({ playerId: String(seat), water: 0, foul: false })) }) } as never,
      new Proxy(
        {},
        {
          get:
            (_target, property) =>
            async (...args: unknown[]) => {
              if (property === 'readAccount')
                return args[0] === 'system-user'
                  ? { id: '90', userId: 'system-user', assetType: 1, accountType: 2 }
                  : { id: String(args[0]), userId: String(args[0]), assetType: 1, accountType: 1 };
              if (property === 'lockAccountsByIds') {
                calls.push(`lock:${(args[0] as string[]).join(',')}`);
                return (args[0] as string[]).map((id) => ({
                  id,
                  userId: id === '90' ? 'system-user' : id,
                  assetType: 1,
                  accountType: id === '90' ? 2 : 1,
                }));
              }
              if (property === 'claimOperation') return { inserted: true, operation: { id: 'op' } };
              if (property === 'readHoldForOperation') return null;
              calls.push(String(property));
              return undefined;
            },
        },
      ) as never,
      { systemUserId: 'system-user' } as never,
      { now: () => new Date('2026-01-01T00:00:00.000Z') } as never,
      { append: async () => undefined } as never,
    );
    await expect(useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never)).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(calls).toEqual(['lock:1,2,3,4,90']);
    expect(calls).not.toContain('settleRound');
  });

  it('rejects invalid game hold before releasing any player hold or posting settlement entries', async () => {
    const calls = { holdChecks: 0, release: 0, post: 0, turnover: 0 };
    const players = [1, 2, 3, 4].map((seat) => ({
      ...makePlayer(String(seat)),
      id: `rp${seat}`,
      assetHoldId: String(seat + 10),
      maxLossHoldCoins: '10',
    }));
    const settledSnapshot = { players: [1, 2, 3, 4].map((seat) => ({ playerId: String(seat), water: 0, foul: false })) };
    const validRow = {
      ...makeSettlement(
        new Uint8Array(
          settlementInputHashOf(
            {},
            players.map((player) => player.submissionSnapshot as Record<string, unknown>),
          ),
        ),
        resultHashOf(settledSnapshot),
      ),
      resultSnapshot: settledSnapshot,
    };
    const useCase = new RoundSettleUseCase(
      {
        lockRound: async () => ({ ...makeRound(RoundStatus.SETTLING), rulesSnapshot: {} }),
        listRoundPlayers: async () => players,
        settleRound: async () => ({ inserted: true, settlement: validRow }),
      } as never,
      {} as never,
      {
        findSettlementByRoundId: async () => ({
          ...makeSettlement(),
          resultSnapshot: { players: [1, 2, 3, 4].map((seat) => ({ playerId: String(seat), water: seat === 1 ? 1 : 0, foul: false })) },
        }),
      } as never,
      { settle: () => ({ players: [1, 2, 3, 4].map((seat) => ({ playerId: String(seat), water: 0, foul: false })) }) } as never,
      new Proxy(
        {},
        {
          get:
            (_target, property) =>
            async (...args: unknown[]) => {
              if (property === 'readAccount') return args[0] === 'system-user' ? { id: '500' } : { id: String(args[0]) };
              if (property === 'lockAccountsByIds')
                return (args[0] as string[]).map((id) => ({
                  id,
                  userId: id === '500' ? 'system-user' : id,
                  assetType: 1,
                  accountType: id === '500' ? 2 : 1,
                }));
              if (property === 'claimOperation') return { inserted: true, operation: { id: 'op' } };
              if (property === 'readHoldForOperation') {
                calls.holdChecks += 1;
                return calls.holdChecks === 4
                  ? null
                  : { assetOperationId: 'hold-op', holdKey: `hold:round-key:${calls.holdChecks}`, amount: '10' };
              }
              if (property === 'consumeTurnover') {
                calls.turnover += 1;
                return null;
              }
              if (property === 'releaseHold') calls.release += 1;
              if (property === 'postEntries') {
                calls.post += 1;
                return [];
              }
              return undefined;
            },
        },
      ) as never,
      { systemUserId: 'system-user' } as never,
      { now: () => new Date('2026-01-01T00:00:00.000Z') } as never,
      { append: async () => undefined } as never,
    );

    await expect(useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never)).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(calls).toEqual({ holdChecks: 4, release: 0, post: 0, turnover: 0 });
  });

  it('consumes each player settled wager exactly once on the successful settlement path', async () => {
    const players = [1, 2, 3, 4].map((seat) => ({
      ...makePlayer(String(seat)),
      id: `rp${seat}`,
      assetHoldId: String(seat + 10),
      wagerCoins: String(seat * 100),
      maxLossHoldCoins: '1000',
    }));
    const consumed: Array<[string, bigint]> = [];
    const settlementSnapshot = { players: [1, 2, 3, 4].map((seat) => ({ playerId: String(seat), water: 0, foul: false })) };
    const validSettlement = {
      ...makeSettlement(
        new Uint8Array(
          settlementInputHashOf(
            {},
            players.map((player) => player.submissionSnapshot as Record<string, unknown>),
          ),
        ),
        resultHashOf(settlementSnapshot),
      ),
      resultSnapshot: settlementSnapshot,
    };
    const useCase = new RoundSettleUseCase(
      {
        lockRound: async () => ({ ...makeRound(RoundStatus.SETTLING), rulesSnapshot: {} }),
        listRoundPlayers: async () => players,
        settleRound: async () => ({ inserted: true, settlement: validSettlement }),
        markRoundPlayerSettled: async () => undefined,
        markRoundSettled: async () => undefined,
      } as never,
      { appendRoundEvent: async () => undefined } as never,
      {
        findSettlementByRoundId: async () => ({
          id: '20',
          roundId: '10',
          resultSnapshot: { players: [1, 2, 3, 4].map((seat) => ({ playerId: String(seat), water: 0, foul: false })) },
        }),
        commitSettlement: async () => undefined,
      } as never,
      { settle: () => ({ players: [1, 2, 3, 4].map((seat) => ({ playerId: String(seat), water: 0, foul: false })) }) } as never,
      new Proxy(
        {},
        {
          get:
            (_target, property) =>
            async (...args: unknown[]) => {
              if (property === 'readAccount')
                return args[0] === 'system-user'
                  ? { id: '90', userId: 'system-user', assetType: 1, accountType: 2 }
                  : { id: String(args[0]), userId: String(args[0]), assetType: 1, accountType: 1 };
              if (property === 'lockAccountsByIds')
                return (args[0] as string[]).map((id) => ({
                  id,
                  userId: id === '90' ? 'system-user' : id,
                  assetType: 1,
                  accountType: id === '90' ? 2 : 1,
                }));
              if (property === 'claimOperation') return { inserted: true, operation: { id: 'op' } };
              if (property === 'readHoldForOperation')
                return {
                  assetOperationId: 'hold-op',
                  holdKey: `hold:round-key:${String((args[1] as { accountId: string }).accountId)}`,
                  amount: '1000',
                };
              if (property === 'consumeTurnover') {
                consumed.push([String(args[0]), args[1] as bigint]);
                return null;
              }
              if (property === 'postEntries') return [];
              if (property === 'setCommitted') return undefined;
              if (property === 'releaseHold') return undefined;
              return undefined;
            },
        },
      ) as never,
      { systemUserId: 'system-user' } as never,
      { now: () => new Date('2026-01-01T00:00:00.000Z') } as never,
      { append: async () => undefined } as never,
    );

    await useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never);
    expect(consumed).toEqual([
      ['1', 100n],
      ['2', 200n],
      ['3', 300n],
      ['4', 400n],
    ]);
  });

  it('rejects player loss greater than max-loss hold before settlement or ledger side effects', async () => {
    const calls = { persist: 0, ledger: 0 };
    const players = [1, 2, 3, 4].map((seat) => ({
      ...makePlayer(String(seat)),
      maxLossHoldCoins: '10',
    }));
    const useCase = new RoundSettleUseCase(
      {
        lockRound: async () => makeRound(RoundStatus.SETTLING),
        listRoundPlayers: async () => players,
        settleRound: async () => {
          calls.persist += 1;
          throw new Error('settlement must not be persisted');
        },
      } as never,
      {} as never,
      {} as never,
      {
        settle: () => ({
          players: [
            { playerId: '1', water: -11, foul: false },
            { playerId: '2', water: 11, foul: false },
            { playerId: '3', water: 0, foul: false },
            { playerId: '4', water: 0, foul: false },
          ],
        }),
      } as never,
      new Proxy({}, { get: () => async () => (calls.ledger += 1) }) as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never)).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(calls).toEqual({ persist: 0, ledger: 0 });
  });

  it('rejects non-zero-sum scoring output before persisting settlement or touching ledger', async () => {
    const calls = { persist: 0, ledger: 0 };
    const useCase = new RoundSettleUseCase(
      {
        lockRound: async () => makeRound(RoundStatus.SETTLING),
        listRoundPlayers: async () =>
          [1, 2, 3, 4].map((seat) => ({
            ...makePlayer(String(seat)),
            assetHoldId: String(seat + 10),
            maxLossHoldCoins: '10',
          })),
        settleRound: async () => {
          calls.persist += 1;
          throw new Error('settlement must not be persisted');
        },
      } as never,
      {} as never,
      {} as never,
      {
        settle: () => ({
          players: [
            { playerId: '1', water: 10, foul: false },
            { playerId: '2', water: -3, foul: false },
            { playerId: '3', water: -3, foul: false },
            { playerId: '4', water: -3, foul: false },
          ],
        }),
      } as never,
      new Proxy({}, { get: () => async () => (calls.ledger += 1) }) as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never)).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
    expect(calls).toEqual({ persist: 0, ledger: 0 });
  });

  it.each([
    {
      players: [
        { playerId: '1', water: '2', foul: false },
        { playerId: '2', water: -2, foul: false },
      ],
    },
    {
      players: [
        { playerId: '1', water: 1.5, foul: false },
        { playerId: '2', water: -1.5, foul: false },
      ],
    },
    {
      players: [
        { playerId: '1', water: 2, foul: 'false' },
        { playerId: '2', water: -2, foul: false },
      ],
    },
  ])('rejects malformed player fields in a settled replay snapshot', async ({ players }) => {
    const useCase = new RoundSettleUseCase(
      {
        lockRound: async () => makeRound(RoundStatus.SETTLED),
        listRoundPlayers: async () => [makePlayer('1'), makePlayer('2'), makePlayer('3'), makePlayer('4')],
      } as never,
      {} as never,
      { findSettlementByRoundId: async () => ({ id: '20', roundId: '10', resultSnapshot: { players } }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '1', roundId: '10', tx } as never)).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
  });

  it('rejects a settled replay snapshot whose player water does not sum to zero', async () => {
    const roundPlayers = [makePlayer('1'), makePlayer('2')];
    const useCase = new RoundSettleUseCase(
      { lockRound: async () => makeRound(RoundStatus.SETTLED), listRoundPlayers: async () => roundPlayers } as never,
      {} as never,
      {
        findSettlementByRoundId: async () => ({
          id: '20',
          roundId: '10',
          resultSnapshot: {
            players: [
              { playerId: '1', water: 5, foul: false },
              { playerId: '2', water: -3, foul: false },
            ],
          },
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '1', roundId: '10', tx } as never)).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
  });

  it('rejects a settlement row whose roundId does not match the locked round', async () => {
    const players = [makePlayer('1'), makePlayer('2'), makePlayer('3'), makePlayer('4')];
    const useCase = new RoundSettleUseCase(
      { lockRound: async () => makeRound(RoundStatus.SETTLED), listRoundPlayers: async () => players } as never,
      {} as never,
      { findSettlementByRoundId: async () => ({ ...makeSettlement(), roundId: '999' }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '1', roundId: '10', tx } as never)).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
  });

  it('accepts complete authoritative settled round-player rows for replay hash validation', async () => {
    const completePlayers = [1, 2, 3, 4].map((id) => ({
      ...makePlayer(String(id), RoundPlayerStatus.SETTLED),
      id: `rp-${id}`,
      roomMembershipId: `m-${id}`,
      netCoinDelta: '0',
    }));
    const replayInputHash = new Uint8Array(settlementInputHashOf({}, completePlayers.map((player) => player.submissionSnapshot)));
    const replaySnapshot = { players: [1, 2, 3, 4].map((id) => ({ playerId: String(id), water: 0, foul: false })) };
    const replayRow = { ...makeSettlement(replayInputHash, resultHashOf(replaySnapshot), SettlementStatus.COMMITTED), resultSnapshot: replaySnapshot };
    const useCase = new RoundSettleUseCase(
      { lockRound: async () => ({ ...makeRound(RoundStatus.SETTLED), rulesSnapshot: {} }), listRoundPlayers: async () => completePlayers } as never,
      {} as never,
      { findSettlementByRoundId: async () => replayRow } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(useCase.run({ userId: '1', roundId: '10', tx } as never)).resolves.toMatchObject({ replay: true, roundId: '10' });
  });

  it.each([{}, null, { heldCards: [], arrangement: {} }])('rejects settled replay with a malformed hand snapshot %o', async (submissionSnapshot) => {
    const players = [1, 2, 3, 4].map((id) => ({
      ...makePlayer(String(id), RoundPlayerStatus.SETTLED),
      id: `rp-${id}`,
      roomMembershipId: `m-${id}`,
      submissionSnapshot: id === 1 ? submissionSnapshot : makePlayer(String(id)).submissionSnapshot,
    }));
    const useCase = new RoundSettleUseCase(
      { lockRound: async () => ({ ...makeRound(RoundStatus.SETTLED), rulesSnapshot: {} }), listRoundPlayers: async () => players } as never,
      {} as never,
      { findSettlementByRoundId: async () => makeSettlement() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(useCase.run({ userId: '1', roundId: '10', tx } as never)).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
  });

  it('rejects settled replay with a round player that is not SETTLED', async () => {
    const players = [makePlayer('1', RoundPlayerStatus.SETTLED), makePlayer('2', RoundPlayerStatus.SETTLED), makePlayer('3', RoundPlayerStatus.SETTLED), makePlayer('4', RoundPlayerStatus.SETTLED)];
    players[3]!.status = RoundPlayerStatus.SUBMITTED;
    const useCase = new RoundSettleUseCase(
      { lockRound: async () => makeRound(RoundStatus.SETTLED), listRoundPlayers: async () => players } as never,
      {} as never,
      { findSettlementByRoundId: async () => makeSettlement() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '1', roundId: '10', tx } as never)).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
  });

  it('rejects settled replay when the round itself is not a four-player classic round', async () => {
    const useCase = new RoundSettleUseCase(
      {
        lockRound: async () => makeRound(RoundStatus.SETTLED),
        listRoundPlayers: async () => [makePlayer('1'), makePlayer('2'), makePlayer('3'), makePlayer('4')],
      } as never,
      {} as never,
      { findSettlementByRoundId: async () => makeSettlement() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '1', roundId: '10', tx } as never)).rejects.toMatchObject({
      code: R.STORAGE_UNAVAILABLE,
    });
  });

  it('rejects a settled replay result whose player IDs differ from the round membership', async () => {
    const roundPlayers = [makePlayer('1'), makePlayer('2')];
    const roundRepo = {
      lockRound: async () => makeRound(RoundStatus.SETTLED),
      listRoundPlayers: async () => roundPlayers,
    };
    const settlementRepo = {
      findSettlementByRoundId: async () => ({
        id: '20',
        roundId: '10',
        resultSnapshot: {
          players: [
            { playerId: '1', water: 0, foul: false },
            { playerId: '99', water: 0, foul: false },
          ],
        },
      }),
    };
    const useCase = new RoundSettleUseCase(
      roundRepo as never,
      {} as never,
      settlementRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(useCase.run({ userId: '1', roundId: '10', tx } as never)).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
  });

  it('allows a round member to replay settled results without repeating settlement effects', async () => {
    const players = [1, 2, 3, 4].map((userId) => ({
      ...makePlayer(String(userId), RoundPlayerStatus.SETTLED),
      id: `rp-${userId}`,
      roomMembershipId: `m-${userId}`,
    }));
    const inputHash = new Uint8Array(settlementInputHashOf({}, players.map((player) => player.submissionSnapshot)));
    const calls = { findSettlement: 0, settle: 0, ledger: 0, rules: 0, turnover: 0, appendEvent: 0, outbox: 0 };
    const expectedSnapshot = { players: players.map(({ userId }) => ({ playerId: userId, water: 0, foul: false })) };
    const useCase = new RoundSettleUseCase(
      { lockRound: async () => ({ ...makeRound(RoundStatus.SETTLED), rulesSnapshot: {} }), listRoundPlayers: async () => players } as never,
      {} as never,
      {
        findSettlementByRoundId: async () => {
          calls.findSettlement += 1;
          return {
            ...makeSettlement(inputHash, resultHashOf(expectedSnapshot), SettlementStatus.COMMITTED),
            resultSnapshot: expectedSnapshot,
          };
        },
      } as never,
      {
        settle: () => {
          calls.rules += 1;
          throw new Error('rules must not run');
        },
      } as never,
      new Proxy(
        {},
        {
          get: () => async () => {
            calls.ledger += 1;
            throw new Error('ledger must not be touched');
          },
        },
      ) as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await useCase.run({ userId: '1', roundId: '10', fencingToken: '3', tx } as never);

    expect(result.replay).toBe(true);
    expect(result.roundId).toBe('10');
    expect(result.players).toEqual([
      { userId: '1', water: '0', foul: false },
      { userId: '2', water: '0', foul: false },
      { userId: '3', water: '0', foul: false },
      { userId: '4', water: '0', foul: false },
    ]);
    expect(calls).toMatchObject({ findSettlement: 1, settle: 0, ledger: 0, rules: 0, turnover: 0 });
  });
});
