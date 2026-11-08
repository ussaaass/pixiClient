/**
 * outbox worker 消费循环（§6.3 "首版进程内 + 租约"）。
 *
 * 领域所有者：outbox worker（apps/server 传输装配层，SDD §6.3 + §1
 * "worker（outbox 消费、恢复任务）"）。
 *
 * 设计：
 * - 进程内 ticker：`setInterval` 周期领取 + 消费（首版无独立 worker 入口，
 *   随 server 进程启动；多实例 SKIP LOCKED 扩展登记运维项）；
 * - 租约互斥：领取经 DB 行锁 + lease_until（崩溃 worker 的租约过期后
 *   经 `reclaimStale` 回收，其他 worker 可重新领取）；
 * - 单实例首版：ticker 1s，租约 30s，单批 50，失败指数退避（1s~2min
 *   封顶），deadAfter=12 次置 DEAD（人工介入）；
 * - 幂等纪律：重投经 SENT 状态拦截 + 任务唯一键兜底（SDD §10 红线）。
 */

import type { OutboxModel } from '@gameing/backend/infrastructure/database/models/events';
import type { Logger } from '../logging/logger.js';
import type { OutboxDispatcher } from './outbox-dispatcher.js';
import type { OutboxWorkerRepo } from './ports/outbox-worker-repo.js';

export interface OutboxWorkerConfig {
  /** ticker 周期毫秒（默认 1000）。 */
  tickMs?: number;
  /** 租约时长毫秒（默认 30000）。 */
  leaseMs?: number;
  /** 单批领取上限（默认 50）。 */
  batchSize?: number;
  /** 失败重试达此次数置 DEAD（默认 12）。 */
  deadAfter?: number;
  /** 过期租约扫描周期（每 N 个 tick 执行一次，默认 30）。 */
  staleScanEvery?: number;
  /** worker 标识（写 outbox.locked_by）。 */
  workerId: string;
  logger: Logger;
}

export interface OutboxWorkerHandles {
  start(): void;
  stop(): Promise<void>;
  /** 手动触发一轮领取 + 消费（测试 / 诊断用）。 */
  runOnce(): Promise<{ claimed: number; sent: number; failed: number }>;
}

/**
 * 创建 outbox worker（构造注入 repo + dispatcher，不用全局，SDD §4 同款纪律）。
 * 用法（apps/server bootstrap）：
 * ```ts
 * const worker = createOutboxWorker({ repo, dispatcher, config });
 * worker.start();
 * ```
 */
export function createOutboxWorker(options: {
  repo: OutboxWorkerRepo;
  dispatcher: OutboxDispatcher;
  config: OutboxWorkerConfig;
}): OutboxWorkerHandles {
  const { repo, dispatcher, config } = options;
  const tickMs = config.tickMs ?? 1000;
  const leaseMs = config.leaseMs ?? 30_000;
  const batchSize = config.batchSize ?? 50;
  const deadAfter = config.deadAfter ?? 12;
  const staleScanEvery = config.staleScanEvery ?? 30;
  const { workerId, logger } = config;

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let inFlight = false;
  let activeRun: Promise<unknown> | null = null;
  let tickCount = 0;

  async function runOnce(): Promise<{ claimed: number; sent: number; failed: number }> {
    const now = new Date();
    if (tickCount % staleScanEvery === 0) {
      const reclaimed = await repo.reclaimStale({ now });
      if (reclaimed > 0) {
        logger.warn('outbox 过期租约回收', { workerId, reclaimed });
      }
    }
    const rows = await repo.claim({ lockedBy: workerId, leaseMs, batchSize, now });
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const leaseUntil = row.leaseUntil instanceof Date ? row.leaseUntil : new Date(row.leaseUntil as string);
        const ok = await dispatcher.deliver(row);
        if (ok) {
          const settled = await repo.markSent({
            outboxId: row.id,
            lockedBy: workerId,
            now: new Date(),
            leaseMs,
            attempts: row.attempts,
            leaseUntil,
          });
          if (settled) sent += 1;
          else logger.warn('outbox 成功结算被租约 fencing 拒绝', { workerId, outboxId: row.id });
        } else {
          const settled = await repo.markFailed({
            outboxId: row.id,
            lockedBy: workerId,
            now: new Date(),
            leaseMs,
            attempts: row.attempts,
            leaseUntil,
            deadAfter,
            lastErrorCode: 'DELIVERY_FAILED',
          });
          if (settled) failed += 1;
          else logger.warn('outbox 失败结算被租约 fencing 拒绝', { workerId, outboxId: row.id });
        }
      } catch {
        // Per-row failure must not strand later claimed rows in this batch.
        // If settlement itself failed, leave this row PROCESSING for lease reclaim.
        logger.error('outbox 单行处理/结算异常（租约恢复）', {
          workerId,
          outboxId: row.id,
          errorCode: 'ROW_PROCESSING_FAILED',
        });
      }
    }
    tickCount += 1;
    if (rows.length > 0) {
      logger.debug('outbox 消费轮次完成', { workerId, claimed: rows.length, sent, failed });
    }
    return { claimed: rows.length, sent, failed };
  }

  return {
    start() {
      if (timer !== null || stopped) return;
      logger.info('outbox worker 启动（进程内 ticker + 租约）', { workerId, tickMs, leaseMs, batchSize, deadAfter });
      timer = setInterval(() => {
        if (inFlight) return; // 上轮未完成则跳过（防堆叠）。
        inFlight = true;
        const running = runOnce()
          .catch((error) => {
            logger.error('outbox 消费轮次异常', {
              workerId,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            inFlight = false;
            activeRun = null;
          });
        activeRun = running;
      }, tickMs);
      // 不阻止进程退出（server 正常关闭时 shutdown 钩子调 stop）。
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (activeRun !== null) await activeRun;
      logger.info('outbox worker 停止');
    },
    runOnce,
  };
}

export type { OutboxModel };
