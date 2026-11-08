import { describe, expect, it, vi } from 'vitest';
import { OutboxStatus } from '@gameing/backend/infrastructure/database/models/events';
import { outboxBackoffMs, OUTBOX_BACKOFF_CAP_MS, SequelizeOutboxWorkerRepo } from './sequelize-outbox-worker.js';

describe('outbox retry backoff', () => {
  it('doubles by attempt and caps at two minutes', () => {
    expect(outboxBackoffMs(-10)).toBe(1000);
    expect(outboxBackoffMs(0)).toBe(1000);
    expect(outboxBackoffMs(6)).toBe(64_000);
    expect(outboxBackoffMs(7)).toBe(OUTBOX_BACKOFF_CAP_MS);
    expect(outboxBackoffMs(99)).toBe(OUTBOX_BACKOFF_CAP_MS);
  });
});

describe('SequelizeOutboxWorkerRepo lease fencing', () => {
  it('fences successful settlement by worker and exact lease token', async () => {
    const update = vi.fn(async () => [1]);
    const repo = new SequelizeOutboxWorkerRepo({ update } as never);
    const leaseUntil = new Date('2026-11-04T20:00:30.000Z');

    await expect(
      repo.markSent({
        outboxId: 'row-1',
        lockedBy: 'worker-a',
        leaseUntil,
        attempts: 0,
        leaseMs: 30_000,
        now: new Date('2026-11-04T20:00:01.000Z'),
      }),
    ).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: OutboxStatus.SENT }),
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'row-1',
          status: OutboxStatus.PROCESSING,
          lockedBy: 'worker-a',
          leaseUntil,
        }),
      }),
    );
  });

  it('releases the lease immediately when scheduling a retry and fences old workers', async () => {
    const update = vi.fn(async () => [1]);
    const repo = new SequelizeOutboxWorkerRepo({ update } as never);
    const leaseUntil = new Date('2026-11-04T20:00:30.000Z');
    const now = new Date('2026-11-04T20:00:01.000Z');

    await expect(
      repo.markFailed({
        outboxId: 'row-1',
        lockedBy: 'worker-a',
        leaseUntil,
        attempts: 0,
        leaseMs: 30_000,
        now,
        deadAfter: 12,
        lastErrorCode: 'DELIVERY_FAILED',
      }),
    ).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: OutboxStatus.PENDING,
        availableAt: new Date(now.getTime() + 1000),
        lockedBy: null,
        leaseUntil: null,
      }),
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'row-1',
          status: OutboxStatus.PROCESSING,
          lockedBy: 'worker-a',
          leaseUntil,
        }),
      }),
    );
  });

  it('reports a stale settlement as not applied when fencing matches no row', async () => {
    const update = vi.fn(async () => [0]);
    const repo = new SequelizeOutboxWorkerRepo({ update } as never);
    const settlement = {
      outboxId: 'row-1',
      lockedBy: 'old-worker',
      leaseUntil: new Date('2026-11-04T20:00:30.000Z'),
      attempts: 0,
      leaseMs: 30_000,
      now: new Date('2026-11-04T20:01:00.000Z'),
    };

    await expect(repo.markSent(settlement)).resolves.toBe(false);
    await expect(repo.markFailed({ ...settlement, deadAfter: 12, lastErrorCode: 'DELIVERY_FAILED' })).resolves.toBe(false);
  });
});
