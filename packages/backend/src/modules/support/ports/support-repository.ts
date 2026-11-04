/**
 * support 模块仓储端口（support_conversation / support_message）。
 *
 * 领域所有者：support 模块（adapters/sequelize-support.ts 各 Repo 类实现各端口；
 * models/support.ts 为唯一 model 定义）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（社交与客服：坐席队列 + 消息
 * outbox→Socket 双端投递 + 断线补拉）、§4（锁顺序/幂等先抢唯一约束/
 * 所有分录/outbox 同事务）、§5.4（support 端点）；数据库设计 SDD §5.9
 * （support 各表 U 约束、closed_at 后不可追加、未读计数与消息写入同事务更新）。
 *
 * 约定（与 rooms 模块 ports/rooms-repository.ts 同款纪律）：
 * - 方法名经实体前缀区分（createConversation / lockConversation /
 *   appendSupportMessage / findMessageByKey / claimConversation /
 *   resolveConversation / …，各表 CRUD 语义独立，无重名冲突）；
 * - `Tx` 复用 wallet 模块 `Tx`（Sequelize 事务句柄鸭子类型），用例内所有
 *   写操作共享同一事务（回滚即整事务回滚）；
 * - 幂等兜底：`U(message_key)` 命中 → 返回既有行（`inserted: false`，
 *   不产生第二行，验收红线"客服消息幂等"）；坐席 claim 幂等键
 *   `support:claim:{conversationId}:{adminUserId}` 经 `supportClaimKeyOf`
 *   纯函数生成，U 约束 + 行值校验双兜底（已 claim 同 admin → 静默返回既有值）；
 * - 状态机：`WAITING_SUPPORT=1 → WAITING_USER=2（用户回复后）→
 *   CLOSED=3（+ closed_at）`；CLOSED 后不可再追加消息（前置校验，
 *   本层只做 UPDATE 落库）；
 * - 未读计数与消息写入同事务更新（§9 第 5 步验收"消息补拉一致性"）。
 *
 * 注：SYSTEM 通知（sender_type=SYSTEM=3）`sender_user_id` 为 NULL；
 * Admin claim/resolve 首版同 player token + role_type 校验（完整
 * Admin audience 中间件归 §9 第 9 步，本端口不依赖 Admin 模块）。
 */

import type { SupportConversationModel, SupportMessageModel } from '../../../infrastructure/database/models/support.js';
import type { OutboxPort } from '../../wallet/ports/outbox-port.js';
import type { Tx } from '../../wallet/ports/wallet-repository.js';
export type { Tx };
// ---------------------------------------------------------------------------
// TicketRepo（support_conversation）
// 方法名：createConversation / lockConversation / findConversationByUserId /
//         claimConversation / resolveConversation / markConversationWaitingUser
// ---------------------------------------------------------------------------

export interface TicketRepo {
  /**
   * 创建客服会话（support_conversation WAITING_SUPPORT=1；
   * 同事务追加首条 CUSTOMER 消息，未读计数 supportUnreadCount=1）。
   * @param input.firstMessageKey 首条消息幂等键（U(message_key) 兜底；
   *   命中 → 既有会话 + 既有首条消息重放，不产生第二行）。
   */
  createConversation(input: {
    userId: string;
    categoryType: number;
    subject: string;
    orderId: string | null;
    withdrawalId: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; conversation: SupportConversationModel }>;

  /** 按主键锁读会话（SELECT ... FOR UPDATE；会话行锁，追加消息前读 last_message_at）。 */
  lockConversation(conversationId: string, tx: Tx): Promise<SupportConversationModel | null>;

  /** 用户会话列表（GET /me/support/conversations；只读，全部 status，按 last_message_at 降序，前 1000 条）。 */
  findConversationsByUser(userId: string, tx: Tx): Promise<SupportConversationModel[]>;

  /**
   * 坐席领取（assigned_admin_user_id 从 NULL → adminUserId；
   * 幂等键 `support:claim:{conversationId}:{adminUserId}` 经
   * `supportClaimKeyOf` 纯函数生成——已 claim 同 admin → 静默返回既有值，
   * 不产生第二笔；跨 admin 领取 → FENCING_CONFLICT，由用例层映射）。
   * @returns 领取后的会话行（assigned_admin_user_id = adminUserId）。
   */
  claimConversation(
    conversationId: string,
    adminUserId: string,
    tx: Tx,
  ): Promise<{
    inserted: boolean;
    conversation: SupportConversationModel;
  }>;

  /**
   * 关闭会话（CLOSED=3 + closed_at 回填；CLOSED 后不可再追加消息，
   * 前置校验由用例层做，本层只做 UPDATE 落库；影响行数 0 → 抛 FENCING_CONFLICT）。
   */
  resolveConversation(conversationId: string, closedAt: Date, tx: Tx): Promise<SupportConversationModel>;

  /**
   * 用户回复后推进 WAITING_SUPPORT=1 → WAITING_USER=2（未读计数
   * supportUnreadCount 同步 +1；影响行数 0 → FENCING_CONFLICT，由用例层映射）。
   */
  markConversationWaitingUser(conversationId: string, tx: Tx): Promise<SupportConversationModel>;
}

// ---------------------------------------------------------------------------
// SupportMessageRepo（support_message）
// 方法名：appendSupportMessage / findMessageByKey / listMessagesByConversation
// ---------------------------------------------------------------------------

export interface SupportMessageRepo {
  /**
   * 追加客服消息（support_message VISIBLE=1；U(message_key) 唯一约束
   * 幂等兜底——命中 → 返回既有行（inserted: false，不产生第二行，
   * 验收红线"客服消息幂等"）；sender_type=SYSTEM=3 → sender_user_id=NULL；
   * sender_type=CUSTOMER=1/ADMIN=2 → sender_user_id 必填。
   * 同事务更新会话未读计数（userUnreadCount / supportUnreadCount）+
   * last_message_at 高水位（§5.9 "未读计数与消息写入同事务更新"）。
   * @param input.unreadSide 该消息使哪侧未读计数 +1：
   *   `customer` = ADMIN/SYSTEM 发出（用户侧未读）/ `support` = CUSTOMER 发出
   *   （客服侧未读）/ `none` = SYSTEM 通知（两侧均不计未读）。
   * @param input.outbox 事务绑定 outbox 端口（经本方法内同事务写
   *   `support.message` 行；§6.3 "所有分录/outbox 同事务"）。
   */
  appendSupportMessage(input: {
    supportConversationId: string;
    messageKey: string;
    senderUserId: string | null;
    senderType: number;
    messageType: number;
    bodyText: string | null;
    assetId: string | null;
    unreadSide: 'customer' | 'support' | 'none';
    outbox: OutboxPort;
    tx: Tx;
  }): Promise<{ inserted: boolean; message: SupportMessageModel }>;

  /** 按 message_key 查（幂等重放用；U(message_key) 保证至多一行）。 */
  findMessageByKey(messageKey: string, tx: Tx): Promise<SupportMessageModel | null>;

  /**
   * 按会话列出全部消息（message_id 升序，maxItems=1000；
   * SDD §9 第 5 步验收"消息补拉一致性"；first version 按 id 升序补拉）。
   */
  listMessagesByConversation(conversationId: string, tx: Tx): Promise<SupportMessageModel[]>;
}
