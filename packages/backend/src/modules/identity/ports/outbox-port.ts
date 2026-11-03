/**
 * outbox 端口（跨存储事件/任务写入，SDD §6.3 事件投递管线）。
 *
 * 领域所有者：identity 模块（登出/安全事件的持久化回执与幂等重试依赖 outbox）。
 * 对应 SDD 章节：后端实施 SDD §6.3 —— "领域事务 → 同事务写 outbox(topic, user_id,
 * payload, available_at) → outbox worker 投递"；JWT 设计 §3 "以 SQL outbox 处理进程
 * 中断后的幂等重试"。
 *
 * 首版约定（任务登记）：worker 未建（SDD §8 后续运维项），本端口在首版用例内同事务
 * 写 outbox 行即可；worker 落地后由 apps/server 消费。行 append-only（outbox 表
 * 例外：status 有 OutboxStatus 1~4 状态机，updated_at 随投递更新，见 models/events.ts）。
 */

/** outbox 追加请求（SDD §6.3：topic/user_id/payload/available_at 最小集）。 */
export interface OutboxAppendInput {
  /** 事件/任务主题（消费者路由键，§6.3 "按 user_id 投递 /platform"）。 */
  topic: string;
  /** 玩家私有通知目标 user.id（十进制字符串 wire；公开事件可省略）。 */
  userId?: string | null;
  /** 版本化最小负载（不含私牌和密钥；schema 由 topic 约定）。 */
  payload: Record<string, unknown>;
  /** 允许投递时间（UTC）；缺省 = 立即。 */
  availableAt?: Date | string;
  /** 事件 schema 版本（缺省 1，CHECK >=1）。 */
  payloadVersion?: number;
  /** 消费者幂等键（U(event_key)）；缺省由实现生成。 */
  eventKey?: string;
}

export interface OutboxPort {
  /**
   * 追加 outbox 行（须与业务事实同事务提交；首版用例内直接调本方法，
   * 事务由用例的 UnitOfWork 管理，outbox 行随事务回滚）。
   */
  append(input: OutboxAppendInput): Promise<void>;
}
