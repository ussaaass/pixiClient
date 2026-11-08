/**
 * outbox 仓储端口（§6.3 worker 消费循环 + 恢复扫描）。
 *
 * 领域所有者：outbox worker（apps/server bootstrap；SDD §6.3 "outbox worker
 * （apps/server worker 入口或进程内 ticker，首版进程内 + 租约）"）。
 * 对应 SDD 章节：后端实施 SDD §6.3 事件投递管线、A.10 outbox 实体规则
 * （OutboxStatus PENDING=1/PROCESSING=2/SENT=3/DEAD=4；I(status,
 * available_at,id) + I(lease_until,id) 索引；U(event_key) 消费者幂等）；
 * 数据库设计 SDD outbox 实体规则（先持久化后推送）。
 *
 * 与 `modules/identity/ports/outbox-port.ts`（写入侧 append）分工：
 * 本端口是**消费侧**——租约领取（claim）、成功（markSent）、失败重试
 * （markFailed）与过期恢复（stale 扫描），实现经 `adapters/` 落库，
 * 不进入领域模块（worker 是传输装配层职责，SDD §1 "worker 装配在
 * apps/server/src/bootstrap/"）。
 */

import type { OutboxModel } from '@gameing/backend/infrastructure/database/models/events';

/** 单次领取/恢复参数。 */
export interface OutboxClaimInput {
  /** 领取进程标识（写 locked_by）。 */
  lockedBy: string;
  /** 租约时长毫秒（写 lease_until = now + leaseMs）。 */
  leaseMs: number;
  /** 单批上限。 */
  batchSize: number;
  /** 当前时刻（时钟注入）。 */
  now: Date;
}

/** 消费结果落库参数（attempts 为**当前**失败次数；attempts=0 表示首次处理）。 */
export interface OutboxSettleInput {
  outboxId: string;
  lockedBy: string;
  now: Date;
  /** 租约时长毫秒（markFailed 回 PENDING 时写新租约窗口用）。 */
  leaseMs: number;
  /** 当前失败次数（claim 行读到的 attempts，从 0 起）。 */
  attempts: number;
  /** 领取时写入的 lease_until；作为 fencing token 防过期旧 worker 结算新租约。 */
  leaseUntil: Date;
}

export interface OutboxWorkerRepo {
  /**
   * 租约领取一批 PENDING 行（原子：UPDATE ... SET status=PROCESSING,
   * locked_by, lease_until WHERE status=PENDING AND available_at<=now
   * ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED 语义；并发 worker 不重复
   * 领同一行，I(lease_until,id) 支持过期扫描）。
   * 返回领取到的行（已置 PROCESSING）；本 worker 持锁期间安全处理。
   */
  claim(input: OutboxClaimInput): Promise<OutboxModel[]>;

  /** 投递成功：PROCESSING → SENT（sent_at = now；attempts+1）；true 表示 fencing 更新获胜。 */
  markSent(input: OutboxSettleInput): Promise<boolean>;

  /**
   * 投递失败：attempts+1；attempts 达 deadAfter → DEAD（终态，停止重试，
   * 人工介入），否则回 PENDING（available_at = now + backoff，指数退避
   * 由实现经 attempts 计算：1s,2s,4s...2min 封顶），同时释放旧租约。
   * 结算 UPDATE 必须带 lockedBy + leaseUntil fencing 条件，防止过期 worker
   * 覆盖新租约持有者的状态。
   */
  markFailed(input: OutboxSettleInput & { deadAfter: number; lastErrorCode: string }): Promise<boolean>;

  /**
   * 过期恢复：lease_until < now 且 status=PROCESSING 的行回 PENDING
   * （attempts 不动；崩溃 worker 的租约过期后其他 worker 可重新领取）。
   * I(lease_until,id) 索引支撑。
   */
  reclaimStale(input: { now: Date }): Promise<number>;

  /** 按 event_key 查（消费者幂等重放校验用；U(event_key) 唯一）。 */
  findByEventKey(eventKey: string): Promise<OutboxModel | null>;
}
