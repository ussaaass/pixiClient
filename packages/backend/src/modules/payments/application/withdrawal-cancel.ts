/**
 * 提现取消用例：POST /me/wallet/withdrawals/:withdrawalId/cancel。
 *
 * 领域所有者：payments 模块（withdrawal 状态机 1/2→7 + 占款释放，经 wallet
 * `AssetLedger` 反向分录 + releaseHold）。
 * 对应 SDD 章节：后端实施 SDD §5.4（cancelWithdrawal 端点，契约
 * `WalletEndpoint.cancelWithdrawal` 200）、§9 第 3 步（提现审核→出款状态机
 * 全链路）、§10 红线（幂等释放、未知出款不重复支付）；双资产文档 §4
 * （"合法取消时幂等释放占款"，"待审核状态可取消，事务同时改为 CANCELLED
 * 并释放冻结"——§5.1 离线切片同款语义）、§5.1（"拒绝/取消/失败时幂等释放"）。
 *
 * 用例语义（单事务，经 module.withTx 同事务 outbox）：
 * 1. 定位 withdrawal（行锁 SELECT FOR UPDATE；缺失/非本人 → WITHDRAWAL_NOT_FOUND）。
 * 2. 状态门禁：仅 REQUESTED=1 / REVIEWING=2 可取消（domain/rules.ts
 *    `withdrawalAllowedTransitions` 转换表 1/2→7；3+ 态出款流程中 → 拒绝）。
 * 3. 释放占款（WITHDRAWAL_RELEASE=8 操作 + 反向分录 + releaseHold）：
 *    - 幂等：已 CANCELLED=7 重放 → 静默返回（不二次释放，§10 "补偿可对账"）；
 *    - 反向分录（玩家 CNY frozen -（净+费）；系统 CNY -（净+费）；
 *      HOLD=3 分录类型，与占款分录对称）；
 *    - asset_hold RELEASED=4（`ledger.releaseHold` 幂等）；
 *    - withdrawal → CANCELLED=7（adapter `transition` 校验转换表）。
 * 4. outbox('payments.withdrawal.cancelled') 同事务（§6.3）。
 *
 * 错误码映射（contracts `WalletErrorCode` 子集 → 触发条件）：
 * - `WITHDRAWAL_NOT_FOUND`：withdrawal 行缺失或非本人（防御：路由层已按
 *   session 解析 userId，本处二次校验归属）。
 * - `WITHDRAWAL_NOT_CANCELLABLE`：状态非 1/2（出款流程中/终态不可取消；
 *   含 PAYMENT_UNKNOWN=8——未知出款保持占款，不释放，§4 "不直接重发或释放
 *   导致二次出款"，对账 worker 落地前取消入口不放行 8 态）。
 * - `IDEMPOTENCY_KEY_REUSED`：同 release 操作键异内容（防御）。
 * - `WALLET_STORAGE_UNAVAILABLE`：Sequelize 故障 / 账户缺失 / 乐观冲突（可重试）。
 * - 成功 → WithdrawalDto（200；已 CANCELLED 重放 = 静默 200，不产生第二笔释放）。
 */

import type { WithdrawalDto } from '@gameing/contracts/wallet';
import { AssetOperationType, AssetType, AccountType } from '../../../infrastructure/database/models/wallet.js';
import { WithdrawalStatus } from '../../../infrastructure/database/models/payments.js';
import { requestHashOf, isWithdrawalTransitionAllowed } from '../domain/rules.js';
import { PaymentDomainError, P } from '../domain/errors.js';
import type {
  WithdrawalRepository,
  Tx,
  AssetLedger,
  Clock,
  EntryIntent,
  OutboxPort,
  SystemIdentityPort,
} from '../ports/payments-repository.js';
import { WalletEntryType } from '../../wallet/ports/wallet-repository.js';
import { toDateIso } from '../../wallet/adapters/row-mappers.js';

export interface CancelWithdrawalInput {
  userId: string;
  withdrawalId: string;
  tx: Tx;
  outbox: OutboxPort;
}

export interface CancelWithdrawalResult {
  dto: WithdrawalDto;
  /** 本次是否真正释放占款（false = 已 CANCELLED 重放静默）。 */
  released: boolean;
}

export class WithdrawalCancelUseCase {
  constructor(
    private readonly withdrawals: WithdrawalRepository,
    private readonly ledger: AssetLedger,
    private readonly systemIdentity: SystemIdentityPort,
    private readonly clock: Clock,
  ) {}

