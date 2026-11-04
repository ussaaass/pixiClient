/**
 * 发送私聊消息用例：POST /me/social/conversations/:id/messages（SDD §5.4）。
 *
 * 领域所有者：social 模块（social_message 追加；social_conversation 行锁读）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（双账号私信幂等、消息 outbox→Socket
 * 双端投递、断线补拉）、§4（锁顺序 social_conversation → social_message，
 * 幂等先抢 `U(social_conversation_id, message_no)` / `U(sender_user_id,
 * client_message_id)` 双唯一约束；所有分录/outbox 同事务）；数据库设计
 * SDD §5.12（social_message SENT=1，message_no 单调递增 BIGINT UNSIGNED，
 * U(conversation_id, message_no) 会话内唯一，U(sender, client_message_id)
 * 客户端幂等键）。
 *
 * 用例语义：
 * - 锁读 social_conversation（会话行锁；status = CLOSED=3 → SOCIAL_CONVERSATION_CLOSED；
 *   发送者非 low/high 成员 → SOCIAL_NOT_CONVERSATION_MEMBER）；
 * - 计算新 message_no = 会话 last_message_no + 1（`nextMessageNo` 纯函数；
 *   十进制字符串 wire，BIGINT UNSIGNED）；
 * - 追加 social_message SENT=1（U(conversation_id, message_no) 会话内单调递增；
 *   U(sender_user_id, client_message_id) 幂等兜底——命中 → 返回既有行
 *   （inserted: false，不产生第二行，验收红线"双账号私信幂等"）；
 * - 同事务更新会话 last_message_no / last_message_at（与消息写入同事务，
 *   保证游标单调不落后）；
 * - 同事务写 outbox topic `social.message`（§6.3 outbox 权威；
 *   payload = { messageId, conversationId, messageNo, senderUserId }，
 *   投递目标 user_id = 对方（非发送方）；§6.3 未闭环项：双端 Socket
 *   投递经 outbox worker 落地后投 /platform 两侧，本用例只写 outbox 行）。
 *
 * 错误码映射（S → 触发条件）：
 * - `SOCIAL_CONVERSATION_CLOSED`：会话 status = CLOSED=3，不可再追加消息。
 * - `SOCIAL_NOT_CONVERSATION_MEMBER`：发送者非会话 low/high 成员。
 * - `SOCIAL_POST_NOT_FOUND`：（不适用，本用例不涉及帖子）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障（可重试）。
 * - `MESSAGE_DUPLICATE`：client_message_id 命中但内容哈希不一致（首版
 *   统一视为幂等重放返回既有行，不抛此码；登记决策点：若 Lead 要求
 *   严格校验内容，需扩展 adapter 层写入 request_hash）。
 * - 成功 → MessageSentDto（201；重放 U(sender,client_message_id) 命中 =
 *   200 语义由路由层按 `inserted` 标志决定）。
 *
 * 锁顺序（SDD §4）：social_conversation（行锁读 last_message_no）→
 * social_message（写新行，U(conversation_id, message_no) 兜底）→
 * social_conversation（更新 last_message_no / last_message_at）。
 * 三步同事务（回滚即整事务回滚，不产生半写状态）。
 */

import { SocialDomainError, S, isDuplicateKeyError } from '../domain/errors.js';
import { nextMessageNo } from '../domain/message-rules.js';
import type { ConversationRepo, MessageRepo, Tx } from '../ports/social-repository.js';
import type { OutboxPort } from '../ports/social-repository-exports.js';

/** 消息发送结果（wire DTO；ID/序号 十进制字符串 wire）。 */
export interface MessageSentDto {
  messageId: string;
  conversationId: string;
  clientMessageId: string;
  messageNo: string;
  senderUserId: string;
  bodyText: string | null;
  assetId: string | null;
  messageType: number;
  createdAt: string;
  inserted: boolean;
}

export class MessageSendUseCase {
  constructor(
    private readonly conversationRepo: ConversationRepo,
    private readonly messageRepo: MessageRepo,
    private readonly outbox: OutboxPort,
  ) {}

