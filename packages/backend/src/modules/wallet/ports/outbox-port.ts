/**
 * outbox 端口（跨存储事件/任务写入，复用 identity 模块的 OutboxPort 契约）。
 *
 * 领域所有者：wallet 模块（SDD §6.3 "所有分录/outbox 同事务"）。
 * 对应 SDD 章节：后端实施 SDD §6.3 事件投递管线——资金用例（转账/兑换/赠币）的
 * 账本分录与 outbox 行在同一数据库事务内写入，worker 落地后按 user_id 投递
 * `/platform`；行 append-only（outbox 例外：status 有 OutboxStatus 1~4 状态机，
 * updated_at 随投递更新，见 models/events.ts）。
 *
 * 说明：接口契约与 `modules/identity/ports/outbox-port.ts` 一致（跨模块复用，
 * 不重复定义两套），实现（SequelizeOutboxPort）在 wallet `assembly.ts` 内装配，
 * 用例经 `module.outboxFor(tx)` 取得事务绑定的 append。
 */

/** outbox 追加请求（SDD §6.3：topic/user_id/payload/available_at 最小集）。 */
export interface OutboxAppendInput {
  /** 事件/任务主题（消费者路由键）。 */
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
  /** 关联的资金操作（outbox.asset_operation_id，FK RESTRICT）。 */
  assetOperationId?: string | null;
}

export interface OutboxPort {
  /**
   * 追加 outbox 行（须与业务事实同事务提交；实现经构造注入的 Tx 绑定事务，
   * 随事务提交/回滚）。
   */
  append(input: OutboxAppendInput): Promise<void>;
}
