/**
 * AssetLedger 适配器（Sequelize 实现 wallet 账本端口）。
 *
 * 领域所有者：wallet 模块（models/wallet.ts 7 model 的唯一账本写入点；
 * user 昵称/状态读经 identity 模块 UserModel 只读，不越界写入）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 `sender account → receiver account →
 * hold`（按 asset_account.id 数值升序 SELECT ... FOR UPDATE）；幂等先抢
 * `asset_operation.operation_key` 唯一约束，committed_at 非空 = 已成功可重放；
 * 所有分录/outbox 同事务）、§3.2 实体归属矩阵（wallet owns 7 表）、附录 A.3。
 *
 * 行锁与并发约定：
 * - `lockAccountsByIds` 逐条 `SELECT ... FOR UPDATE`（顺序 = 传入顺序 = id 升序，
 *   用例负责排序，防死锁）；InnoDB 行锁经 Sequelize `lock: 'FOR UPDATE'`。
 * - 账户入账用条件 UPDATE（WHERE version = 锁读版本）做乐观冲突判定，
 *   影响行数 0 → 抛可重试 WALLET_STORAGE_UNAVAILABLE（domain/ledger-rules.ts
 *   `assertVersionNotConflicted` 同款语义）；同账户同 account_version 唯一
 *   约束（A.3 `U(asset_account_id, account_version)`）兜底阻断并发错账。
 * - 不可变表（asset_operation/asset_entry/coin_exchange/gift_grant）只 create，
 *   model hooks 拦截 update/destroy（_shared.ts A.12 第 5 条）；唯一例外
 *   committed_at/result_snapshot 是"提交时点数据"（0004 表注释语义），经
 *   setCommitted 回填，仍属 append 面。
 * - turnover_state 是可写汇总表（非不可变），经 upsert + version 乐观锁。
 *
 * 错误码映射（contracts `WalletErrorCode`）：
 * - `IDEMPOTENCY_KEY_REUSED`：operation_key 命中且 request_hash 不一致
 *   （claimOperation 同键异内容；gift_grant U(grant_key) 冲突在 adapter
 *   `appendGiftGrant` 内按"按账号一次"语义静默返回既有行，不抛此码，
 *   由用例前置读兜底，见 application/gift-grant.ts 头注释）。
 * - `WALLET_STORAGE_UNAVAILABLE`：Sequelize 故障 / 账户缺失（未开户）/
 *   乐观 version 冲突（可重试）/ 未提交残留操作行 / turnover 乐观冲突。
 */

import { type Transaction } from 'sequelize';
import type {
  AssetAccountModel,
  AssetOperationModel,
  AssetEntryModel,
  CoinExchangeModel,
  GiftGrantModel,
  TurnoverStateModel,
} from '../../../infrastructure/database/models/wallet.js';
import { RecordStatus, ActiveStatus, TurnoverStatus } from '../../../infrastructure/database/models/wallet.js';
import type { UserModel as IdentityUserModel } from '../../../infrastructure/database/models/identity.js';
import type { AssetLedger, EntryIntent, LedgerPost, Tx } from '../ports/wallet-repository.js';
import { WalletDomainError, W, isDuplicateKeyError } from '../domain/errors.js';

/** 取事务（Sequelize Transaction 鸭子类型；无 tx = 测试/无事务直连）。
 * 返回 `Transaction | null`（Sequelize FindOptions/UpdateOptions 的 `transaction`
 * 可选属性类型为 `Transaction | null`，exactOptionalPropertyTypes 下 undefined
 * 不可赋给 null 槽，故统一 null 化，identity 适配器同款约定）。 */
function txOf(tx?: Tx): Transaction | null {
  return (tx?.transaction as Transaction | undefined) ?? null;
}

/**
 * 统一账本仓储实现（构造注入 model 类 + user 只读模型，不用全局，SDD §4）。
 * 注：Sequelize 6 的 BIGINT 列在严格模式（string 属性接口）下 create/update
 * 入参经 `as never` 桥接（identity 适配器同款写法，_shared.ts 第 8 条）。
 */
