import { describe, expect, it, vi } from 'vitest';
import { CoinExchangeUseCase } from './exchange.js';
import { W } from '../domain/errors.js';

const request = {
  // UUID v4 idempotency key; quote is a valid one-minute exchange quote.
  quote: {
    coins: '1000',
    cnyFen: '1000',
    rateCoinUnits: '10',
    rateCashFen: '100',
    quotedAt: '2026-11-06T00:00:00.000Z',
    expiresAt: '2026-11-06T00:10:00.000Z',
  },
  idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
};

const makeUseCase = (canTransferOrWithdraw: boolean, parentRewardType: 1 | 2 | null = null) => {
  const calls: string[] = [];
  const ledger = new Proxy(
    {},
    {
      get: (_target, property) => async () => {
        calls.push(String(property));
        if (property === 'getTurnover') return { remainingCoins: canTransferOrWithdraw ? '0' : '500', canTransferOrWithdraw };
        throw new Error(`unexpected ledger call: ${String(property)}`);
      },
    },
  );
  const turnoverGate = {
    assertTransferAllowed: async (_userId: string, tx: unknown) => {
      calls.push('assertTransferAllowed');
      if (!canTransferOrWithdraw) throw Object.assign(new Error('turnover incomplete'), { code: W.TURNOVER_INCOMPLETE });
      if (tx === undefined) throw new Error('transaction missing');
    },
  };
  const config = { readExchangeRate: vi.fn() };
  const useCase = new CoinExchangeUseCase(
    ledger as never,
    config as never,
    { now: () => new Date('2026-11-06T00:01:00.000Z') } as never,
    { systemUserId: '99' } as never,
    turnoverGate as never,
    {
      findDirectParentRewardType: async (userId: string, tx: unknown) => {
        calls.push('findDirectParentRewardType');
        if (userId !== '7' || tx === undefined) throw new Error('referral query context mismatch');
        return parentRewardType;
      },
    },
  );
  return { useCase, calls, config };
};

describe('CoinExchangeUseCase turnover gate', () => {
  it('rejects incomplete turnover before reading exchange config or touching ledger', async () => {
    const { useCase, calls, config } = makeUseCase(false);
    const tx = { transaction: {} } as never;

    await expect(useCase.submit({ userId: '7' } as never, { userId: '7', request, tx, outbox: {} as never })).rejects.toMatchObject({
      code: W.TURNOVER_INCOMPLETE,
    });
    expect(calls).toEqual(['assertTransferAllowed']);
    expect(config.readExchangeRate).not.toHaveBeenCalled();
  });

  it('rejects customer-loss referral mode before reading exchange config or touching ledger', async () => {
    const { useCase, calls, config } = makeUseCase(true, 2);
    const tx = { transaction: {} } as never;

    await expect(useCase.submit({ userId: '7' } as never, { userId: '7', request, tx, outbox: {} as never })).rejects.toMatchObject({
      code: W.EXCHANGE_NOT_AVAILABLE,
    });
    expect(calls).toEqual(['assertTransferAllowed', 'findDirectParentRewardType']);
    expect(config.readExchangeRate).not.toHaveBeenCalled();
  });

  it('runs the turnover gate in the supplied transaction before exchange reads', async () => {
    const { useCase, calls } = makeUseCase(true);
    const tx = { transaction: {} } as never;
    const assertGate = vi.spyOn(useCase['turnoverGate'], 'assertTransferAllowed');

    await expect(useCase.submit({ userId: '7' } as never, { userId: '7', request, tx, outbox: {} as never })).rejects.toBeDefined();
    expect(assertGate).toHaveBeenCalledWith('7', tx);
    expect(calls[0]).toBe('assertTransferAllowed');
    expect(calls).toEqual(['assertTransferAllowed', 'findDirectParentRewardType']);
  });
});
