/**
 * 补拉私聊消息用例：GET /me/social/conversations/:id/messages（SDD §5.4）。
 *
 * 领域所有者：social 模块（social_message 只读；social_conversation 行读）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（验收"双账号私信幂等、坐席领取/
 * 回复/重开、消息补拉一致性"）、§4（读用例无锁，避免不必要的行锁）；
 * 数据库设计 SDD §5.12（social_message 按 message_no 升序补拉，
 * 游标 after_message_no 含 0 起点，单页上限 50）。
 *
 * 用例语义：
 * - 读会话（成员校验：请求者必须是 low/high 成员，否则 403 语义由路由层映射）；
 * - 归一游标（`normalizeMessageCursor` 纯函数；非法游标 → null → 路由层 400）；
 * - 补拉 message_no > afterNo 升序前 50 条（`MESSAGE_PAGE_LIMIT` 首版固定 50，
 *   决策点登记：可经配置注入）；
 * - 只读用例（无事务，避免行锁；SDD §4 读用例直接无事务调用）。
 *
 * 错误码映射（S → 触发条件）：
 * - `SOCIAL_NOT_CONVERSATION_MEMBER`：请求者非会话 low/high 成员（路由层映射 403）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障（可重试）。
 * - 成功 → MessageListDto（200；messages 升序，nextCursor = 最后一条
 *   message_no，`null` = 无更多消息）。
 */

import { SocialDomainError, S } from '../domain/errors.js';
import { normalizeMessageCursor, MESSAGE_PAGE_LIMIT } from '../domain/message-rules.js';
import type { ConversationRepo, MessageRepo, Tx } from '../ports/social-repository.js';

/** 消息补拉结果（wire DTO；ID/序号 十进制字符串 wire；消息升序）。 */
export interface MessageListDto {
  conversationId: string;
  messages: {
    messageId: string;
    messageNo: string;
    senderUserId: string;
    messageType: number;
    bodyText: string | null;
    assetId: string | null;
    status: number;
    createdAt: string;
  }[];
  /** 下一页游标（最后一条 message_no 十进制字符串；null = 无更多消息）。 */
  nextCursor: string | null;
  /** 本页是否有更多消息（messages.length === limit → true）。 */
  hasMore: boolean;
}

export class MessageListUseCase {
  constructor(
    private readonly conversationRepo: ConversationRepo,
    private readonly messageRepo: MessageRepo,
  ) {}

  /**
   * GET /me/social/conversations/:id/messages：补拉消息（游标 message_no 升序）。
   * 只读用例，无事务。
   */
  async run(
    input: {
      userId: string;
      conversationId: string;
      afterMessageNo: string | null;
    },
    tx: Tx,
  ): Promise<MessageListDto> {
    // 1. 按主键读会话（成员校验；只读用例无锁读，避免不必要的行锁）
    const convo = await this.conversationRepo.findConversationByPk(input.conversationId, tx);
    if (convo === null) {
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, `会话不存在：${input.conversationId}`, { retryable: true });
    }
    if (input.userId !== convo.lowUserId && input.userId !== convo.highUserId) {
      throw new SocialDomainError(S.SOCIAL_NOT_CONVERSATION_MEMBER, '你不是该会话的成员。');
    }

    // 2. 归一游标（非法 → 路由层 400；此处归一为 `0` 起点或合法序号）
    const cursor = normalizeMessageCursor(input.afterMessageNo);
    if (cursor === null) {
      // 非法游标（非数字字符串）→ 路由层映射 400；此处抛领域错误
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, `非法消息游标：${input.afterMessageNo ?? ''}`);
    }

    // 3. 补拉前 MESSAGE_PAGE_LIMIT 条（升序）
    const limit = MESSAGE_PAGE_LIMIT;
    const rows = await this.messageRepo.listMessagesAfterNo(convo.id, cursor, limit, tx);

    // 4. 组装 wire DTO
    const messages = rows.map((m) => ({
      messageId: m.id,
      messageNo: m.messageNo,
      senderUserId: m.senderUserId,
      messageType: m.messageType,
      bodyText: m.bodyText,
      assetId: m.assetId,
      status: m.status,
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : m.createdAt.toISOString(),
    }));

    const hasMore = rows.length === limit;
    const nextCursor = hasMore && messages.length > 0 ? messages[messages.length - 1]!.messageNo : null;

    return {
      conversationId: convo.id,
      messages,
      nextCursor,
      hasMore,
    };
  }
}
