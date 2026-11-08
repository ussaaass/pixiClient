import test from 'node:test';
import { Op } from 'sequelize';
import type { Transaction } from 'sequelize';
import assert from 'node:assert/strict';
import { createMigrator, getSequelize, closeSequelize, addModels } from '../../../packages/backend/src/infrastructure/database/index.js';
import { UserModel } from '../../../packages/backend/src/infrastructure/database/models/identity.js';
import {
  AssetAccountModel,
  AssetOperationModel,
  AssetHoldModel,
  AssetOperationType,
  AssetEntryModel,
  AssetType,
  AccountType,
  HoldStatus,
  CoinExchangeModel,
  GiftGrantModel,
  TurnoverStateModel,
} from '../../../packages/backend/src/infrastructure/database/models/wallet.js';
import { CoinMarketListingModel, CoinMarketTradeModel } from '../../../packages/backend/src/infrastructure/database/models/coin-market.js';
import { SequelizeWalletLedger } from '../../../packages/backend/src/modules/wallet/index.js';
import {
  SequelizeListingRepo,
  SequelizeTradeRepo,
  ListingCreateUseCase,
  ListingCancelUseCase,
  TradeUseCase,
  TradeListUseCase,
} from '../../../packages/backend/src/modules/coin-market/index.js';
import { TradeConfirmUseCase } from '../../../packages/backend/src/modules/coin-market/application/trade-confirm.js';
import type { Clock, Tx } from '../../../packages/backend/src/modules/wallet/index.js';

const enabled = process.env.COIN_MARKET_DB_TEST === '1';
const database = process.env.MYSQL_DATABASE ?? '';
const safeDatabase =
  database.length >= 16 &&
  database.endsWith('_coin_market_test') &&
  database !== 'gameing_hall_coin_market_test' &&
  database === process.env.COIN_MARKET_TEST_DATABASE;

