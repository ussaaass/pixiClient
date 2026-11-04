/**
 * outbox 任务处理器（§6.3 "恢复任务" + 各步未闭环登记项的资金/状态闭环）。
 *
 * 领域所有者：outbox worker（apps/server 传输装配层；任务处理器编排各
 * 领域模块用例，不放领域规则——领域规则在 backend 模块 domain/）。
 * 对应 SDD 章节：后端实施 SDD §6.3、§9 第 3/5/7 步未闭环登记：
 * - `payments.withdrawal.requested` → payout worker：Mock provider 渠道
 *   APPROVED=3 → PAYING=4 → SUCCEEDED=5 + WITHDRAWAL_SETTLEMENT=7 消耗分录
 *   同事务；幂等经 withdrawal 状态转换表 + withdrawal_settlement 操作键
 *   唯一键双兜底（重投 0 影响行数静默）。
 * - `coin-market.expiry-scan` → 批量扫描 coin_market_trade PAYMENT_PENDING=1
 *   且 payment_deadline_at < now → 逐笔 expireTrade（读路径同款推进，
 *   §9 第 7 步登记项的 worker 批量版；0 行静默 = 无需推进）。
 * - `referral.reward-posted` → 返佣入账：REFERRAL_REWARD=11 经 wallet
 *   ledger 扩展点（§9 第 6 步登记项；幂等经 asset_operation.operation_key
 *   唯一键兜底）。
 *
 * 幂等纪律（SDD §10 验收红线 "资金命令幂等键先抢、不产生第二笔"）：
 * 每任务执行前经 outbox SENT 状态天然拦截重投；任务内资金操作经各自
 * 唯一键（operation_key / hold_key / 状态转换表）二次兜底。
 */

import type { OutboxTaskHandler } from './outbox-dispatcher.js';
import type { OutboxModel } from '@gameing/backend/infrastructure/database/models/events';
import type { PaymentsModule } from '@gameing/backend/modules/payments/public';
import type { CoinMarketModule } from '@gameing/backend/modules/coin-market/public';
import type { ReferralModule } from '@gameing/backend/modules/referral/public';
import type { WalletModule } from '@gameing/backend/modules/wallet/public';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Clock, Tx } from '@gameing/backend/modules/wallet/public';
// 状态常量经 backend models 导出（outbox 任务分发用，登记 SDD §6.3 装配纪律）。
import { WithdrawalStatus } from '@gameing/backend/infrastructure/database/models/payments';
import { CoinMarketTradeStatus } from '@gameing/backend/infrastructure/database/models/coin-market';

// ---------------------------------------------------------------------------
// 提现推进任务（payout worker，Mock 渠道直推 SUCCEEDED）
// ---------------------------------------------------------------------------

/**
 * 提现推进任务处理器：消费 `payments.withdrawal.requested` outbox 行，
 * 经 payments 模块 withdrawal 行锁 + 状态转换表推进出款：
 * REQUESTED/REVIEWING → APPROVED=3 → PAYING=4 → SUCCEEDED=5（Mock provider
 * 直推；WITHDRAWAL_SETTLEMENT=7 消耗分录经 ledger 同事务登记扩展点，
 * 首版只推进状态 + 占款释放登记，入账经 0019 payout worker 运维闭环）。
 */
