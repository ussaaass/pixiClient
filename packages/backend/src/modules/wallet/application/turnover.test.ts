import { describe, expect, it, vi } from 'vitest';
import { TurnoverGateUseCase } from './turnover.js';
import { W, WalletDomainError } from '../domain/errors.js';
import type { AssetLedger, Tx, TurnoverState } from '../ports/wallet-repository.js';

function makeGate(state: TurnoverState | null | Error) {
  const ledger = {
    getTurnover: vi.fn(async (_userId: string, _tx?: Tx): Promise<TurnoverState | null> => {
      if (state instanceof Error) throw state;
      return state;
    }),
  } as unknown as AssetLedger;
  return { gate: new TurnoverGateUseCase(ledger), ledger };
}

describe('TurnoverGateUseCase', () => {
  it('allows transfer when there is no turnover state', async () => {
    const { gate } = makeGate(null);

    await expect(gate.evaluate('7')).resolves.toEqual({
      remainingCoins: '0',
      canTransferOrWithdraw: true,
      source: 'no-state',
    });
    await expect(gate.assertTransferAllowed('7', {})).resolves.toBeUndefined();
  });

  it('denies positive turnover when the ledger gate is closed and reports the exact domain error', async () => {
    const { gate } = makeGate({ remainingCoins: '250', canTransferOrWithdraw: false });

    await expect(gate.evaluate('7')).resolves.toEqual({
      remainingCoins: '250',
      canTransferOrWithdraw: false,
      source: 'state-row',
    });
    await expect(gate.assertTransferAllowed('7', {})).rejects.toMatchObject({
      name: 'WalletDomainError',
      code: W.TURNOVER_INCOMPLETE,
      message: 'turnover incomplete: 250 coins remaining',
    });
  });

  it('allows a state with no remaining amount as directed by the ledger', async () => {
    const { gate } = makeGate({ remainingCoins: '0', canTransferOrWithdraw: true });

    await expect(gate.evaluate('7')).resolves.toEqual({
      remainingCoins: '0',
      canTransferOrWithdraw: true,
      source: 'state-row',
    });
    await expect(gate.assertTransferAllowed('7', {})).resolves.toBeUndefined();
  });

  it('denies positive turnover when the ledger gate is closed', async () => {
    const { gate } = makeGate({ remainingCoins: '80', canTransferOrWithdraw: false });

    await expect(gate.evaluate('7')).resolves.toMatchObject({
      remainingCoins: '80',
      canTransferOrWithdraw: false,
      source: 'state-row',
    });
    await expect(gate.assertTransferAllowed('7', {})).rejects.toMatchObject({ code: W.TURNOVER_INCOMPLETE });
  });

  it('maps storage failures to WALLET_STORAGE_UNAVAILABLE', async () => {
    const { gate } = makeGate(new Error('database unavailable'));

    await expect(gate.evaluate('7')).rejects.toMatchObject({
      name: 'WalletDomainError',
      code: W.WALLET_STORAGE_UNAVAILABLE,
      message: 'turnover state read failed',
    });
  });

  it('preserves an existing wallet domain error from storage', async () => {
    const storageError = new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, 'specific storage failure');
    const { gate } = makeGate(storageError);

    await expect(gate.evaluate('7')).rejects.toBe(storageError);
  });

  it('passes the exact transaction to the ledger and allows when the ledger permits', async () => {
    const tx: Tx = { transaction: { marker: 'caller transaction' } };
    const { gate, ledger } = makeGate({ remainingCoins: '0', canTransferOrWithdraw: true });

    await expect(gate.assertTransferAllowed('7', tx)).resolves.toBeUndefined();
    expect(ledger.getTurnover).toHaveBeenCalledOnce();
    expect(ledger.getTurnover).toHaveBeenCalledWith('7', tx);
  });
});
