import { describe, expect, it, vi } from 'vitest';
import { TurnoverStatus } from '../../../infrastructure/database/models/wallet.js';
import { W } from '../domain/errors.js';
import { SequelizeWalletLedger } from './sequelize-wallet-ledger.js';

const makeLedger = (state: Record<string, unknown> | null) => {
  const update = vi.fn(async (values: unknown) => Object.assign(state ?? {}, values));
  const findOne = vi.fn(async () => (state === null ? null : { ...state, update }));
  const ledger = new SequelizeWalletLedger({ TurnoverStateModel: { findOne } } as never, {} as never);
  const transaction = {};
  const tx = { transaction } as never;
  return { ledger, findOne, update, tx };
};

describe('SequelizeWalletLedger.consumeTurnover', () => {
  it('locks and transactionally decrements a partial effective wager', async () => {
    const state = { userId: '7', remainingCoins: '900', version: '3', status: TurnoverStatus.ACTIVE };
    const { ledger, findOne, update, tx } = makeLedger(state);
    const transaction = (tx as { transaction: object }).transaction;

    await ledger.consumeTurnover('7', 250n, tx);

    expect(findOne).toHaveBeenCalledWith({ where: { userId: '7' }, lock: 'FOR UPDATE', transaction });
    expect(update).toHaveBeenCalledWith({ remainingCoins: '650', version: '4', status: TurnoverStatus.ACTIVE }, { transaction });
  });

  it('clamps excess wager to zero and marks the requirement complete', async () => {
    const state = { userId: '7', remainingCoins: '200', version: '3', status: TurnoverStatus.ACTIVE };
    const { ledger, update, tx } = makeLedger(state);
    const transaction = (tx as { transaction: object }).transaction;

    await ledger.consumeTurnover('7', 250n, tx);

    expect(update).toHaveBeenCalledWith({ remainingCoins: '0', version: '4', status: TurnoverStatus.COMPLETE }, { transaction });
  });

  it('keeps a positive reversed requirement blocked unless balance is zero', async () => {
    const state = { userId: '7', remainingCoins: '200', version: '4', status: TurnoverStatus.REVERSED };
    const { ledger, tx } = makeLedger(state);

    await expect(ledger.getTurnover('7', tx)).resolves.toEqual({ remainingCoins: '200', canTransferOrWithdraw: false });
  });

  it('keeps a positive ACTIVE balance blocked and completed balance allowed', async () => {
    const active = makeLedger({ userId: '7', remainingCoins: '200', version: '4', status: TurnoverStatus.ACTIVE });
    const complete = makeLedger({ userId: '8', remainingCoins: '0', version: '4', status: TurnoverStatus.COMPLETE });

    await expect(active.ledger.getTurnover('7', active.tx)).resolves.toEqual({ remainingCoins: '200', canTransferOrWithdraw: false });
    await expect(complete.ledger.getTurnover('8', complete.tx)).resolves.toEqual({ remainingCoins: '0', canTransferOrWithdraw: true });
  });

  it('treats a missing state as no outstanding requirement', async () => {
    const { ledger, findOne, update, tx } = makeLedger(null);

    await expect(ledger.consumeTurnover('7', 250n, tx)).resolves.toBeNull();
    expect(findOne).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it('requires a positive wager and an explicit transaction', async () => {
    const { ledger, findOne, tx } = makeLedger(null);

    await expect(ledger.consumeTurnover('7', 0n, tx)).rejects.toMatchObject({ code: W.WALLET_STORAGE_UNAVAILABLE });
    await expect(ledger.consumeTurnover('7', 1n, {} as never)).rejects.toMatchObject({ code: W.WALLET_STORAGE_UNAVAILABLE });
    expect(findOne).not.toHaveBeenCalled();
  });
});
