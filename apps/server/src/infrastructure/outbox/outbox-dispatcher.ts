/**
 * outbox 投递分发（§6.3 "按 user_id 投递 /platform；room 事件投递
 * /room/:roomId；Admin 队列事件投递 /admin"）。
 *
 * 领域所有者：outbox worker（apps/server 传输装配层，SDD §6.3 + §1
 * "worker（outbox 消费、恢复任务）装配在 apps/server/src/bootstrap/"）。
 *
 * 设计（首版进程内）：
 * - **Socket 提示类** topic：经 `SocketNotifPort` 按 user_id 推 `/platform`
 *   连接（先持久化后推送：客户端收到提示后按域 HTTP 补权威快照，
 *   断线补拉走 HTTP——Socket 只发提示/增量，不承载权威数据）。
 * - **任务类** topic（worker 闭环）：经 `OutboxTaskHandler` 注册表分发
 *   到各域用例（REFERRAL_REWARD 入账、payout 推进、支付订单过期等，
 *   §6.3 "恢复任务"）；仅显式登记的 Socket topic 可推送，其余未知 topic
 *   fail closed，避免新业务事件被误标 SENT。
 * - 消费者幂等：事件消费侧经 event_key 唯一键天然幂等（重投同一行
 *   经 SENT 状态拦截，不再重复处理）。
 */

import type { OutboxModel } from '@gameing/backend/infrastructure/database/models/events';
import type { Logger } from '../../infrastructure/logging/logger.js';

/** Socket 通知端口（首版实现经 SocketAuthHandles 的 user→connections Map）。 */
export interface SocketNotifPort {
  /** 按 user_id 向 /platform 命名空间全部连接推送事件（连接缺失 = 0 条，
   * 不算失败——断线补拉走 HTTP，§6.3 "先持久化后推送"）。payload 含 outbox eventKey，
   * 供客户端对至少一次投递去重；这不是客户端 ACK。 */
  notifyUser(userId: string, event: string, payload: Record<string, unknown>): Promise<void> | void;
}

/** 任务型 topic 处理器（worker 闭环的领域任务；幂等由任务自身唯一键兜底）。 */
export interface OutboxTaskHandler {
  /** 处理的 topic（注册键）。 */
  readonly topic: string;
  /**
   * 执行任务（同事务约束见任务自身用例；实现须保证幂等——重投经
   * SENT 拦截 + 任务唯一键双兜底）。返回 true = 成功（置 SENT），
   * 抛错 = 失败（经退避重试，达 deadAfter 置 DEAD）。
   */
  run(row: OutboxModel): Promise<boolean>;
}

export interface TopicDispatchTable {
  /** 任务处理器注册表（topic → handler；通知 topic 走 Socket 提示）。 */
  readonly tasks: ReadonlyMap<string, OutboxTaskHandler>;
  /** 任务语义 topic 分类（含尚未装配 handler 的 fail-closed topic）。 */
  isTaskTopic(topic: string): boolean;
}

/** 缺省 Socket 提示事件名映射（未命中映射的 topic 直接以 topic 名推）。 */
const TASK_TOPICS = new Set(['payments.withdrawal.requested', 'coin-market.expiry-scan', 'referral.reward-posted']);
const SOCKET_EVENT_MAP: Readonly<Record<string, string>> = {
  'wallet.transfer': 'wallet.transfer',
  'wallet.exchange': 'wallet.exchange',
  'wallet.gift-grant': 'wallet.gift-grant',
  'social.post': 'social.post',
  'social.post_reply': 'social.post.reply',
  'social.message': 'social.message',
  'support.message': 'support.message',
  'payments.order.paid': 'payments.order.paid',
  'payments.withdrawal.requested': 'payments.withdrawal.requested',
  'payments.withdrawal.cancelled': 'payments.withdrawal.cancelled',
  'game.round.settled': 'game.round.settled',
  'identity.password.changed': 'identity.password.changed',
  'identity.totp.enabled': 'identity.totp.enabled',
  'identity.device.revoked': 'identity.device.revoked',
  'identity.session.revoked': 'identity.session.revoked',
  'identity.recovery.issued': 'identity.recovery.issued',
};

/**
 * 创建投递分发器（构造注入任务注册表，不用全局，SDD §4 同款纪律）。
 * 用法（apps/server bootstrap）：
 * ```ts
 * const dispatcher = createOutboxDispatcher({ tasks, socketNotif, logger });
 * ```
 */
export function createOutboxDispatcher(options: {
  tasks: readonly OutboxTaskHandler[];
  socketNotif: SocketNotifPort;
  logger: Logger;
  /** worker 实例标识（写入日志 + outbox.locked_by）。 */
  workerId: string;
}) {
  const taskMap = new Map<string, OutboxTaskHandler>();
  for (const handler of options.tasks) {
    taskMap.set(handler.topic, handler);
  }
  const { socketNotif, logger, workerId } = options;

  /**
   * 消费一行 outbox：任务 topic 经注册表分发；其余 Socket 提示类经
   * user_id 推送 /platform（公开事件 user_id=null 广播登记决策点：
   * 首版跳过广播，仅 per-user 私有事件推送）。
   * @returns true = 成功（markSent）；false = 失败（markFailed，经退避）。
   */
  async function deliver(row: OutboxModel): Promise<boolean> {
    const topic = row.topic;
    const task = taskMap.get(topic);
    if (TASK_TOPICS.has(topic) && task === undefined) {
      logger.error('outbox 任务 topic 无可用 handler（不得当作 Socket 通知确认）', {
        workerId,
        outboxId: row.id,
        topic,
      });
      return false;
    }
    if (task !== undefined) {
      try {
        const ok = await task.run(row);
        if (!ok) {
          logger.warn('outbox 任务处理失败（handler 返回 false）', {
            workerId,
            outboxId: row.id,
            topic,
          });
          return false;
        }
        return true;
      } catch {
        logger.warn('outbox 任务处理异常（经退避重试）', {
          workerId,
          outboxId: row.id,
          topic,
          errorCode: 'TASK_HANDLER_FAILED',
        });
        return false;
      }
    }

    // Socket 提示必须显式登记。未知 topic 可能是新的业务任务，不得宽松
    // 路由后标记 SENT；保持 fail closed，待对应 handler/映射上线再消费。
    if (!Object.hasOwn(SOCKET_EVENT_MAP, topic)) {
      logger.error('outbox 未登记 topic（fail closed）', {
        workerId,
        outboxId: row.id,
        topic,
        errorCode: 'UNKNOWN_TOPIC',
      });
      return false;
    }

    // Socket 提示类：user_id 为 null 的公开事件首版跳过推送（登记决策点：
    // 平台公告广播经 /platform 全连接 emit，随多实例 pub/sub 扩展）。
    if (row.userId === null) {
      logger.debug('outbox 公开事件跳过 Socket 广播（首版登记）', { workerId, outboxId: row.id, topic });
      return true;
    }
    const event = SOCKET_EVENT_MAP[topic] ?? topic;
    try {
      await socketNotif.notifyUser(row.userId, event, { ...row.payload, eventKey: row.eventKey });
      return true;
    } catch {
      logger.warn('outbox Socket 投递失败（经退避重试）', {
        workerId,
        outboxId: row.id,
        topic,
        errorCode: 'SOCKET_DELIVERY_FAILED',
      });
      return false;
    }
  }

  return { deliver, isTaskTopic: (topic: string): boolean => TASK_TOPICS.has(topic) || taskMap.has(topic) };
}

export type OutboxDispatcher = ReturnType<typeof createOutboxDispatcher>;
