import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboxModel } from '@gameing/backend/infrastructure/database/models/events';
import type { Logger } from '../logging/logger.js';
import type { OutboxWorkerRepo } from './ports/outbox-worker-repo.js';
import { createOutboxWorker } from './outbox-worker.js';

afterEach(() => vi.useRealTimers());

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as Logger;
}

describe('outbox worker', () => {
  it('continues settling later claimed rows after one settlement repository failure', async () => {
    const rows = ['outbox-1', 'outbox-2'].map(
      (id) => ({ id, attempts: 0, leaseUntil: new Date('2026-11-04T20:00:30.000Z') }) as unknown as OutboxModel,
    );
    const markSent = vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValueOnce(true);
    const repo: OutboxWorkerRepo = {
      reclaimStale: vi.fn(async () => 0),
      claim: vi.fn(async () => rows),
      markSent,
      markFailed: vi.fn(async () => true),
      findByEventKey: vi.fn(async () => null),
    };
    const dispatcher = { deliver: vi.fn(async () => true), isTaskTopic: vi.fn(() => false) };
    const logger = makeLogger();
    const worker = createOutboxWorker({ repo, dispatcher, config: { workerId: 'worker-test', logger } });

    await expect(worker.runOnce()).resolves.toEqual({ claimed: 2, sent: 1, failed: 0 });
    expect(dispatcher.deliver).toHaveBeenCalledTimes(2);
    expect(markSent).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      'outbox 单行处理/结算异常（租约恢复）',
      expect.objectContaining({ outboxId: 'outbox-1', errorCode: 'ROW_PROCESSING_FAILED' }),
    );
  });
});

describe('outbox worker shutdown', () => {
  it('waits for the active batch to settle before stop resolves', async () => {
    vi.useFakeTimers();
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const row = {
      id: 'outbox-1',
      attempts: 0,
      leaseUntil: new Date('2026-11-04T20:00:30.000Z'),
    } as unknown as OutboxModel;
    const repo: OutboxWorkerRepo = {
      reclaimStale: vi.fn(async () => 0),
      claim: vi.fn(async () => [row]),
      markSent: vi.fn(async () => true),
      markFailed: vi.fn(async () => true),
      findByEventKey: vi.fn(async () => null),
    };
    const dispatcher = {
      deliver: vi.fn(async () => dispatchGate.then(() => true)),
      isTaskTopic: vi.fn(() => false),
    };
    const worker = createOutboxWorker({
      repo,
      dispatcher,
      config: { tickMs: 10, workerId: 'worker-test', logger: makeLogger() },
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(dispatcher.deliver).toHaveBeenCalledOnce();

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseDispatch();
    await stopping;
    expect(stopped).toBe(true);
    expect(repo.markSent).toHaveBeenCalledOnce();
  });
});