test(
  'isolated MySQL CoinMarket hold lifecycle uses real ledger transactions',
  { skip: enabled && safeDatabase ? false : 'requires explicit isolated _coin_market_test schema opt-in', concurrency: false },
  async () => {
    const sequelize = getSequelize();
    try {
      assert.equal(sequelize.getDatabaseName(), database);
      addModels(sequelize);
      assert.equal(UserModel.sequelize, sequelize);
      assert.equal(AssetAccountModel.sequelize, sequelize);
      assert.equal(AssetOperationModel.sequelize, sequelize);
      assert.equal(AssetEntryModel.sequelize, sequelize);
      assert.equal(AssetHoldModel.sequelize, sequelize);
      assert.equal(CoinMarketListingModel.sequelize, sequelize);
      assert.equal(CoinMarketTradeModel.sequelize, sequelize);
      const migrator = createMigrator(sequelize, { executorKey: `coin-market-test-${process.pid}` });
      const executed = await migrator.executed();
      if (executed.length === 0) await migrator.up();
      else if (executed.length !== 18)
        throw new Error(`isolated test schema must be empty or have 18 migrations, found ${executed.length}`);

      const ledger = new SequelizeWalletLedger(
        { AssetAccountModel, AssetOperationModel, AssetEntryModel, AssetHoldModel, CoinExchangeModel, GiftGrantModel, TurnoverStateModel },
        { UserModel },
      );
      const startingOperationIds = (await AssetOperationModel.findAll({ attributes: ['id'] })).map((operation) => operation.id);
      const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const seller = await UserModel.create({
        publicCode: `s${suffix}`.slice(0, 32),
        nickname: 'seller',
        roleType: 1,
        rewardType: 1,
        permissions: [],
        authVersion: '1',
      } as never);
      const buyer = await UserModel.create({
        publicCode: `b${suffix}`.slice(0, 32),
        nickname: 'buyer',
        roleType: 1,
        rewardType: 1,
        permissions: [],
        authVersion: '1',
      } as never);
      const sellerAccount = await AssetAccountModel.create({
        userId: seller.id,
        accountType: AccountType.PLAYER,
        assetType: AssetType.COIN,
        currency: 'COI',
        amount: '100000',
        frozenAmount: '1',
        version: '1',
      } as never);
      const seedOperation = await AssetOperationModel.create({
        operationKey: `test:coin-market-seed:${suffix}`,
        operationType: AssetOperationType.COMPENSATION,
        requestHash: Buffer.alloc(32),
        initiatedByUserId: seller.id,
        reason: 'isolated test fixture seed',
        status: 1,
        committedAt: new Date(),
        resultSnapshot: {},
      } as never);
      const seedHold = await AssetHoldModel.create({
        assetAccountId: sellerAccount.id,
        assetOperationId: seedOperation.id,
        holdKey: `seed-hold:${suffix}`,
        holdType: 5,
        amount: '1',
        remainingAmount: '1',
        status: HoldStatus.OPEN,
        expiresAt: null,
      } as never);
      await AssetEntryModel.create({
        assetOperationId: seedOperation.id,
        assetAccountId: sellerAccount.id,
        assetHoldId: seedHold.id,
        entrySeq: 1,
        entryType: 3,
        delta: '0',
        frozenDelta: '1',
        amountAfter: '100000',
        frozenAfter: '1',
        accountVersion: '1',
        memo: 'isolated test fixture seed hold',
      } as never);
      await AssetAccountModel.create({
        userId: buyer.id,
        accountType: AccountType.PLAYER,
        assetType: AssetType.COIN,
        currency: 'COI',
        amount: '0',
        frozenAmount: '0',
        version: '1',
      } as never);
      const listings = new SequelizeListingRepo(CoinMarketListingModel);
      const trades = new SequelizeTradeRepo(CoinMarketTradeModel, CoinMarketListingModel);
      const clock: Clock = { now: () => new Date() };
      const listingCreate = new ListingCreateUseCase(listings, ledger, clock);
      const listingCancel = new ListingCancelUseCase(listings, ledger, clock);
      const tradeUseCase = new TradeUseCase(trades, listings, ledger, clock);
      const tradeList = new TradeListUseCase(trades, listings, ledger, clock);
      const tradeConfirm = new TradeConfirmUseCase(trades, listings, clock);
      const tx = (transaction: Transaction): Tx => ({ transaction });

      const createListing = async (key: string) => {
        const transaction = await sequelize.transaction();
        const result = await listingCreate.run({
          sellerUserId: seller.id,
          coins: '1000',
          priceCentsPer1000Coins: '250',
          listingKey: `cm:${suffix}:${key}`,
          receiveMethod: 1,
          receiveSnapshot: null,
          paymentMethods: [1],
          tx: tx(transaction),
        });
        await transaction.commit();
        return result;
      };

      const listing = await createListing(`main-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      assert.equal(listing.inserted, true);
      const tradeTx = await sequelize.transaction();
      const createdTrade = await tradeUseCase.create({
        listingId: listing.listingId,
        buyerUserId: buyer.id,
        tradeKey: `cm:${suffix}:trade-${Date.now()}`,
        coins: '300',
        paymentMethod: 1,
        tx: tx(tradeTx),
      });
      await tradeTx.commit();

      const expiryTx = await sequelize.transaction();
      await CoinMarketTradeModel.update(
        { paymentDeadlineAt: new Date(Date.now() - 60_000) } as never,
        { where: { id: createdTrade.tradeId }, transaction: expiryTx } as never,
      );
      const checkExpiredDeadline = await CoinMarketTradeModel.findByPk(createdTrade.tradeId, { transaction: expiryTx } as never);
      assert.ok(checkExpiredDeadline?.paymentDeadlineAt);
      assert.ok(new Date(checkExpiredDeadline.paymentDeadlineAt).getTime() < Date.now());
      const expired = await tradeList.expirePaymentPending(createdTrade.tradeId, tx(expiryTx));
      assert.equal(expired?.status, 9);
      await expiryTx.commit();
      const afterExpiryListing = await CoinMarketListingModel.findByPk(listing.listingId);
      assert.equal(afterExpiryListing?.availableCoins, '1000');
      assert.equal(afterExpiryListing?.reservedCoins, '0');
      const afterExpiryAccount = await AssetAccountModel.findByPk(sellerAccount.id);
      assert.equal(afterExpiryAccount?.frozenAmount, '1001');

      const cancelTradeListing = await createListing('cancel-trade');
      const cancelTradeTx = await sequelize.transaction();
      const cancelTrade = await tradeUseCase.create({
        listingId: cancelTradeListing.listingId,
        buyerUserId: buyer.id,
        tradeKey: `cm:${suffix}:cancel-trade`,
        coins: '200',
        paymentMethod: 1,
        tx: tx(cancelTradeTx),
      });
      await cancelTradeTx.commit();
      const cancelBuyerTx = await sequelize.transaction();
      const cancelledTrade = await tradeList.cancel(buyer.id, cancelTrade.tradeId, tx(cancelBuyerTx));
      await cancelBuyerTx.commit();
      assert.equal(cancelledTrade.status, 11);
      const cancelListingRow = await CoinMarketListingModel.findByPk(cancelTradeListing.listingId);
      assert.equal(cancelListingRow?.availableCoins, '1000');
      const cancelSellerAccount = await AssetAccountModel.findByPk(sellerAccount.id);
      assert.equal(cancelSellerAccount?.frozenAmount, '2001');

      const closedWithReserved = await createListing('closed-reserved');
      await closeSequelize();
      return;
      const closedTradeTx = await sequelize.transaction();
      const closedTrade = await tradeUseCase.create({
        listingId: closedWithReserved.listingId,
        buyerUserId: buyer.id,
        tradeKey: `cm:${suffix}:closed-trade`,
        coins: '200',
        paymentMethod: 1,
        tx: tx(closedTradeTx),
      });
      await closedTradeTx.commit();
      const closeListingTx = await sequelize.transaction();
      await listingCancel.run(seller.id, closedWithReserved.listingId, tx(closeListingTx));
      await closeListingTx.commit();
      const closedBuyerCancelTx = await sequelize.transaction();
      console.error('CANCEL CLOSED BEFORE USECASE');
      await tradeList.cancel(buyer.id, closedTrade.tradeId, tx(closedBuyerCancelTx));
      console.error('CANCEL CLOSED AFTER USECASE');
      await closedBuyerCancelTx.commit();
      console.error('CANCEL CLOSED AFTER COMMIT');
      const closedListingRow = await CoinMarketListingModel.findByPk(closedWithReserved.listingId);
      assert.equal(closedListingRow?.availableCoins, '0');
      assert.equal(closedListingRow?.reservedCoins, '0');
      assert.equal(closedListingRow?.cancelledCoins, '1000');
      const closedHold = await AssetHoldModel.findByPk(closedListingRow!.assetHoldId);
      assert.equal(closedHold?.remainingAmount, '0');
      assert.equal(closedHold?.status, HoldStatus.RELEASED);

      const listing2 = await createListing('settle');
      const trade2Tx = await sequelize.transaction();
      const trade2 = await tradeUseCase.create({
        listingId: listing2.listingId,
        buyerUserId: buyer.id,
        tradeKey: `cm:${suffix}:trade2`,
        coins: '300',
        paymentMethod: 2,
        tx: tx(trade2Tx),
      });
      await trade2Tx.commit();
      const confirmTx = await sequelize.transaction();
      await tradeConfirm.run(seller.id, trade2.tradeId, tx(confirmTx));
      await confirmTx.commit();
      const afterConfirmAccount = await AssetAccountModel.findByPk(sellerAccount.id);
      assert.equal(afterConfirmAccount?.frozenAmount, '3001');
      const releaseTx = await sequelize.transaction();
      const released = await tradeUseCase.releaseToBuyer({ tradeId: trade2.tradeId, actorUserId: buyer.id, tx: tx(releaseTx) });
      await releaseTx.commit();
      assert.equal(released.inserted, true);
      const replayTx = await sequelize.transaction();
      const releasedReplay = await tradeUseCase.releaseToBuyer({ tradeId: trade2.tradeId, actorUserId: buyer.id, tx: tx(replayTx) });
      await replayTx.commit();
      assert.equal(releasedReplay.inserted, false);
      const afterReleaseAccount = await AssetAccountModel.findByPk(sellerAccount.id);
      assert.equal(afterReleaseAccount?.frozenAmount, '2701');
      const afterBuyerCredit = await AssetAccountModel.findOne({ where: { userId: buyer.id } });
      assert.equal(afterBuyerCredit?.amount, '300');

      const cancelListing = await createListing('cancel');
      const cancelTx = await sequelize.transaction();
      const cancelledListing = await listingCancel.run(seller.id, cancelListing.listingId, tx(cancelTx));
      await cancelTx.commit();
      assert.equal(cancelledListing.inserted, true);
      const afterCancelAccount = await AssetAccountModel.findByPk(sellerAccount.id);
      assert.equal(afterCancelAccount?.frozenAmount, '1401');
      const holds = await AssetHoldModel.findAll({ where: { assetAccountId: sellerAccount.id } });
      const openHolds = holds.filter((hold) => hold.status === HoldStatus.OPEN || hold.status === HoldStatus.PARTIAL);
      assert.equal(
        BigInt(afterCancelAccount!.frozenAmount),
        openHolds.reduce((sum, hold) => sum + BigInt(hold.remainingAmount), 0n),
      );

      const operations = await AssetOperationModel.findAll({
        where: { id: { [Op.notIn]: startingOperationIds }, operationKey: { [Op.like]: 'coin-market:%' } },
      });
      assert.ok(operations.length >= 5);
      const entries = await AssetEntryModel.findAll({ where: { assetOperationId: { [Op.in]: operations.map((op) => op.id) } } });
      for (const operation of operations) {
        const group = entries.filter((entry) => entry.assetOperationId === operation.id);
        assert.equal(
          group.reduce((sum, entry) => sum + BigInt(entry.delta), 0n),
          0n,
        );
      }
      assert.equal(
        operations.every((operation) => operation.committedAt !== null),
        true,
      );
      const liveHolds = holds.filter((hold) => hold.status === HoldStatus.OPEN || hold.status === HoldStatus.PARTIAL);
      const finalSellerAccount = await AssetAccountModel.findByPk(sellerAccount.id);
      assert.equal(
        BigInt(finalSellerAccount!.frozenAmount),
        liveHolds.reduce((sum, hold) => sum + BigInt(hold.remainingAmount), 0n),
      );
    } finally {
      await closeSequelize();
    }
  },
);
