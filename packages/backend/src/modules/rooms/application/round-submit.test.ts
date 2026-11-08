import { describe, expect, it, vi } from 'vitest';
import { RoundPlayerStatus, RoundStatus } from '../../../infrastructure/database/models/game.js';
import { R } from '../domain/errors.js';
import type { RoomDomainError } from '../domain/errors.js';
import { RoundSubmitUseCase } from './round-submit.js';

describe('RoundSubmitUseCase persisted submission snapshot validation', () => {
  it('rejects roundPlayer prototype Proxy traps as storage unavailable', async () => {
    const roundPlayer = new Proxy(
      { id: '14', submittedAt: '2026-11-06T13:00:00.000Z' },
      {
        getPrototypeOf: () => {
          throw new Error('trap');
        },
      },
    );
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValue([{ userId: '42', status: RoundPlayerStatus.ACTIVE }]),
      submitRound: vi.fn().mockResolvedValue({ inserted: true, roundPlayer }),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundEventRepo.appendRoundEvent).not.toHaveBeenCalled();
  });

  it('rejects hostile roundPlayer proxy traps as storage unavailable', async () => {
    const roundPlayer = new Proxy(
      { id: '14', submittedAt: '2026-11-06T13:00:00.000Z' },
      {
        ownKeys: () => {
          throw new Error('trap');
        },
      },
    );
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValue([{ userId: '42', status: RoundPlayerStatus.ACTIVE }]),
      submitRound: vi.fn().mockResolvedValue({ inserted: true, roundPlayer }),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundEventRepo.appendRoundEvent).not.toHaveBeenCalled();
  });

  it('rejects Date proxies without leaking native errors', async () => {
    const date = new Proxy(new Date('2026-11-06T13:00:00.000Z'), {
      get: () => {
        throw new Error('date trap');
      },
    });
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValue([{ userId: '42', status: RoundPlayerStatus.ACTIVE }]),
      submitRound: vi.fn().mockResolvedValue({ inserted: true, roundPlayer: { id: '14', submittedAt: date } }),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundEventRepo.appendRoundEvent).not.toHaveBeenCalled();
  });

  it('rejects accessor-backed roundPlayer fields without executing getters', async () => {
    let getterCalled = false;
    const roundPlayer = { id: '14', submittedAt: '2026-11-06T13:00:00.000Z' } as { id: string; submittedAt: string };
    Object.defineProperty(roundPlayer, 'submittedAt', {
      get: () => {
        getterCalled = true;
        return '2026-11-06T13:00:00.000Z';
      },
    });
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValue([{ userId: '42', status: RoundPlayerStatus.ACTIVE }]),
      submitRound: vi.fn().mockResolvedValue({ inserted: true, roundPlayer }),
    };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(getterCalled).toBe(false);
  });
  it('binds new submit events to the 32-byte submission hash', async () => {
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi
        .fn()
        .mockResolvedValueOnce([{ userId: '42', status: RoundPlayerStatus.ACTIVE }])
        .mockResolvedValueOnce([
          { userId: '1', status: RoundPlayerStatus.SUBMITTED },
          { userId: '2', status: RoundPlayerStatus.SUBMITTED },
          { userId: '3', status: RoundPlayerStatus.SUBMITTED },
          { userId: '42', status: RoundPlayerStatus.SUBMITTED },
        ]),
      submitRound: vi.fn().mockResolvedValue({ inserted: true, roundPlayer: { id: '14', submittedAt: '2026-11-06T13:00:00.000Z' } }),
      markRoundSettling: vi.fn().mockResolvedValue(undefined),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn().mockResolvedValue(undefined) };
    await new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never).run({
      userId: '42',
      roundId: '10',
      fencingToken: '3',
      arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      attempt: 1,
      tx: { transaction: {} } as never,
    });
    const eventCall = roundEventRepo.appendRoundEvent.mock.calls[0]?.[0];
    expect(eventCall).toBeDefined();
    const payload = eventCall?.payloadCiphertext as Uint8Array;
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(payload.length).toBe(32);
  });

  it('rejects replay result in ACTIVE state before event or follow-up reads', async () => {
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValue([{ userId: '42', status: RoundPlayerStatus.ACTIVE }]),
      submitRound: vi.fn().mockResolvedValue({ inserted: false, roundPlayer: { id: '14', submittedAt: '2026-11-06T13:00:00.000Z' } }),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundEventRepo.appendRoundEvent).not.toHaveBeenCalled();
  });

  it('rejects hostile submitRound result proxies before event append', async () => {
    const result = new Proxy(
      { inserted: true, roundPlayer: { id: '14', submittedAt: new Date('2026-11-06T13:00:00Z') } },
      {
        ownKeys: () => {
          throw new Error('trap');
        },
      },
    );
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValue([{ userId: '42', status: RoundPlayerStatus.ACTIVE }]),
      submitRound: vi.fn().mockResolvedValue(result),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);
    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundEventRepo.appendRoundEvent).not.toHaveBeenCalled();
  });

  it.each([
    { inserted: true, roundPlayer: { id: '14', submittedAt: '2026-11-06T13:00:00.000Z' }, extra: true },
    { inserted: false, roundPlayer: { id: '14', submittedAt: '2026-11-06T13:00:00.000Z' }, replay: true },
  ])('rejects submitRound result objects with extra enumerable fields before event append: %o', async (result) => {
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValue([{ userId: '42', status: RoundPlayerStatus.ACTIVE }]),
      submitRound: vi.fn().mockResolvedValue(result),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundEventRepo.appendRoundEvent).not.toHaveBeenCalled();
  });

  it('rejects extra roundPlayer snapshot properties before event append', async () => {
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValue([{ userId: '42', status: RoundPlayerStatus.ACTIVE }]),
      submitRound: vi
        .fn()
        .mockResolvedValue({ inserted: true, roundPlayer: { id: '14', submittedAt: '2026-11-06T13:00:00.000Z', extra: true } }),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);
    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundEventRepo.appendRoundEvent).not.toHaveBeenCalled();
  });

  it('rejects accessor-backed submitRound result without executing getters', async () => {
    let getterCalled = false;
    const result = { inserted: true, roundPlayer: { id: '14', submittedAt: new Date('2026-11-06T13:00:00Z') } };
    Object.defineProperty(result, 'inserted', {
      get: () => {
        getterCalled = true;
        return true;
      },
    });
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValue([{ userId: '42', status: RoundPlayerStatus.ACTIVE }]),
      submitRound: vi.fn().mockResolvedValue(result),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);
    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(getterCalled).toBe(false);
    expect(roundEventRepo.appendRoundEvent).not.toHaveBeenCalled();
  });

  it.each([null, {}, { inserted: true }, { inserted: 'yes', roundPlayer: { id: '14', submittedAt: '2026-11-06T13:00:00.000Z' } }])(
    'rejects malformed submit result before event or follow-up reads: %o',
    async (submitResult) => {
      const roundRepo = {
        lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
        listRoundPlayers: vi.fn().mockResolvedValue([{ userId: '42', status: RoundPlayerStatus.ACTIVE }]),
        submitRound: vi.fn().mockResolvedValue(submitResult),
      };
      const roundEventRepo = { appendRoundEvent: vi.fn() };
      const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);
      await expect(
        useCase.run({
          userId: '42',
          roundId: '10',
          fencingToken: '3',
          arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
          attempt: 1,
          tx: { transaction: {} } as never,
        }),
      ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
      expect(roundEventRepo.appendRoundEvent).not.toHaveBeenCalled();
      expect(roundRepo.listRoundPlayers).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { id: '0', submittedAt: '2026-11-06T13:00:00.000Z' },
    { id: '14', submittedAt: 'not-a-date' },
    { id: '14', submittedAt: null },
    { id: '14', submittedAt: new Date('not-a-date') },
    Object.defineProperty({ id: '14', submittedAt: '2026-11-06T13:00:00.000Z' }, 'submittedAt', {
      value: '2026-11-06T13:00:00.000Z',
      enumerable: false,
    }),
  ])('rejects malformed repository result before event or follow-up state reads: %o', async (roundPlayer) => {
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValue([{ userId: '42', status: RoundPlayerStatus.ACTIVE }]),
      submitRound: vi.fn().mockResolvedValue({ inserted: true, roundPlayer }),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);

    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundEventRepo.appendRoundEvent).not.toHaveBeenCalled();
    expect(roundRepo.listRoundPlayers).toHaveBeenCalledOnce();
  });
});

