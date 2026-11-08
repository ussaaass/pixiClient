import { describe, expect, it, vi } from 'vitest';
import type { OutboxModel } from '@gameing/backend/infrastructure/database/models/events';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { createOutboxDispatcher } from './outbox-dispatcher.js';

function makeRow(topic: string, userId: string | null = 'user-1'): OutboxModel {
  return { id: 'row-1', eventKey: 'event-1', topic, userId, payload: { value: 1 } } as unknown as OutboxModel;
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

describe('outbox dispatcher', () => {
  it('does not acknowledge financial task topics when their handlers are unavailable', async () => {
    const notifyUser = vi.fn();
    const logger = makeLogger();
    const dispatcher = createOutboxDispatcher({ tasks: [], socketNotif: { notifyUser }, logger, workerId: 'test-worker' });

    for (const topic of ['payments.withdrawal.requested', 'coin-market.expiry-scan', 'referral.reward-posted']) {
      expect(dispatcher.isTaskTopic(topic)).toBe(true);
      await expect(dispatcher.deliver(makeRow(topic))).resolves.toBe(false);
    }
    expect(notifyUser).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledWith(
      'outbox 任务 topic 无可用 handler（不得当作 Socket 通知确认）',
      expect.objectContaining({ topic: 'payments.withdrawal.requested' }),
    );
  });

  it('routes a financial task only through its registered handler', async () => {
    const notifyUser = vi.fn();
    const run = vi.fn(async () => true);
    const dispatcher = createOutboxDispatcher({
      tasks: [{ topic: 'referral.reward-posted', run }],
      socketNotif: { notifyUser },
      logger: makeLogger(),
      workerId: 'test-worker',
    });

    await expect(dispatcher.deliver(makeRow('referral.reward-posted'))).resolves.toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it('fails closed for unregistered topic names instead of acknowledging Socket delivery', async () => {
    const logger = makeLogger();
    const notifyUser = vi.fn();
    const dispatcher = createOutboxDispatcher({
      tasks: [],
      socketNotif: { notifyUser },
      logger,
      workerId: 'test-worker',
    });

    expect(dispatcher.isTaskTopic('future.business.task')).toBe(false);
    await expect(dispatcher.deliver(makeRow('future.business.task'))).resolves.toBe(false);
    expect(notifyUser).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'outbox 未登记 topic（fail closed）',
      expect.objectContaining({ topic: 'future.business.task', errorCode: 'UNKNOWN_TOPIC' }),
    );
  });

  it('does not log task-handler exception messages', async () => {
    const warn = vi.fn();
    const logger = { ...makeLogger(), warn } as Logger;
    const dispatcher = createOutboxDispatcher({
      tasks: [
        {
          topic: 'referral.reward-posted',
          run: vi.fn(async () => {
            throw new Error('sensitive provider detail');
          }),
        },
      ],
      socketNotif: { notifyUser: vi.fn() },
      logger,
      workerId: 'test-worker',
    });

    await expect(dispatcher.deliver(makeRow('referral.reward-posted'))).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'outbox 任务处理异常（经退避重试）',
      expect.objectContaining({ topic: 'referral.reward-posted', errorCode: 'TASK_HANDLER_FAILED' }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive provider detail');
  });

  it('returns failure for Socket transport errors so the worker can retry', async () => {
    const notifyUser = vi.fn(async () => {
      throw new Error('socket unavailable');
    });
    const logger = makeLogger();
    const dispatcher = createOutboxDispatcher({
      tasks: [],
      socketNotif: { notifyUser },
      logger,
      workerId: 'test-worker',
    });

    await expect(dispatcher.deliver(makeRow('wallet.transfer'))).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'outbox Socket 投递失败（经退避重试）',
      expect.objectContaining({ topic: 'wallet.transfer', outboxId: 'row-1', errorCode: 'SOCKET_DELIVERY_FAILED' }),
    );
  });

  it('keeps mapped user notifications on the Socket port', async () => {
    const notifyUser = vi.fn();
    const dispatcher = createOutboxDispatcher({
      tasks: [],
      socketNotif: { notifyUser },
      logger: makeLogger(),
      workerId: 'test-worker',
    });

    await expect(dispatcher.deliver(makeRow('wallet.transfer'))).resolves.toBe(true);
    expect(notifyUser).toHaveBeenCalledWith('user-1', 'wallet.transfer', { value: 1, eventKey: 'event-1' });
  });
});
