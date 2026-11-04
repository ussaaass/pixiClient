/**
 * 创建会话用例：POST /me/social/conversations（SDD §5.4 social 端点）。
 *
 * 领域所有者：social 模块（social_conversation 写入；pair 归一 pure function）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（双账号私信幂等验收）、§4
 * （幂等先抢 `U(low_user_id, high_user_id)` 唯一约束）；数据库设计 SDD §5.12
 * （social_conversation ACTIVE=1，pair 用 low/high_user_id 归一 U(low,high)，
 * 游标单调递增且 ≤ 高水位）。
 *
 * 用例语义：
 * - 归一 pair（`normalizePair` 纯函数：low < high 十进制字符串数值比较）；
 * - 创建 social_conversation ACTIVE=1（U(low,high) 幂等兜底，命中 →
 *   返回既有行（inserted: false，不产生第二会话，验收红线"双账号私信幂等"）；
 * - 新会话 last_message_no = 0，user_low/high_read_through_no = 0。
 *
 * 错误码映射（S → 触发条件）：
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障（可重试）。
 * - 成功 → ConversationCreatedDto（201；重放 U(low,high) 命中 = 200 语义由
 *   路由层按 `inserted` 标志决定）。
 *
 * 锁顺序（SDD §4）：无锁（直接 INSERT，U(low,high) 兜底）。
 */

import { normalizePair } from '../domain/message-rules.js';
import type { ConversationRepo, Tx } from '../ports/social-repository.js';

/** 会话创建结果（wire DTO；ID 十进制字符串 wire）。 */
export interface ConversationCreatedDto {
  conversationId: string;
  peerUserId: string;
  inserted: boolean;
}

export class ConversationCreateUseCase {
  constructor(private readonly conversationRepo: ConversationRepo) {}

  /**
   * POST /me/social/conversations：创建/复用一对一会话（U(low,high) 幂等）。
   * 调用方（路由层）负责开事务，传入 `tx`。
   */
  async run(input: { userId: string; peerUserId: string; agentDomainId: string | null; tx: Tx }): Promise<ConversationCreatedDto> {
    if (input.userId === input.peerUserId) {
      // 自己不能与自己创建会话（首版直接返回自身为 peer，路由层可映射 400；
      // 登记决策点：是否允许 self-conversation，首版静默返回 self 会话）。
    }

    const [lowUserId, highUserId] = normalizePair(input.userId, input.peerUserId);

    const result = await this.conversationRepo.createConversation({
      agentDomainId: input.agentDomainId,
      lowUserId,
      highUserId,
      tx: input.tx,
    });

    // peer = 非自己的那侧
    const peerUserId = lowUserId === input.userId ? highUserId : lowUserId;

    return {
      conversationId: result.conversation.id,
      peerUserId,
      inserted: result.inserted,
    };
  }
}