describe('RoundSubmitUseCase persisted round snapshot validation', () => {
  it('rejects hostile Proxy input and arrangement traps as INVALID_SUBMISSION', async () => {
    const badInput = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('trap');
        },
      },
    );
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(useCase.run(badInput as never)).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });

    const arrangement = new Proxy(
      { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('trap');
        },
      },
    );
    await expect(
      useCase.run({ userId: '42', roundId: '10', fencingToken: '3', arrangement, attempt: 1, tx: { transaction: {} } as never }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects unexpected symbol input keys before repository access', async () => {
    const input = {
      userId: '42',
      roundId: '10',
      fencingToken: '3',
      arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      attempt: 1,
      tx: { transaction: {} } as never,
    };
    Object.defineProperty(input, Symbol('extra'), { value: 'unexpected' });
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(useCase.run(input)).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('accepts frozen input and arrangement data without executing accessors', async () => {
    const arrangement = Object.freeze({
      front: Object.freeze([0, 1, 2]),
      middle: Object.freeze([3, 4, 5, 6, 7]),
      back: Object.freeze([8, 9, 10, 11, 12]),
    });
    const input = Object.freeze({
      userId: '42',
      roundId: '10',
      fencingToken: '3',
      arrangement,
      attempt: 1,
      tx: { transaction: {} } as never,
    });
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    roundRepo.lockRound.mockRejectedValue(new Error('stop after input validation'));
    await expect(useCase.run(input)).rejects.toThrow('stop after input validation');
    expect(roundRepo.lockRound).toHaveBeenCalledOnce();
  });

  it('accepts immutable required input data fields without mutating the caller object', async () => {
    const input = {
      userId: '42',
      roundId: '10',
      fencingToken: '3',
      arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      attempt: 1,
      tx: { transaction: {} } as never,
    };
    Object.defineProperty(input, 'attempt', { value: 1, enumerable: true, configurable: true, writable: false });
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    // Input validates before the first round read; this fake deliberately stops the flow there.
    roundRepo.lockRound.mockRejectedValue(new Error('stop after input validation'));
    await expect(useCase.run(input)).rejects.toThrow('stop after input validation');
    expect(roundRepo.lockRound).toHaveBeenCalledOnce();
  });

  it('rejects non-enumerable use-case input fields before repository access', async () => {
    const input = {
      userId: '42',
      roundId: '10',
      fencingToken: '3',
      arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      attempt: 1,
      tx: { transaction: {} } as never,
    };
    Object.defineProperty(input, 'attempt', { value: 1, enumerable: false, configurable: true, writable: true });
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(useCase.run(input)).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects accessor-backed use-case input fields without executing getters', async () => {
    let getterCalled = false;
    const input = {
      userId: '42',
      roundId: '10',
      fencingToken: '3',
      arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      attempt: 1,
      tx: { transaction: {} } as never,
    };
    Object.defineProperty(input, 'attempt', {
      get: () => {
        getterCalled = true;
        return 1;
      },
    });
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(useCase.run(input)).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(getterCalled).toBe(false);
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects extra locked-round snapshot properties before reading members', async () => {
    const round = { id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3', secretMetadata: true };
    const roundRepo = { lockRound: vi.fn().mockResolvedValue(round), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundRepo.listRoundPlayers).not.toHaveBeenCalled();
  });

  it('rejects hostile locked-round proxy traps as storage unavailable', async () => {
    const round = new Proxy(
      { id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' },
      {
        ownKeys: () => {
          throw new Error('trap');
        },
      },
    );
    const roundRepo = { lockRound: vi.fn().mockResolvedValue(round), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundRepo.listRoundPlayers).not.toHaveBeenCalled();
  });

  it('rejects accessor-backed round fields without executing getters', async () => {
    let getterCalled = false;
    const round = { id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' };
    Object.defineProperty(round, 'fencingToken', {
      get: () => {
        getterCalled = true;
        return '3';
      },
    });
    const roundRepo = { lockRound: vi.fn().mockResolvedValue(round), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(getterCalled).toBe(false);
  });
  it.each([
    { id: '0', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' },
    { id: '10', roundKey: '', status: RoundStatus.ACTIVE, fencingToken: '3' },
    { id: '10', roundKey: 'round-key', status: 99, fencingToken: '3' },
    { id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '01' },
    Object.defineProperty({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }, 'status', {
      value: RoundStatus.ACTIVE,
      enumerable: false,
    }),
  ])('rejects malformed locked round before member read or submission: %o', async (round) => {
    const roundRepo = { lockRound: vi.fn().mockResolvedValue(round), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);

    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundRepo.listRoundPlayers).not.toHaveBeenCalled();
    expect(roundRepo.submitRound).not.toHaveBeenCalled();
    expect(roundEventRepo.appendRoundEvent).not.toHaveBeenCalled();
  });
});

describe('RoundSubmitUseCase authorization', () => {
  it.each([
    {
      arrangement: {
        front: [{ valueOf: (): number => 1, [Symbol.toPrimitive]: (): number => 1 }, 1, 2],
        middle: [3, 4, 5, 6, 7],
        back: [8, 9, 10, 11, 12],
      },
      attempt: 1,
    },
    { arrangement: {}, attempt: 1 },
    { arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] }, attempt: 1, userId: '01' },
    { arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] }, attempt: 1, roundId: '0' },
    { arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] }, attempt: 0 },
    { arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] }, attempt: 1.5 },
    { arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] }, attempt: 1, fencingToken: '0' },
    { arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] }, attempt: 1, fencingToken: '01' },
    { arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] }, attempt: 1, fencingToken: '1'.repeat(21) },
  ])(
    'rejects malformed arrangement, attempt, or fencing token before any repository access',
    async ({ arrangement, attempt, fencingToken, userId, roundId }) => {
      const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
      const roundEventRepo = { appendRoundEvent: vi.fn() };
      const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);

      await expect(
        useCase.run({
          userId: userId ?? '42',
          roundId: roundId ?? '10',
          fencingToken: fencingToken ?? '3',
          arrangement,
          attempt,
          tx: { transaction: {} } as never,
        }),
      ).rejects.toMatchObject<Partial<RoomDomainError>>({ code: R.INVALID_SUBMISSION });

      expect(roundRepo.lockRound).not.toHaveBeenCalled();
      expect(roundRepo.listRoundPlayers).not.toHaveBeenCalled();
      expect(roundRepo.submitRound).not.toHaveBeenCalled();
      expect(roundEventRepo.appendRoundEvent).not.toHaveBeenCalled();
    },
  );

  it('rejects arrangement root keys that change during descriptor validation', async () => {
    let calls = 0;
    const arrangement = new Proxy(
      { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      {
        ownKeys: (target) => {
          calls += 1;
          return calls === 2 ? [...Reflect.ownKeys(target), 'extra'] : Reflect.ownKeys(target);
        },
      },
    );
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement,
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects arrangement prototype Proxy traps before repository access', async () => {
    const arrangement = new Proxy(
      { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      {
        getPrototypeOf: () => {
          throw new Error('trap');
        },
      },
    );
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement,
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects arrangement root descriptors that change between snapshots as invalid input', async () => {
    let call = 0;
    const arrangement = new Proxy(
      { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      {
        getOwnPropertyDescriptor: (target, key) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (key === 'front' && ++call > 1 && descriptor && 'value' in descriptor) return { ...descriptor, value: [12, 13, 14] };
          return descriptor;
        },
      },
    );
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement,
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects arrangement root descriptor flag changes between snapshots', async () => {
    let call = 0;
    const arrangement = new Proxy(
      { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      {
        getOwnPropertyDescriptor: (target, key) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (key === 'front' && ++call > 1 && descriptor && 'value' in descriptor) return { ...descriptor, enumerable: false };
          return descriptor;
        },
      },
    );
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement,
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects arrangement root descriptor changes after pile normalization before writes', async () => {
    let frontDescriptorCalls = 0;
    const arrangement = new Proxy(
      { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      {
        getOwnPropertyDescriptor: (target, key) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (key === 'front' && ++frontDescriptorCalls > 3 && descriptor && 'value' in descriptor)
            return { ...descriptor, value: [12, 13, 14] };
          return descriptor;
        },
      },
    );
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement,
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundRepo.lockRound).toHaveBeenCalledOnce();
  });

  it('rejects arrangement root accessors without executing getters', async () => {
    let getterCalled = false;
    const arrangement = { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] };
    Object.defineProperty(arrangement, 'front', {
      get: () => {
        getterCalled = true;
        return [0, 1, 2];
      },
    });
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(
      useCase.run({ userId: '42', roundId: '10', fencingToken: '3', arrangement, attempt: 1, tx: { transaction: {} } as never }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(getterCalled).toBe(false);
  });

  it('rejects non-plain arrangement and pile prototypes before repository access', async () => {
    const arrangement = Object.create(null) as Record<string, unknown>;
    arrangement.front = [0, 1, 2];
    arrangement.middle = [3, 4, 5, 6, 7];
    arrangement.back = [8, 9, 10, 11, 12];
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(
      useCase.run({ userId: '42', roundId: '10', fencingToken: '3', arrangement, attempt: 1, tx: { transaction: {} } as never }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();

    const customPile = Object.assign(Object.create(null), [0, 1, 2]);
    const plainArrangement = { front: customPile, middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] };
    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: plainArrangement,
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
  });

  it('rejects a pile proxy whose key set changes while card slots are read', async () => {
    let ownKeysCalls = 0;
    const pile = new Proxy([0, 1, 2], {
      ownKeys: (target) => {
        ownKeysCalls += 1;
        return ownKeysCalls <= 3 ? Reflect.ownKeys(target) : ['length', '0', '1', '2', 'extra'];
      },
    });
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: pile, middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects non-enumerable card slot descriptors', async () => {
    const hiddenCard = [0, 1, 2];
    Object.defineProperty(hiddenCard, '0', { value: 0, enumerable: false, configurable: true, writable: true });
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    for (const front of [hiddenCard]) {
      await expect(
        useCase.run({
          userId: '42',
          roundId: '10',
          fencingToken: '3',
          arrangement: { front, middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
          attempt: 1,
          tx: { transaction: {} } as never,
        }),
      ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    }
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects hostile proxy traps while extracting pile descriptors', async () => {
    const pile = new Proxy([0, 1, 2], {
      ownKeys: (target) => Reflect.ownKeys(target),
      getOwnPropertyDescriptor: (target, key) => {
        if (key === '1') throw new Error('descriptor trap');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: pile, middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects pile proxy own-key and descriptor key snapshots that disagree', async () => {
    let ownKeysCalls = 0;
    const pile = new Proxy([0, 1, 2], {
      ownKeys: (target) => {
        ownKeysCalls += 1;
        return ownKeysCalls === 1 ? Reflect.ownKeys(target) : ['length', '0', '1', '2', 'metadata'];
      },
      getOwnPropertyDescriptor: (target, key) => Reflect.getOwnPropertyDescriptor(target, key),
    });
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: pile, middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects arrangements with hidden own properties before repository access', async () => {
    const arrangement = { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] };
    Object.defineProperty(arrangement, 'hidden', { value: 'extra', enumerable: false });
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);

    await expect(
      useCase.run({ userId: '42', roundId: '10', fencingToken: '3', arrangement, attempt: 1, tx: { transaction: {} } as never }),
    ).rejects.toMatchObject<Partial<RoomDomainError>>({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
    expect(roundRepo.submitRound).not.toHaveBeenCalled();
  });

  it('rejects accessor-based pile fields before repository access', async () => {
    let getterCalled = false;
    const arrangement = {
      get front() {
        getterCalled = true;
        return [0, 1, 2];
      },
      middle: [3, 4, 5, 6, 7],
      back: [8, 9, 10, 11, 12],
    };
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);

    await expect(
      useCase.run({ userId: '42', roundId: '10', fencingToken: '3', arrangement, attempt: 1, tx: { transaction: {} } as never }),
    ).rejects.toMatchObject<Partial<RoomDomainError>>({ code: R.INVALID_SUBMISSION });
    expect(getterCalled).toBe(false);
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects pile arrays with accessor or inconsistent length descriptors', async () => {
    const accessorLength = Object.create(Array.prototype) as number[];
    Object.defineProperty(accessorLength, '0', { value: 0 });
    Object.defineProperty(accessorLength, '1', { value: 1 });
    Object.defineProperty(accessorLength, '2', { value: 2 });
    Object.defineProperty(accessorLength, 'length', { value: 3, configurable: true });
    Object.defineProperty(accessorLength, 'length', { get: () => 3 });
    const inconsistentLength = [3, 4, 5, 6, 7];
    Object.defineProperty(inconsistentLength, 'length', { value: 4 });
    const arrangement = { front: accessorLength, middle: inconsistentLength, back: [8, 9, 10, 11, 12] };
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(
      useCase.run({ userId: '42', roundId: '10', fencingToken: '3', arrangement, attempt: 1, tx: { transaction: {} } as never }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects pile arrays with non-index own properties', async () => {
    const front = [0, 1, 2];
    Object.defineProperty(front, 'metadata', { value: 'unexpected' });
    const arrangement = { front, middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] };
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(
      useCase.run({ userId: '42', roundId: '10', fencingToken: '3', arrangement, attempt: 1, tx: { transaction: {} } as never }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('accepts frozen arrangement data without mutating caller-owned arrays', async () => {
    const arrangement = Object.freeze({
      front: Object.freeze([0, 1, 2]),
      middle: Object.freeze([3, 4, 5, 6, 7]),
      back: Object.freeze([8, 9, 10, 11, 12]),
    });
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    roundRepo.lockRound.mockRejectedValue(new Error('stop after arrangement normalization'));
    await expect(
      useCase.run({ userId: '42', roundId: '10', fencingToken: '3', arrangement, attempt: 1, tx: { transaction: {} } as never }),
    ).rejects.toThrow('stop after arrangement normalization');
    expect(roundRepo.lockRound).toHaveBeenCalledOnce();
  });

  it('rejects non-standard numeric card-slot descriptors', async () => {
    const nonEnumerable = [0, 1, 2];
    Object.defineProperty(nonEnumerable, '1', { value: 1, enumerable: false });
    const arrangement = { front: nonEnumerable, middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] };
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(
      useCase.run({ userId: '42', roundId: '10', fencingToken: '3', arrangement, attempt: 1, tx: { transaction: {} } as never }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects non-canonical or out-of-range numeric index keys', async () => {
    const leadingZero = [0, 1, 2];
    Object.defineProperty(leadingZero, '01', { value: 9 });
    const outOfRange = [3, 4, 5, 6, 7];
    Object.defineProperty(outOfRange, '5', { value: 9 });
    const arrangement = { front: leadingZero, middle: outOfRange, back: [8, 9, 10, 11, 12] };
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(
      useCase.run({ userId: '42', roundId: '10', fencingToken: '3', arrangement, attempt: 1, tx: { transaction: {} } as never }),
    ).rejects.toMatchObject({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects sparse or extended pile arrays before repository access', async () => {
    const sparse = [0, 1, 2];
    delete sparse[1];
    const extended = [3, 4, 5, 6, 7];
    Object.defineProperty(extended, 'hidden', { value: 'extra', enumerable: false });
    const arrangement = { front: sparse, middle: extended, back: [8, 9, 10, 11, 12] };
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);

    await expect(
      useCase.run({ userId: '42', roundId: '10', fencingToken: '3', arrangement, attempt: 1, tx: { transaction: {} } as never }),
    ).rejects.toMatchObject<Partial<RoomDomainError>>({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('rejects accessor-based card slots without executing getters before repository access', async () => {
    let slotGetterCalled = false;
    const front = [0, 1, 2];
    Object.defineProperty(front, '1', {
      configurable: true,
      get() {
        slotGetterCalled = true;
        return 1;
      },
    });
    const arrangement = { front, middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] };
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);

    await expect(
      useCase.run({ userId: '42', roundId: '10', fencingToken: '3', arrangement, attempt: 1, tx: { transaction: {} } as never }),
    ).rejects.toMatchObject<Partial<RoomDomainError>>({ code: R.INVALID_SUBMISSION });
    expect(slotGetterCalled).toBe(false);
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
  });

  it('accepts a valid Date submittedAt from persistence', async () => {
    const playersBefore = [{ userId: '42', status: RoundPlayerStatus.ACTIVE }];
    const playersAfter = [
      { userId: '1', status: RoundPlayerStatus.SUBMITTED },
      { userId: '2', status: RoundPlayerStatus.SUBMITTED },
      { userId: '3', status: RoundPlayerStatus.SUBMITTED },
      { userId: '42', status: RoundPlayerStatus.SUBMITTED },
    ];
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValueOnce(playersBefore).mockResolvedValueOnce(playersAfter),
      submitRound: vi
        .fn()
        .mockResolvedValue({ inserted: true, roundPlayer: { id: '14', submittedAt: new Date('2026-11-06T13:00:00.000Z') } }),
      markRoundSettling: vi.fn(),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn().mockResolvedValue(undefined) };
    const result = await new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never).run({
      userId: '42',
      roundId: '10',
      fencingToken: '3',
      arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      attempt: 1,
      tx: { transaction: {} } as never,
    });

    expect(result.submittedAt).toBe('2026-11-06T13:00:00.000Z');
  });

  it('stores a normalized value snapshot detached from caller-owned arrays', async () => {
    const front = [0, 1, 2];
    const arrangement = { front, middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] };
    let captured: Record<string, unknown> | undefined;
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi
        .fn()
        .mockResolvedValueOnce([{ userId: '42', status: RoundPlayerStatus.ACTIVE }])
        .mockResolvedValueOnce([
          { userId: '1', status: RoundPlayerStatus.ACTIVE },
          { userId: '2', status: RoundPlayerStatus.ACTIVE },
          { userId: '3', status: RoundPlayerStatus.ACTIVE },
          { userId: '42', status: RoundPlayerStatus.SUBMITTED },
        ]),
      markRoundSettling: vi.fn(),
      submitRound: vi.fn(async (payload: { submissionSnapshot: Record<string, unknown> }) => {
        captured = payload.submissionSnapshot;
        front[0] = 51;
        return { inserted: true, roundPlayer: { id: '14', submittedAt: '2026-11-06T13:00:00.000Z' } };
      }),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn().mockResolvedValue(undefined) };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);

    await useCase.run({ userId: '42', roundId: '10', fencingToken: '3', arrangement, attempt: 1, tx: { transaction: {} } as never });

    expect((captured?.arrangement as { front: number[] }).front).toEqual([0, 1, 2]);
  });

  it('rejects duplicate cards before writing a submission or event', async () => {
    const arrangement = { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 0] };
    const roundRepo = { lockRound: vi.fn(), listRoundPlayers: vi.fn(), submitRound: vi.fn() };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);
    await expect(
      useCase.run({ userId: '42', roundId: '10', fencingToken: '3', arrangement, attempt: 1, tx: { transaction: {} } as never }),
    ).rejects.toMatchObject<Partial<RoomDomainError>>({ code: R.INVALID_SUBMISSION });
    expect(roundRepo.lockRound).not.toHaveBeenCalled();
    expect(roundRepo.submitRound).not.toHaveBeenCalled();
  });

  it('does not enter SETTLING unless the post-submit player set has exactly four members', async () => {
    const tx = { transaction: {} };
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi
        .fn()
        .mockResolvedValueOnce([
          { userId: '1', status: RoundPlayerStatus.ACTIVE },
          { userId: '2', status: RoundPlayerStatus.ACTIVE },
          { userId: '3', status: RoundPlayerStatus.ACTIVE },
          { userId: '4', status: RoundPlayerStatus.ACTIVE },
        ])
        .mockResolvedValueOnce([
          { userId: '1', status: RoundPlayerStatus.ACTIVE },
          { userId: '2', status: RoundPlayerStatus.ACTIVE },
          { userId: '3', status: RoundPlayerStatus.ACTIVE },
          { userId: '4', status: RoundPlayerStatus.SUBMITTED },
        ]),
      submitRound: vi.fn().mockResolvedValue({ inserted: true, roundPlayer: { id: '14', submittedAt: '2026-11-06T13:00:00.000Z' } }),
      markRoundSettling: vi.fn().mockResolvedValue(undefined),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn().mockResolvedValue(undefined) };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);

    const result = await useCase.run({
      userId: '4',
      roundId: '10',
      fencingToken: '3',
      arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      attempt: 1,
      tx: tx as never,
    });

    expect(result.allSubmitted).toBe(false);
    expect(roundRepo.markRoundSettling).not.toHaveBeenCalled();
  });

  it.each<unknown[]>([
    [{ userId: '1', status: RoundPlayerStatus.SUBMITTED }],
    [
      { userId: '1', status: RoundPlayerStatus.SUBMITTED },
      { userId: '1', status: RoundPlayerStatus.SETTLED },
      { userId: '3', status: RoundPlayerStatus.SUBMITTED },
      { userId: '4', status: RoundPlayerStatus.SUBMITTED },
    ],
    [
      { userId: '1', status: RoundPlayerStatus.SUBMITTED },
      { userId: '2', status: RoundPlayerStatus.SUBMITTED },
      { userId: '3', status: RoundPlayerStatus.SUBMITTED },
      { userId: '4', status: 99 },
    ],
  ])('fails closed on malformed post-submit player set: %o', async (_playersAfter) => {
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi
        .fn()
        .mockResolvedValueOnce([{ userId: '42', status: RoundPlayerStatus.ACTIVE }])
        .mockResolvedValueOnce(_playersAfter),
      submitRound: vi.fn().mockResolvedValue({ inserted: true, roundPlayer: { id: '14', submittedAt: '2026-11-06T13:00:00.000Z' } }),
      markRoundSettling: vi.fn(),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn().mockResolvedValue(undefined) };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);

    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundRepo.markRoundSettling).not.toHaveBeenCalled();
  });

  it('uses post-submit player states to detect the final submission and enter SETTLING', async () => {
    const tx = { transaction: {} };
    const playersBefore = [{ userId: '4', status: RoundPlayerStatus.ACTIVE }];
    const playersAfter = [
      { userId: '1', status: RoundPlayerStatus.SUBMITTED },
      { userId: '2', status: RoundPlayerStatus.SUBMITTED },
      { userId: '3', status: RoundPlayerStatus.SUBMITTED },
      { userId: '4', status: RoundPlayerStatus.SUBMITTED },
    ];
    const roundRepo = {
      lockRound: vi.fn().mockResolvedValue({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' }),
      listRoundPlayers: vi.fn().mockResolvedValueOnce(playersBefore).mockResolvedValueOnce(playersAfter),
      submitRound: vi.fn().mockResolvedValue({
        inserted: true,
        roundPlayer: { id: '14', submittedAt: '2026-11-06T13:00:00.000Z' },
      }),
      markRoundSettling: vi.fn().mockResolvedValue(undefined),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn().mockResolvedValue(undefined) };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);

    const result = await useCase.run({
      userId: '4',
      roundId: '10',
      fencingToken: '3',
      arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      attempt: 1,
      tx: tx as never,
    });

    expect(result.allSubmitted).toBe(true);
    expect(roundRepo.markRoundSettling).toHaveBeenCalledWith('10', tx);
    expect(roundRepo.listRoundPlayers).toHaveBeenCalledTimes(2);
  });

  it('rejects accessor-backed player fields without executing getters', async () => {
    let getterCalled = false;
    const player = { userId: '42', status: RoundPlayerStatus.ACTIVE };
    Object.defineProperty(player, 'userId', {
      get: () => {
        getterCalled = true;
        return '42';
      },
    });
    const roundRepo = {
      lockRound: vi.fn(async () => ({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' })),
      listRoundPlayers: vi.fn(async () => [player]),
      submitRound: vi.fn(),
    };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(getterCalled).toBe(false);
  });

  it('rejects player arrays with extra own properties as storage unavailable', async () => {
    const players = [{ userId: '42', status: RoundPlayerStatus.ACTIVE }] as Array<{ userId: string; status: number }> & {
      metadata?: string;
    };
    players.metadata = 'unexpected';
    const roundRepo = {
      lockRound: vi.fn(async () => ({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' })),
      listRoundPlayers: vi.fn(async () => players),
      submitRound: vi.fn(),
    };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundRepo.submitRound).not.toHaveBeenCalled();
  });

  it('rejects a player array proxy that replaces an index between own-key snapshots', async () => {
    let ownKeysCall = 0;
    const players = new Proxy([{ userId: '42', status: RoundPlayerStatus.ACTIVE }], {
      ownKeys: () => {
        ownKeysCall += 1;
        return ownKeysCall === 1 ? ['length', '0'] : ['length', '1'];
      },
    });
    const roundRepo = {
      lockRound: vi.fn(async () => ({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' })),
      listRoundPlayers: vi.fn(async () => players),
      submitRound: vi.fn(),
    };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundRepo.submitRound).not.toHaveBeenCalled();
  });

  it('rejects a player array proxy whose own-key snapshot changes during validation', async () => {
    let ownKeysCall = 0;
    const players = new Proxy([{ userId: '42', status: RoundPlayerStatus.ACTIVE }], {
      ownKeys: (target) => {
        ownKeysCall += 1;
        return ownKeysCall === 1 ? Reflect.ownKeys(target) : [...Reflect.ownKeys(target), 'metadata'];
      },
    });
    const roundRepo = {
      lockRound: vi.fn(async () => ({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' })),
      listRoundPlayers: vi.fn(async () => players),
      submitRound: vi.fn(),
    };
    const useCase = new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never);
    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundRepo.submitRound).not.toHaveBeenCalled();
  });

  it('rejects hostile pre-submit player snapshot proxies as storage unavailable', async () => {
    const players = new Proxy([{ userId: '42', status: RoundPlayerStatus.ACTIVE }], {
      getOwnPropertyDescriptor: () => {
        throw new Error('trap');
      },
    });
    const roundRepo = {
      lockRound: vi.fn(async () => ({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' })),
      listRoundPlayers: vi.fn(async () => players),
      submitRound: vi.fn(),
    };
    const roundEventRepo = { appendRoundEvent: vi.fn() };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);
    await expect(
      useCase.run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundRepo.submitRound).not.toHaveBeenCalled();
    expect(roundEventRepo.appendRoundEvent).not.toHaveBeenCalled();
  });

  it('rejects player member prototype Proxy traps as storage unavailable', async () => {
    const player = new Proxy(
      { userId: '42', status: RoundPlayerStatus.ACTIVE },
      {
        getPrototypeOf: () => {
          throw new Error('trap');
        },
      },
    );
    const roundRepo = {
      lockRound: vi.fn(async () => ({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' })),
      listRoundPlayers: vi.fn(async () => [player]),
      submitRound: vi.fn(),
    };
    await expect(
      new RoundSubmitUseCase(roundRepo as never, { appendRoundEvent: vi.fn() } as never).run({
        userId: '42',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: { transaction: {} } as never,
      }),
    ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
    expect(roundRepo.submitRound).not.toHaveBeenCalled();
  });

  it('rejects malformed pre-submit player snapshots before writing a submission or event', async () => {
    const malformedSnapshots = [
      [
        { userId: '42', status: RoundPlayerStatus.ACTIVE },
        { userId: '42', status: RoundPlayerStatus.ACTIVE },
      ],
      [{ userId: 'not-a-user-id', status: RoundPlayerStatus.ACTIVE }],
      [{ userId: '42', status: 99 }],
      [{ userId: '42', status: RoundPlayerStatus.ACTIVE, extra: true }],
      [Object.assign(Object.create({ userId: '42' }), { status: RoundPlayerStatus.ACTIVE })],
      [null],
      (() => {
        const players = [
          { userId: '42', status: RoundPlayerStatus.ACTIVE },
          { userId: '43', status: RoundPlayerStatus.ACTIVE },
        ];
        delete players[1];
        return players;
      })(),
    ];
    for (const players of malformedSnapshots) {
      const roundRepo = {
        lockRound: vi.fn(async () => ({ id: '10', roundKey: 'round-key', status: RoundStatus.ACTIVE, fencingToken: '3' })),
        listRoundPlayers: vi.fn(async () => players),
        submitRound: vi.fn(),
      };
      const roundEventRepo = { appendRoundEvent: vi.fn() };
      const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);

      await expect(
        useCase.run({
          userId: '42',
          roundId: '10',
          fencingToken: '3',
          arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
          attempt: 1,
          tx: { transaction: {} } as never,
        }),
      ).rejects.toMatchObject({ code: R.STORAGE_UNAVAILABLE });
      expect(roundRepo.submitRound).not.toHaveBeenCalled();
      expect(roundEventRepo.appendRoundEvent).not.toHaveBeenCalled();
    }
  });

  it('rejects a non-member before writing a submission or event', async () => {
    const tx = { transaction: {} };
    const calls = { submitRound: 0, appendRoundEvent: 0 };
    const roundRepo = {
      lockRound: vi.fn(async () => ({
        id: '10',
        roundKey: 'round-key',
        status: RoundStatus.ACTIVE,
        fencingToken: '3',
      })),
      listRoundPlayers: vi.fn(async () => [{ userId: '42', status: 1 }]),
      submitRound: vi.fn(async () => {
        calls.submitRound += 1;
        throw new Error('submission must not be written');
      }),
    };
    const roundEventRepo = {
      appendRoundEvent: vi.fn(async () => {
        calls.appendRoundEvent += 1;
      }),
    };
    const useCase = new RoundSubmitUseCase(roundRepo as never, roundEventRepo as never);

    await expect(
      useCase.run({
        userId: '99',
        roundId: '10',
        fencingToken: '3',
        arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
        attempt: 1,
        tx: tx as never,
      }),
    ).rejects.toMatchObject<Partial<RoomDomainError>>({ code: R.ROUND_PLAYER_NOT_FOUND });

    expect(roundRepo.listRoundPlayers).toHaveBeenCalledWith('10', tx);
    expect(calls).toEqual({ submitRound: 0, appendRoundEvent: 0 });
  });
});