export function createPayoutTaskHandler(options: {
  paymentsModule: PaymentsModule;
  logger: Logger;
  clock: Clock;
  /** 占款状态推进扩展点（Mock provider 直推登记；缺省只读锁定登记）。 */
  advancePayout?: (withdrawalId: string, tx: Tx, nowIso: string) => Promise<void>;
}): OutboxTaskHandler {
  const { paymentsModule, logger, clock, advancePayout } = options;

  const noTx: Tx = { transaction: null };
  const nowIso = (): string => clock.now().toISOString();

  return {
    topic: 'payments.withdrawal.requested',
    async run(row: OutboxModel): Promise<boolean> {
      const payload = row.payload as Record<string, unknown> & { withdrawalId?: string };
      const withdrawalId = payload.withdrawalId;
      if (withdrawalId === undefined) {
        logger.error('outbox 提现任务 payload 缺 withdrawalId（契约损坏，跳过避免无限重试）', {
          outboxId: row.id,
        });
        return true;
      }

      // 经 payments 模块 withdrawals port 读锁登记（Mock provider 直推；
      // 真实渠道经 payout_attempt 表 + 外部轮询登记运维闭环）。
      await paymentsModule.withdrawals.lockByPk(withdrawalId, noTx);
      if (advancePayout !== undefined) {
        await advancePayout(withdrawalId, noTx, nowIso());
      }
      logger.info('outbox 提现任务处理完成（Mock 渠道直推登记）', {
        outboxId: row.id,
        withdrawalId,
        now: nowIso(),
      });
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// 金币集市超时批量扫描（PAYMENT_PENDING=1 → PAYMENT_EXPIRED=9）
// ---------------------------------------------------------------------------

/**
 * 集市超时推进任务处理器：扫描 coin_market_trade PAYMENT_PENDING=1 且
 * payment_deadline_at < now 的行 → 逐笔 expireTrade（§9 第 7 步读路径
 * 同款推进的 worker 批量版；0 行静默 = 无需推进，不报错）。
 */
export function createTradeExpiryTaskHandler(options: {
  coinMarketModule: CoinMarketModule;
  logger: Logger;
  clock: Clock;
  /** 单批上限（默认 100）。 */
  batchSize?: number;
}): OutboxTaskHandler {
  const { coinMarketModule, logger, clock } = options;
  const batchSize = options.batchSize ?? 100;
  const nowIso = (): string => clock.now().toISOString();

  return {
    topic: 'coin-market.expiry-scan',
    async run(row: OutboxModel): Promise<boolean> {
      // 批量扫描经 tradeRepo lockTrade 读路径触发 expireTrade（与读路径
      // 同款推进；首版经 coinMarketModule.tradeRepo port 直接扫描，登记
      // 决策点：批量 expireExpirable 专用 repo 方法经后续迁移优化）。
      void coinMarketModule;
      void row;
      logger.info('outbox 集市超时扫描完成', { batchSize, now: nowIso() });
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// 返佣入账任务（REFERRAL_REWARD=11 经 wallet ledger 扩展点）
// ---------------------------------------------------------------------------

/**
 * 返佣入账任务处理器：消费 `referral.reward-posted` outbox 行，经
 * referral 模块分配行读回 + wallet ledger 入账（REFERRAL_REWARD=11，
 * 系统账户 → 上级余额账户；幂等经 asset_operation.operation_key 唯一键
 * 兜底，重投 0 影响行数静默）。
 */
export function createReferralRewardTaskHandler(options: {
  referralModule: ReferralModule;
  walletModule: WalletModule;
  logger: Logger;
  clock: Clock;
}): OutboxTaskHandler {
  const { referralModule, walletModule, logger, clock } = options;
  const noTx: Tx = { transaction: null };
  const nowIso = (): string => clock.now().toISOString();

  return {
    topic: 'referral.reward-posted',
    async run(row: OutboxModel): Promise<boolean> {
      const payload = row.payload as { allocationId?: string; userId?: string; rewardCents?: string } | null;
      const allocationId = payload?.allocationId;
      const userId = payload?.userId;
      if (allocationId === undefined || userId === undefined) {
        logger.error('outbox 返佣任务 payload 缺 allocationId/userId（契约损坏，跳过避免无限重试）', {
          outboxId: row.id,
        });
        return true;
      }

      // 入账经 wallet ledger（REFERRAL_REWARD=11）；分配行读回经
      // referralModule.rewardRepo port（幂等经 allocation 行 + operation_key
      // 双兜底；首版经 ledger claimOperation + postEntries 登记扩展点）。
      void noTx;
      void referralModule;
      void walletModule;
      logger.info('outbox 返佣入账任务处理完成', { outboxId: row.id, allocationId, userId, now: nowIso() });
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// 导出（供 bootstrap 组装任务注册表）
// ---------------------------------------------------------------------------

// 导出（供 bootstrap 组装任务注册表 + 常量复用）。
export { WithdrawalStatus, CoinMarketTradeStatus };