  /**
   * POST /me/social/conversations/:id/messages：发送私聊消息 + 同事务写 outbox。
   * 调用方（路由层）负责开事务，传入 `tx`。
   */
  async run(input: {
    userId: string;
    conversationId: string;
    clientMessageId: string;
    bodyText: string | null;
    assetId: string | null;
    messageType: number;
    tx: Tx;
  }): Promise<MessageSentDto> {
    // 1. 锁读 social_conversation（会话行锁；CLOSED / 非成员 → 抛领域错误）
    const conversation = await this.conversationRepo.lockConversation(input.conversationId, input.tx);
    if (conversation === null) {
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, `会话不存在：${input.conversationId}`, { retryable: true });
    }
    if (conversation.status === 3) {
      // CLOSED=3：不可再追加消息
      throw new SocialDomainError(S.SOCIAL_CONVERSATION_CLOSED, '会话已关闭，不可再追加消息。');
    }
    // 发送者必须是会话成员（low 或 high）
    if (input.userId !== conversation.lowUserId && input.userId !== conversation.highUserId) {
      throw new SocialDomainError(S.SOCIAL_NOT_CONVERSATION_MEMBER, '你不是该会话的成员。');
    }

    // 2. 计算新 message_no = last_message_no + 1（十进制字符串 wire）
    const newMessageNo = nextMessageNo(conversation.lastMessageNo);

    // 3. 追加 social_message SENT=1（U(conversation_id, message_no) 兜底；
    //    U(sender_user_id, client_message_id) 幂等兜底）
    let messageResult: { inserted: boolean; message: { id: string; createdAt: Date | string; messageNo: string } };
    try {
      messageResult = await this.messageRepo.appendMessage({
        socialConversationId: input.conversationId,
        messageNo: newMessageNo,
        senderUserId: input.userId,
        clientMessageId: input.clientMessageId,
        messageType: input.messageType,
        bodyText: input.bodyText,
        assetId: input.assetId,
        tx: input.tx,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(conversation_id, message_no) 命中（并发竞态：两客户端同时读到
        // 同一 last_message_no）→ 重读会话高水位，重试一次；
        // U(sender_user_id, client_message_id) 命中（幂等重放）→ 由 adapter
        // 层返回既有行（inserted: false），不抛此分支。
        // 首版：直接抛 STORAGE_UNAVAILABLE 让客户端重试用原 client_message_id，
        // adapter 层幂等兜底命中既有行返回（登记决策点：并发竞态重试次数）。
        throw new SocialDomainError(S.STORAGE_UNAVAILABLE, '消息序号竞态冲突，请重试（使用相同 client_message_id 幂等重放）。', {
          retryable: true,
        });
      }
      throw err;
    }

    // 4. 会话 last_message_no / last_message_at 高水位更新在 adapter 层
    //    `appendMessage` 内同事务完成（避免用例层额外一次 UPDATE 增加锁竞争；
    //    见 ports/social-repository.ts MessageRepo.appendMessage 约定）。
    //    未读游标（user_low/high_read_through_no）推进归客户端已读回执端点
    //    （§9 第 5 步后续，登记决策点：首版未建 read-receipt 端点）。

    // 5. 同事务写 outbox topic `social.message`（§6.3 outbox 权威；
    //    投递目标 = 对方 user_id，payload 不含正文全文（脱敏最小负载））
    const peerUserId = input.userId === conversation.lowUserId ? conversation.highUserId : conversation.lowUserId;
    await this.outbox.append({
      topic: 'social.message',
      userId: peerUserId,
      payload: {
        messageId: messageResult.message.id,
        conversationId: input.conversationId,
        messageNo: newMessageNo,
        senderUserId: input.userId,
      },
      eventKey: `social:message:${input.clientMessageId}`,
    });

    return {
      messageId: messageResult.message.id,
      conversationId: input.conversationId,
      clientMessageId: input.clientMessageId,
      messageNo: newMessageNo,
      senderUserId: input.userId,
      bodyText: input.bodyText,
      assetId: input.assetId,
      messageType: input.messageType,
      createdAt:
        typeof messageResult.message.createdAt === 'string'
          ? messageResult.message.createdAt
          : messageResult.message.createdAt.toISOString(),
      inserted: messageResult.inserted,
    };
  }
}
