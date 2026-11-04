/**
 * outbox worker 租约仓储（Sequelize 实现；§6.3 首版进程内 + 租约）。
 *
 * 领域所有者：outbox worker（apps/server 传输装配层，SDD §6.3）。
 * 对应 SDD 章节：后端实施 SDD A.10 outbox 实体规则（OutboxStatus
 * PENDING=1/PROCESSING=2/SENT=3/DEAD=4；U(event_key)；I(status,
 * available_at,id) + I(lease_until,id)）。
 *
 * 约定（与 backend 模块适配器同款纪律）：
 * - `lock: 'FOR UPDATE'` 字符串字面量（InnoDB 行锁）；
 * - options 对象 `as never` 整体桥接（Sequelize 6 严格模式 +
 *   exactOptionalPropertyTypes）；
 * - UPDATE 影响行数 0 = 竞态输家/状态已变，静默返回（不抛错）；
 * - 原子租约领取经候选 FOR UPDATE + 条件 UPDATE（WHERE status=PENDING
 *   AND id=行 id，租约空闲判定经 lease_until < now；单实例首版进程内
 *   ticker，多实例经 DB 租约不重复领，SKIP LOCKED 优化登记决策点）。
 */

import { Op } from 'sequelize';
import type { OutboxModel } from '@gameing/backend/infrastructure/database/models/events';
import { OutboxStatus } from '@gameing/backend/infrastructure/database/models/events';
import type { OutboxClaimInput, OutboxSettleInput, OutboxWorkerRepo } from '../ports/outbox-worker-repo.js';

/** 指数退避上限（毫秒）：1s, 2s, 4s, ..., 封顶 2min。 */
export const OUTBOX_BACKOFF_CAP_MS = 120_000;

/** 退避毫秒（attempts 为**当前**失败次数，从 0 起；0 失败 → 1s 起步）。 */
export function outboxBackoffMs(attempts: number): number {
  const exp = Math.max(0, attempts);
  const ms = 1000 * 2 ** Math.min(exp, 6);
  return Math.min(ms, OUTBOX_BACKOFF_CAP_MS);
}

export class SequelizeOutboxWorkerRepo implements OutboxWorkerRepo {
  constructor(private readonly model: typeof OutboxModel) {}

  async claim(input: OutboxClaimInput): Promise<OutboxModel[]> {
    // 候选行（status=PENDING + 可投递；I(status, available_at, id) 支撑）。
    const candidates = await this.model.findAll({
      where: {
        status: OutboxStatus.PENDING as never,
        availableAt: { [Op.lte as unknown as string]: input.now } as never,
      } as never,
      order: [['id', 'ASC']],
      limit: input.batchSize,
      lock: 'FOR UPDATE' as never,
    } as never);

    const nowIso = input.now.toISOString();
    const leased: OutboxModel[] = [];
    for (const row of candidates) {
      // 租约空闲判定：locked_by 非空且租约未过期 → 其他 worker 持有，跳过
      // （单实例首版无并发；多实例经 DB 租约互斥，登记 SKIP LOCKED 优化）。
      if (row.lockedBy !== null && row.leaseUntil !== null && String(row.leaseUntil) > nowIso) {
        continue;
      }
      const [affected] = await this.model.update(
        {
          status: OutboxStatus.PROCESSING as never,
          lockedBy: input.lockedBy as never,
          leaseUntil: new Date(input.now.getTime() + input.leaseMs) as never,
        } as never,
        { where: { id: row.id as never, status: OutboxStatus.PENDING as never } as never },
      );
      if (affected === 0) continue;
      row.status = OutboxStatus.PROCESSING;
      row.lockedBy = input.lockedBy;
      row.leaseUntil = new Date(input.now.getTime() + input.leaseMs);
      leased.push(row);
    }
    return leased;
  }

  async markSent(input: OutboxSettleInput): Promise<void> {
    await this.model.update(
      {
        status: OutboxStatus.SENT as never,
        sentAt: input.now as never,
        attempts: input.attempts as never,
        lockedBy: null,
        leaseUntil: null,
      } as never,
      {
        where: { id: input.outboxId as never, status: OutboxStatus.PROCESSING as never } as never,
      } as never,
    );
  }

  async markFailed(input: OutboxSettleInput & { deadAfter: number; lastErrorCode: string }): Promise<void> {
    const nextAttempts = input.attempts + 1;
    const dead = nextAttempts >= input.deadAfter;
    await this.model.update(
      {
        status: (dead ? OutboxStatus.DEAD : OutboxStatus.PENDING) as never,
        attempts: nextAttempts as never,
        lastErrorCode: input.lastErrorCode as never,
        availableAt: dead ? null : (new Date(input.now.getTime() + outboxBackoffMs(input.attempts)) as never),
        lockedBy: dead ? null : (input.lockedBy as never),
        leaseUntil: dead ? null : (new Date(input.now.getTime() + input.leaseMs) as never),
      } as never,
      {
        where: { id: input.outboxId as never, status: OutboxStatus.PROCESSING as never } as never,
      } as never,
    );
  }

  async reclaimStale(input: { now: Date }): Promise<number> {
    const [affected] = await this.model.update(
      {
        status: OutboxStatus.PENDING as never,
        lockedBy: null,
        leaseUntil: null,
      } as never,
      {
        where: {
          status: OutboxStatus.PROCESSING as never,
          leaseUntil: { [Op.lt as unknown as string]: input.now } as never,
        } as never,
      } as never,
    );
    return affected;
  }

  async findByEventKey(eventKey: string): Promise<OutboxModel | null> {
    return this.model.findOne({ where: { eventKey } as never } as never);
  }
}
