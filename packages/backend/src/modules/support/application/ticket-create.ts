/**
 * support 模块用例：创建客服会话（POST /me/support/conversations）。
 *
 * 领域所有者：support 模块（support_conversation 写入 + 同事务首条
 * support_message CUSTOMER 消息 + 未读计数 + outbox 同事务）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（客服消息 outbox→Socket 双端
 * 投递 + 断线补拉）、§4（幂等先抢 `U(message_key)` 唯一约束；所有
 * 分录/outbox 同事务）；数据库设计 SDD §5.9（support_conversation
 * WAITING_SUPPORT=1；一个用户可创建多个独立问题会话；未读计数与
 * 消息写入同事务更新；closed_at 后不可再追加消息）。
 *
 * 用例语义：
 * - 创建 support_conversation WAITING_SUPPORT=1（assigned_admin_user_id=NULL
 *   待领取，supportUnreadCount=0，userUnreadCount=0，last_message_at 首条
 *   消息时间）；
 * - 同事务追加首条 support_message CUSTOMER=1（TEXT=1，message_key 客户端
 *   幂等键，U(message_key) 兜底——命中 → 既有会话 + 既有首条消息重放，
 *   不产生第二行）；
 * - 同事务写 outbox topic `support.message`（payload = { messageId,
 *   conversationId, senderType=CUSTOMER, bodyText? 脱敏最小负载 }，
 *   投递目标 user_id = null（公开给坐席侧 /admin，§6.3 未闭环项：
 *   双端投递经 outbox worker 落地后投 /platform 与 /admin 两侧）；
 * - 未读计数 supportUnreadCount=1（客服侧待读，与消息写入同事务更新）。
 *
 * 错误码映射（SUP → 触发条件）：
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 首条消息幂等键冲突（可重试）。
 * - 成功 → ConversationCreatedDto（201；重放 message_key 命中 = 200 语义
 *   由路由层按 `inserted` 标志决定，登记决策点）。
 *
 * 锁顺序（SDD §4）：support_conversation（写新行）→ support_message
 * （写首条）→ outbox（同事务），无跨表锁竞争（新会话无既有行）。
 */

import { SupportDomainError, SUP, isDuplicateKeyError } from '../domain/errors.js';
import type { TicketRepo, SupportMessageRepo, Tx } from '../ports/support-repository.js';
import type { OutboxPort } from '../ports/support-repository-exports.js';

/** 客服会话创建结果（wire DTO；ID 十进制字符串 wire）。 */
export interface ConversationCreatedDto {
  conversationId: string;
  status: number;
  categoryType: number;
  subject: string;
  firstMessage: {
    messageId: string;
    messageKey: string;
    senderUserId: string;
    senderType: number;
    bodyText: string | null;
    createdAt: string;
  };
  inserted: boolean;
}

export class TicketCreateUseCase {
  constructor(
    private readonly ticketRepo: TicketRepo,
    private readonly messageRepo: SupportMessageRepo,
    private readonly outbox: OutboxPort,
  ) {}

  /**
   * POST /me/support/conversations：创建客服会话 + 首条消息 + 同事务写 outbox。
   * 调用方（路由层）负责开事务，传入 `tx`。
   */
  async run(input: {
    userId: string;
    categoryType: number;
    subject: string;
    bodyText: string | null;
    messageKey: string;
    orderId: string | null;
    withdrawalId: string | null;
    tx: Tx;
  }): Promise<ConversationCreatedDto> {
    // 1. 创建 support_conversation WAITING_SUPPORT=1
    //    幂等：同一 message_key 的首条消息 U(message_key) 兜底（见步骤 2）；
    //    会话本身无 U 约束（一个用户可多会话），重放由首条消息幂等键判定。
    let conversationResult: {
      inserted: boolean;
      conversation: { id: string; status: number; categoryType: number; subject: string; lastMessageAt: Date | string | null };
    };
    try {
      conversationResult = await this.ticketRepo.createConversation({
        userId: input.userId,
        categoryType: input.categoryType,
        subject: input.subject,
        orderId: input.orderId,
        withdrawalId: input.withdrawalId,
        tx: input.tx,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new SupportDomainError(SUP.STORAGE_UNAVAILABLE, '客服会话创建幂等冲突，请重试。', {
          retryable: true,
        });
      }
      throw err;
    }

    // 2. 同事务追加首条 support_message CUSTOMER=1 TEXT=1（U(message_key) 幂等兜底）
    const messageResult = await this.messageRepo.appendSupportMessage({
      supportConversationId: conversationResult.conversation.id,
      messageKey: input.messageKey,
      senderUserId: input.userId,
      senderType: 1, // CUSTOMER=1
      messageType: 1, // TEXT=1
      bodyText: input.bodyText,
      assetId: null,
      unreadSide: 'support', // 客服侧未读 +1
      outbox: this.outbox,
      tx: input.tx,
    });

    // 3. 同事务写 outbox topic `support.message`（§6.3 outbox 权威；
    //    payload 脱敏最小负载，不含全文（bodyText 可省略，由消费端按
    //    messageId 补拉权威快照，§6.3 "先持久化、后推送"））
    await this.outbox.append({
      topic: 'support.message',
      userId: null, // 公开给坐席侧 /admin（非玩家私有通知）
      payload: {
        messageId: messageResult.message.id,
        conversationId: conversationResult.conversation.id,
        senderType: 1, // CUSTOMER
        messageType: 1, // TEXT
      },
      eventKey: `support:message:${input.messageKey}`,
    });

    // 4. 组装 wire DTO（首条消息重放时 inserted=false 由 messageResult 标志判定）
    return {
      conversationId: conversationResult.conversation.id,
      status: conversationResult.conversation.status,
      categoryType: conversationResult.conversation.categoryType,
      subject: conversationResult.conversation.subject,
      firstMessage: {
        messageId: messageResult.message.id,
        messageKey: input.messageKey,
        senderUserId: input.userId,
        senderType: 1,
        bodyText: input.bodyText,
        createdAt:
          typeof messageResult.message.createdAt === 'string'
            ? messageResult.message.createdAt
            : messageResult.message.createdAt.toISOString(),
      },
      inserted: messageResult.inserted,
    };
  }
}