export class SequelizeWalletLedger implements AssetLedger {
  constructor(
    private readonly models: {
      AssetAccountModel: typeof AssetAccountModel;
      AssetOperationModel: typeof AssetOperationModel;
      AssetEntryModel: typeof AssetEntryModel;
      CoinExchangeModel: typeof CoinExchangeModel;
      GiftGrantModel: typeof GiftGrantModel;
      TurnoverStateModel: typeof TurnoverStateModel;
    },
    private readonly userModels: {
      UserModel: typeof IdentityUserModel;
    },
  ) {}

  // ------------------------------------------------------------------
  // 幂等抢键（asset_operation）
  // ------------------------------------------------------------------

  async claimOperation(input: {
    operationKey: string;
    operationType: number;
    requestHash: Uint8Array;
    initiatedByUserId: string | null;
    extra: Record<string, unknown> | null;
    reason: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; operation: AssetOperationModel }> {
    const txq = txOf(input.tx);
    try {
      const operation = await this.models.AssetOperationModel.create(
        {
          operationKey: input.operationKey,
          operationType: input.operationType,
          requestHash: input.requestHash,
          initiatedByUserId: input.initiatedByUserId,
          extra: input.extra,
          reason: input.reason,
          status: RecordStatus.RECORDED,
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, operation };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // 键已存在：request_hash 一致 + committed_at 非空 = 已成功，重放原结果；
        // request_hash 不一致 = 同键异内容 → IDEMPOTENCY_KEY_REUSED。
        const existing = await this.models.AssetOperationModel.findOne({
          where: { operationKey: input.operationKey },
          transaction: txq,
        });
        if (existing === null) {
          // 唯一约束冲突但读不到行（并发删除不可能，防御性兜底）。
          throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, 'operation_key conflict without row');
        }
        if (!this.hashEquals(existing.requestHash, input.requestHash)) {
          throw new WalletDomainError(W.IDEMPOTENCY_KEY_REUSED, 'operation_key reused with different request');
        }
        if (existing.committedAt === null) {
          // 前次事务回滚残留（committed_at 仅提交点回填）：首版不静默复用，
          // 抛可重试存储不可用（决策点登记：残留行清理策略）。
          throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, 'operation pending residue', {
            retryable: true,
          });
        }
        return { inserted: false, operation: existing };
      }
      // Sequelize 故障 → 存储不可用（用例统一映射）。
      throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, 'asset_operation claim failed');
    }
  }

  private hashEquals(a: Uint8Array | Buffer, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < b.length; i += 1) {
      const x = a[i];
      const y = b[i];
      if (x !== y) return false;
    }
    return true;
  }

  async setCommitted(operationId: string, committedAt: Date, resultSnapshot: Record<string, unknown>, tx: Tx): Promise<void> {
    // committed_at 为提交点回填（提交前仍在事务内写入；不可变语义由 0004
    // "提交时可重复返回的结果快照"注释承载，本字段属提交时点数据）。
    await this.models.AssetOperationModel.update(
      { committedAt, resultSnapshot } as never,
      { where: { id: operationId, committedAt: null }, transaction: txOf(tx) } as never,
    );
  }

  async getOperationResultSnapshot(operationId: string, tx: Tx): Promise<Record<string, unknown> | null> {
    const op = await this.models.AssetOperationModel.findByPk(operationId, { transaction: txOf(tx) } as never);
    return op?.resultSnapshot ?? null;
  }

  // ------------------------------------------------------------------
  // 账户锁（SELECT ... FOR UPDATE，按 asset_account.id 数值升序）
  // ------------------------------------------------------------------

  async lockAccountsByIds(accountIds: string[], tx: Tx): Promise<AssetAccountModel[]> {
    const txq = txOf(tx);
    const rows: AssetAccountModel[] = [];
    // 逐条锁（顺序 = 传入顺序 = id 升序，防死锁；批量 FOR UPDATE 无法控制顺序）。
    for (const id of accountIds) {
      const row = await this.models.AssetAccountModel.findByPk(id, { lock: 'FOR UPDATE', transaction: txq } as never);
      if (row === null) {
        // 未开户（账户行缺失）→ 存储/状态不可用（用例先行门禁应已拦截）。
        throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, `asset account missing: ${id}`);
      }
      rows.push(row);
    }
    return rows;
  }

  async readAccount(userId: string, assetType: number, accountType: number, tx?: Tx): Promise<AssetAccountModel | null> {
    return await this.models.AssetAccountModel.findOne({
      where: { userId, assetType, accountType, status: ActiveStatus.ACTIVE },
      transaction: txOf(tx),
    });
  }

  // ------------------------------------------------------------------
  // 入账（乐观 version 冲突判定 + 分录追加）
  // ------------------------------------------------------------------

  async postEntries(operationId: string, intents: EntryIntent[], tx: Tx): Promise<LedgerPost[]> {
    const txq = txOf(tx);
    // 按账户聚合意图（用例层 domain 已校验守恒/符号，本方法只做落库）。
    const byAccount = new Map<string, EntryIntent[]>();
    for (const intent of intents) {
      const list = byAccount.get(intent.accountId) ?? [];
      list.push(intent);
      byAccount.set(intent.accountId, list);
    }
    // 锁读（id 数值升序，保持锁顺序不变量；重复 id 去重）。
    const orderedIds = [...new Set(intents.map((i) => i.accountId))].sort((a, b) => {
      const bigA = BigInt(a);
      const bigB = BigInt(b);
      return bigA < bigB ? -1 : bigA > bigB ? 1 : 0;
    });
    const accounts: AssetAccountModel[] = [];
    for (const id of orderedIds) {
      const row = await this.models.AssetAccountModel.findByPk(id, { lock: 'FOR UPDATE', transaction: txq } as never);
      if (row === null) throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, `asset account missing: ${id}`);
      accounts.push(row);
    }

    const posts: LedgerPost[] = [];
    let seq = 0;
    for (const row of accounts) {
      const rowIntents = byAccount.get(row.id) ?? [];
      if (rowIntents.length === 0) continue;
      let amount = BigInt(row.amount);
      let frozen = BigInt(row.frozenAmount);
      let version = BigInt(row.version);
      // 逐笔分录（同一账户多笔 delta 按序计算 after 值与版本，
      // U(asset_operation_id, entry_seq) + U(asset_account_id, account_version) 兜底）。
      for (const intent of rowIntents) {
        seq += 1;
        version += 1n;
        amount += intent.delta;
        frozen += intent.frozenDelta;
        await this.models.AssetEntryModel.create(
          {
            assetOperationId: operationId,
            assetAccountId: row.id,
            assetHoldId: null,
            entrySeq: seq,
            entryType: intent.entryType,
            delta: intent.delta.toString(),
            frozenDelta: intent.frozenDelta.toString(),
            amountAfter: amount.toString(),
            frozenAfter: frozen.toString(),
            accountVersion: version.toString(),
            memo: intent.memo,
            status: RecordStatus.RECORDED,
          } as never,
          { transaction: txq } as never,
        );
      }
      // 账户入账（条件 UPDATE：WHERE version = 锁读版本 → 乐观冲突判定）。
      const [affected] = await this.models.AssetAccountModel.update(
        { amount: amount.toString(), frozenAmount: frozen.toString(), version: version.toString() } as never,
        {
          where: { id: row.id, version: row.version },
          transaction: txq,
        } as never,
      );
      if (affected === 0) {
        // 锁读后被并发修改（理论上 FOR UPDATE 已串行化；防御性判定，
        // domain/ledger-rules.ts `assertVersionNotConflicted` 同款语义）。
        throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, `version conflict on account ${row.id}`, {
          retryable: true,
        });
      }
      posts.push({ accountId: row.id, version, amount, frozenAmount: frozen });
    }
    return posts;
  }

  // ------------------------------------------------------------------
  // coin_exchange / gift_grant / turnover_state 快照
  // ------------------------------------------------------------------

  async appendCoinExchange(input: {
    userId: string;
    assetOperationId: string;
    coins: bigint;
    cashCents: bigint;
    feeCents: bigint;
    rateCoinUnits: bigint;
    rateCashFen: bigint;
    roundingType: number;
    previewKey: string;
    tx: Tx;
  }): Promise<CoinExchangeModel> {
    return await this.models.CoinExchangeModel.create(
      {
        userId: input.userId,
        assetOperationId: input.assetOperationId,
        coins: input.coins.toString(),
        cashCents: input.cashCents.toString(),
        feeCents: input.feeCents.toString(),
        rateCoinUnits: input.rateCoinUnits.toString(),
        rateCashFen: input.rateCashFen.toString(),
        roundingType: input.roundingType,
        previewKey: input.previewKey,
        status: RecordStatus.RECORDED,
      } as never,
      { transaction: txOf(input.tx) } as never,
    );
  }

  async appendGiftGrant(input: {
    userId: string;
    assetOperationId: string;
    orderId: string | null;
    grantKey: string;
    coins: bigint;
    turnoverMultiplier: string;
    requiredTurnoverCoins: bigint;
    tx: Tx;
  }): Promise<GiftGrantModel> {
    try {
      return await this.models.GiftGrantModel.create(
        {
          userId: input.userId,
          assetOperationId: input.assetOperationId,
          orderId: input.orderId,
          grantKey: input.grantKey,
          coins: input.coins.toString(),
          turnoverMultiplier: input.turnoverMultiplier,
          requiredTurnoverCoins: input.requiredTurnoverCoins.toString(),
          status: RecordStatus.RECORDED,
        } as never,
        { transaction: txOf(input.tx) } as never,
      );
    } catch (err) {
      // U(grant_key) 兜底（赠币按账号一次，任务硬约定 6）：并发同键命中时
      // 返回既有行，由用例前置读决定静默成功。
      if (isDuplicateKeyError(err)) {
        const existing = await this.models.GiftGrantModel.findOne({
          where: { grantKey: input.grantKey },
          transaction: txOf(input.tx),
        });
        if (existing !== null) return existing;
      }
      throw err;
    }
  }

  async readTurnoverState(userId: string, tx?: Tx): Promise<TurnoverStateModel | null> {
    return await this.models.TurnoverStateModel.findOne({
      where: { userId },
      transaction: txOf(tx),
    });
  }

  async upsertTurnoverState(userId: string, requiredCoins: bigint, expectedVersion: bigint | null, tx: Tx): Promise<TurnoverStateModel> {
    const txq = txOf(tx);
    const state = await this.models.TurnoverStateModel.findOne({ where: { userId }, lock: 'FOR UPDATE', transaction: txq } as never);
    if (state === null) {
      return await this.models.TurnoverStateModel.create(
        {
          userId,
          remainingCoins: requiredCoins.toString(),
          version: '1',
          status: TurnoverStatus.ACTIVE,
        } as never,
        { transaction: txq } as never,
      );
    }
    // 乐观锁：expectedVersion 非空且与锁读版本不符 → 冲突（可重试）。
    if (expectedVersion !== null && BigInt(state.version) !== expectedVersion) {
      throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, `turnover version conflict for user ${userId}`, {
        retryable: true,
      });
    }
    const newRemaining = BigInt(state.remainingCoins) + requiredCoins;
    const newVersion = BigInt(state.version) + 1n;
    await state.update(
      {
        remainingCoins: newRemaining.toString(),
        version: newVersion.toString(),
        status: TurnoverStatus.ACTIVE,
      } as never,
      { transaction: txq },
    );
    return state;
  }

  // ------------------------------------------------------------------
  // user 只读（昵称 / 状态门禁；不写入 identity 表）
  // ------------------------------------------------------------------

  async readNickname(userId: string, tx?: Tx): Promise<string | null> {
    const user = await this.userModels.UserModel.findByPk(userId, {
      attributes: ['nickname'],
      transaction: txOf(tx),
    });
    return user?.nickname ?? null;
  }

  async readUser(userId: string, tx?: Tx): Promise<IdentityUserModel | null> {
    return await this.userModels.UserModel.findByPk(userId, { transaction: txOf(tx) });
  }

  async getTurnover(userId: string, tx?: Tx): Promise<{ remainingCoins: string; canTransferOrWithdraw: boolean } | null> {
    const state = await this.readTurnoverState(userId, tx);
    if (state === null) return null;
    const remaining = BigInt(state.remainingCoins);
    return {
      remainingCoins: remaining.toString(),
      // remaining_coins > 0 → 未完成流水，禁止提现/转出（双资产文档 §2 / AGENTS.md）。
      canTransferOrWithdraw: remaining === 0n || state.status === TurnoverStatus.COMPLETE,
    };
  }

  async readWelcomeGift(userId: string, tx?: Tx): Promise<{ coins: string; turnoverRequirement: string } | null> {
    const grant = await this.models.GiftGrantModel.findOne({
      where: { grantKey: `welcome:${userId}` },
      order: [['createdAt', 'DESC']],
      transaction: txOf(tx),
    });
    if (grant === null) return null;
    return { coins: grant.coins, turnoverRequirement: grant.requiredTurnoverCoins };
  }
}