  /** 取消提现申请（仅 1/2 态；幂等释放占款 + outbox 同事务）。 */
  async cancel(userId: string, input: CancelWithdrawalInput): Promise<CancelWithdrawalResult> {
    const { tx, outbox } = input;
    const withdrawal = await this.withdrawals.lockByPk(input.withdrawalId, tx);
    if (withdrawal.userId !== userId) {
      throw new PaymentDomainError(P.WITHDRAWAL_NOT_FOUND, 'withdrawal not owned by user');
    }

    // 幂等：已 CANCELLED（7）重放 → 静默返回（不二次释放，§10 补偿可对账）。
    if (withdrawal.status === WithdrawalStatus.CANCELLED) {
      return { dto: this.toDto(withdrawal), released: false };
    }
    // 状态门禁（1/2→7 合法；其余 → NOT_CANCELLABLE，含 8 PAYMENT_UNKNOWN
    // 保持占款语义——出款未知不释放，对账 worker 落地前不开放，双资产文档 §4）。
    if (!isWithdrawalTransitionAllowed(withdrawal.status as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9, WithdrawalStatus.CANCELLED)) {
      throw new PaymentDomainError(
        P.WITHDRAWAL_NOT_CANCELLABLE,
        `withdrawal status ${withdrawal.status} not cancellable (only REQUESTED/REVIEWING)`,
      );
    }

    // 反向分录（WITHDRAWAL_RELEASE=8；与占款分录对称：玩家 CNY frozen -debit，
    // 系统 CNY -debit；HOLD=3 分录类型，双资产文档 §4 "合法取消时幂等释放"）。
    const net = BigInt(withdrawal.cashCents);
    const fee = BigInt(withdrawal.feeCents);
    const debit = net + fee;
    const operationKey = `withdrawal_release:${withdrawal.id}`;
    const requestHash = requestHashOf({ withdrawalId: withdrawal.id, userId, debit: debit.toString() });
    const claimed = await this.ledger.claimOperation({
      operationKey,
      operationType: AssetOperationType.WITHDRAWAL_RELEASE,
      requestHash,
      initiatedByUserId: userId,
      extra: {
        withdrawalId: withdrawal.id,
        releaseCnyFen: debit.toString(),
      },
      reason: 'withdrawal cancellation hold release',
      tx,
    });
    if (!claimed.inserted) {
      // 同键异内容 = 同键重放不同内容 → IDEMPOTENCY_KEY_REUSED（adapter 抛错）；
      // 同键同内容重放（前次事务未提交残留）→ 静默重放，不二次释放（§10 红线）。
      // 首版：重放既有行（releaseHold 幂等兜底），标记 released = false。
      const existingHold = await this.ledger.releaseHold(withdrawal.assetHoldId, tx);
      void existingHold;
      return { dto: this.toDto(withdrawal), released: false };
    }
    const operationId = claimed.operation.id;

    // 锁账户（用户 CNY → 系统 CNY；asset_account.id 升序，§4 锁顺序）。
    const userCny = await this.ledger.readAccount(userId, AssetType.CNY_BALANCE, AccountType.PLAYER, tx);
    const systemCny = await this.ledger.readAccount(this.systemIdentity.systemUserId, AssetType.CNY_BALANCE, AccountType.SYSTEM, tx);
    if (userCny === null || systemCny === null) {
      throw new PaymentDomainError(P.WALLET_STORAGE_UNAVAILABLE, 'asset account not provisioned for release');
    }
    const lockIds = [userCny.id, systemCny.id].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    await this.ledger.lockAccountsByIds(lockIds, tx);

    // 释放分录（玩家 CNY frozen -debit；系统 CNY -debit；总额不变，仅冻结解除，
    // 双资产文档 §5.1 "冻结仅反映在 frozenAmount"——释放即解冻）。
    const intents: EntryIntent[] = [
      {
        accountId: userCny.id,
        delta: 0n,
        frozenDelta: -debit,
        entryType: WalletEntryType.HOLD,
        memo: `withdrawal release: -${debit} fen unfrozen (net ${net} + fee ${fee}, cancellation)`,
      },
      {
        accountId: systemCny.id,
        delta: -debit,
        frozenDelta: 0n,
        entryType: WalletEntryType.EXTERNAL,
        memo: `withdrawal release out: -${debit} fen reserved returned for user ${userId}`,
      },
    ];
    await this.ledger.postEntries(operationId, intents, tx);

    // asset_hold 释放（RELEASED=4；幂等——已释放重放静默，双资产文档 §4）。
    await this.ledger.releaseHold(withdrawal.assetHoldId, tx);

    // 状态机推进（adapter `transition` 经 domain 转换表校验；7 CANCELLED +
    // 释放占款标记，双资产文档 §4 "1/2→7 释放占款"）。
    const transitioned = await this.withdrawals.transition({
      withdrawalId: withdrawal.id,
      fromStatus: withdrawal.status,
      toStatus: WithdrawalStatus.CANCELLED,
      failureReason: 'cancelled by user (hold released)',
      tx,
    });

    // 快照回填 + outbox 同事务（§6.3 "所有分录/outbox 同事务"）。
    await this.ledger.setCommitted(
      operationId,
      this.clock.now(),
      {
        withdrawalId: withdrawal.id,
        releasedCnyFen: debit.toString(),
      },
      tx,
    );
    await outbox.append({
      topic: 'payments.withdrawal.cancelled',
      userId,
      assetOperationId: operationId,
      payload: {
        withdrawalId: withdrawal.id,
        releaseCnyFen: debit.toString(),
      },
    });

    return { dto: this.toDto(transitioned.withdrawal), released: true };
  }

  private toDto(row: {
    id: string;
    payoutAccountId: string;
    cashCents: string;
    feeCents: string;
    status: number;
    payoutNotBeforeAt: Date | string;
    createdAt: Date | string;
    policySnapshot: Record<string, unknown> | null;
  }): WithdrawalDto {
    const net = BigInt(row.cashCents);
    const fee = BigInt(row.feeCents);
    const extra = row.policySnapshot ?? {};
    const label = (extra.payoutAccountLabel as string | undefined) ?? (extra.maskedAccount as string | undefined) ?? 'withdrawal';
    return {
      withdrawalId: row.id,
      payoutAccountId: row.payoutAccountId,
      payoutAccountLabel: label,
      maskedAccount: label,
      netCnyFen: net.toString(),
      feeCnyFen: fee.toString(),
      debitCnyFen: (net + fee).toString(),
      status: row.status as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
      payoutNotBeforeAt: toDateIso(row.payoutNotBeforeAt),
      createdAt: toDateIso(row.createdAt),
    };
  }
}
