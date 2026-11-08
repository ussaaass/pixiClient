import { describe, expect, it, vi } from 'vitest';
import { AccountType, ActiveStatus, AssetType } from '../../../infrastructure/database/models/wallet.js';
import { W } from '../domain/errors.js';
import { SequelizeWalletLedger } from './sequelize-wallet-ledger.js';

type Account = {
  id: string;
  userId: string;
  accountType: number;
  assetType: number;
  currency: string;
  status: number;
  amount: string;
  frozenAmount: string;
  version: string;
};

const account = (assetType: number, currency: string, overrides: Partial<Account> = {}): Account => ({
  id: String(assetType),
  userId: '7',
  accountType: AccountType.PLAYER,
  assetType,
  currency,
  status: ActiveStatus.ACTIVE,
  amount: '0',
  frozenAmount: '0',
  version: '1',
  ...overrides,
});

const makeLedger = (initial: Account[] = []) => {
  const rows = new Map(initial.map((row) => [`${row.assetType}:${row.currency}`, row]));
  const findOne = vi.fn(
    async ({ where }: { where: { assetType: number; currency: string } }) => rows.get(`${where.assetType}:${where.currency}`) ?? null,
  );
  const create = vi.fn(async (values: Omit<Account, 'id' | 'status' | 'amount' | 'frozenAmount' | 'version'>) => {
    const row = account(values.assetType, values.currency, { userId: values.userId });
    rows.set(`${row.assetType}:${row.currency}`, row);
    return row;
  });
  const update = vi.fn();
  const ledger = new SequelizeWalletLedger({ AssetAccountModel: { findOne, create, update } } as never, {} as never);
  const transaction = {};
  return { ledger, findOne, create, update, rows, tx: { transaction } as never, transaction };
};

describe('SequelizeWalletLedger.ensurePlayerAccounts', () => {
  it('creates missing COI and CNY PLAYER accounts with no mutable balance/status fields', async () => {
    const { ledger, create, update, transaction, tx } = makeLedger();

    const result = await ledger.ensurePlayerAccounts('7', tx);

    expect(result.map(({ assetType, currency }) => [assetType, currency])).toEqual([
      [AssetType.COIN, 'COI'],
      [AssetType.CNY_BALANCE, 'CNY'],
    ]);
    expect(create).toHaveBeenNthCalledWith(
      1,
      { userId: '7', accountType: AccountType.PLAYER, assetType: AssetType.COIN, currency: 'COI' },
      { transaction },
    );
    expect(create).toHaveBeenNthCalledWith(
      2,
      { userId: '7', accountType: AccountType.PLAYER, assetType: AssetType.CNY_BALANCE, currency: 'CNY' },
      { transaction },
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('returns existing accounts without mutating balances or status', async () => {
    const coin = account(AssetType.COIN, 'COI', { amount: '314', frozenAmount: '20', version: '9' });
    const cny = account(AssetType.CNY_BALANCE, 'CNY', { amount: '7200', frozenAmount: '100', version: '5' });
    const { ledger, create, update } = makeLedger([coin, cny]);

    const result = await ledger.ensurePlayerAccounts('7', { transaction: {} } as never);

    expect(result).toEqual([coin, cny]);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(result.map(({ amount, frozenAmount, version }) => [amount, frozenAmount, version])).toEqual([
      ['314', '20', '9'],
      ['7200', '100', '5'],
    ]);
  });

  it('rereads a concurrently created unique row and returns it without overwriting', async () => {
    const coin = account(AssetType.COIN, 'COI', { amount: '50', version: '4' });
    const cny = account(AssetType.CNY_BALANCE, 'CNY');
    const create = vi.fn(async (values: { assetType: number; currency: string }) => {
      if (values.assetType === AssetType.COIN) {
        throw { name: 'SequelizeUniqueConstraintError' };
      }
      return cny;
    });
    const findOne = vi.fn(async ({ where }: { where: { assetType: number; currency: string } }) =>
      where.assetType === AssetType.COIN
        ? findOne.mock.calls.filter(([arg]) => arg.where.assetType === AssetType.COIN).length > 1
          ? coin
          : null
        : null,
    );
    const ledger = new SequelizeWalletLedger({ AssetAccountModel: { findOne, create, update: vi.fn() } } as never, {} as never);
    const transaction = {};

    await expect(ledger.ensurePlayerAccounts('7', { transaction } as never)).resolves.toEqual([coin, cny]);
    expect(findOne).toHaveBeenNthCalledWith(2, {
      where: { userId: '7', assetType: AssetType.COIN, currency: 'COI' },
      lock: 'FOR UPDATE',
      transaction,
    });
  });

  it('rejects absent, inactive, or mismatched accounts without updating them', async () => {
    const missingLedger = makeLedger();
    missingLedger.create.mockRejectedValue({ name: 'SequelizeUniqueConstraintError' });
    missingLedger.findOne.mockResolvedValue(null);
    await expect(missingLedger.ledger.ensurePlayerAccounts('7', missingLedger.tx)).rejects.toMatchObject({
      code: W.WALLET_STORAGE_UNAVAILABLE,
    });

    for (const bad of [
      account(AssetType.COIN, 'COI', { status: ActiveStatus.DISABLED }),
      account(AssetType.COIN, 'COI', { accountType: AccountType.SYSTEM }),
      account(AssetType.COIN, 'COI', { userId: '8' }),
    ]) {
      const fixture = makeLedger([bad, account(AssetType.CNY_BALANCE, 'CNY')]);
      await expect(fixture.ledger.ensurePlayerAccounts('7', fixture.tx)).rejects.toMatchObject({
        code: W.WALLET_STORAGE_UNAVAILABLE,
      });
      expect(fixture.update).not.toHaveBeenCalled();
    }
  });

  it('fails closed if a queried account carries the wrong asset or currency', async () => {
    for (const bad of [account(AssetType.CNY_BALANCE, 'COI'), account(AssetType.COIN, 'CNY')]) {
      const findOne = vi.fn(async () => bad);
      const ledger = new SequelizeWalletLedger({ AssetAccountModel: { findOne } } as never, {} as never);
      await expect(ledger.ensurePlayerAccounts('7', { transaction: {} } as never)).rejects.toMatchObject({
        code: W.WALLET_STORAGE_UNAVAILABLE,
      });
    }
  });

  it('requires a present, active transaction before any database call', async () => {
    const { ledger, findOne, create } = makeLedger();
    await expect(ledger.ensurePlayerAccounts('7', {} as never)).rejects.toThrow('requires an active transaction');
    await expect(ledger.ensurePlayerAccounts('7', { transaction: { finished: 'commit' } } as never)).rejects.toThrow(
      'requires an active transaction',
    );
    expect(findOne).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
