/**
 * support 模块用例：列出用户客服会话（GET /me/support/conversations）。
 *
 * 领域所有者：support 模块（support_conversation 只读）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（坐席队列 + 断线补拉）、§4
 * （读用例无锁，避免不必要的行锁）；数据库设计 SDD §5.9
 * （一个用户可创建多个独立问题会话；按 last_message_at 降序队列排序）。
 *
 * 用例语义：
 * - 只读（无事务，SDD §4 读用例直接无事务调用，避免不必要行锁）；
 * - 按 user_id 查全部 status 的会话（含 CLOSED=3 历史），last_message_at
 *   降序前 1000 条（契约 SupportConversationListResponseSchema maxItems=1000）；
 * - 只返回会话 DTO（不含消息全文，消息经 GET /me/support/conversations/:id/messages
 *   补拉端点按 id 升序拉取，§6.3 "先持久化、后推送"）。
 *
 * 错误码映射（SUP → 触发条件）：
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障（可重试）。
 * - 成功 → ConversationListDto（200；conversation 升序/降序按 last_message_at）。
 *
 * 锁顺序（SDD §4）：无锁（只读）。
 */

import { SupportDomainError, SUP } from '../domain/errors.js';
import type { TicketRepo, Tx } from '../ports/support-repository.js';

/** 用户客服会话列表结果（wire DTO；ID 十进制字符串 wire）。 */
export interface ConversationListDto {
  conversations: {
    conversationId: string;
    categoryType: number;
    subject: string;
    status: number;
    lastMessageAt: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
}

export class TicketListUseCase {
  constructor(private readonly ticketRepo: TicketRepo) {}

  /**
   * GET /me/support/conversations：列出用户客服会话（只读，无事务）。
   */
  async run(input: { userId: string; tx: Tx }): Promise<ConversationListDto> {
    try {
      const rows = await this.ticketRepo.findConversationsByUser(input.userId, input.tx);
      return {
        conversations: rows.map((c) => ({
          conversationId: c.id,
          categoryType: c.categoryType,
          subject: c.subject,
          status: c.status,
          lastMessageAt:
            c.lastMessageAt === null ? null : typeof c.lastMessageAt === 'string' ? c.lastMessageAt : c.lastMessageAt.toISOString(),
          createdAt: typeof c.createdAt === 'string' ? c.createdAt : c.createdAt.toISOString(),
          updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : c.updatedAt.toISOString(),
        })),
      };
    } catch (err) {
      // Sequelize 故障 → 可重试
      if (err instanceof SupportDomainError) throw err;
      throw new SupportDomainError(SUP.STORAGE_UNAVAILABLE, '客服会话列表读取失败，请重试。', { retryable: true });
    }
  }
}
