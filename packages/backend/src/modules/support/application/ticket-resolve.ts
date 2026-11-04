/**
 * support 模块用例：关闭客服会话（POST /support/conversations/:id/resolve）。
 *
 * 领域所有者：support 模块（support_conversation 状态机转换 CLOSED=3 +
 * closed_at 回填）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（坐席领取/回复/重开验收）、§4
 * （幂等先抢唯一约束；所有分录/outbox 同事务）；数据库设计 SDD §5.9
 * （support_conversation 状态机 WAITING_SUPPORT=1 → WAITING_USER=2 →
 * CLOSED=3 + closed_at；closed_at 后不可再追加消息；坐席 resolve
 * 幂等：已 CLOSED 重放静默返回既有值，不产生第二笔）。
 *
 * 用例语义：
 * - 锁读会话（SELECT ... FOR UPDATE；缺行 → SUPPORT_CONVERSATION_NOT_FOUND）；
 * - 权限校验（坐席侧：`canAdminReply` 纯函数前置校验 role_type 含
 *   ADMIN=4 位 + assigned_admin_user_id = 操作者；用户侧 resolve 首版
 *   不开放，仅坐席可关单——登记决策点）；
 * - 状态机转换：WAITING_SUPPORT=1 / WAITING_USER=2 → CLOSED=3（同事务
 *   回填 closed_at；影响行数 0 → 幂等静默返回既有值，不产生第二笔）；
 * - CLOSED 后不可再追加消息（后续消息端点前置校验，本用例只做转换）；
 * - 同事务写 outbox topic `support.conversation.closed`（可选；首版
 *   登记决策点：close 事件是否写 outbox，首版暂不写，坐席端读
 *   conversation 状态即可，若 Lead 要求投 /admin 侧 close 通知需补写）。
 *
 * 错误码映射（SUP → 触发条件）：
 * - `SUPPORT_CONVERSATION_NOT_FOUND`：会话行缺失。
 * - `SUPPORT_NOT_ASSIGNED`：坐席端点操作未 claim 的会话（assigned_admin_user_id=NULL）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 状态机影响行数 0（可重试；
 *   CLOSED 重放除外——已 CLOSED 幂等静默返回，不抛此码）。
 * - 成功 → ResolveResultDto（200；重放已 CLOSED = 200 幂等静默）。
 *
 * 锁顺序（SDD §4）：support_conversation（行锁读 + UPDATE status / closed_at），
 * 单表操作无跨表锁竞争。
 */

import { SupportDomainError, SUP } from '../domain/errors.js';
import { canAdminReply, isValidConversationStatusTransition } from '../domain/ticket-rules.js';
import type { TicketRepo, Tx } from '../ports/support-repository.js';

/** 客服会话关闭结果（wire DTO；ID 十进制字符串 wire；status 数值常量 wire）。 */
export interface ResolveResultDto {
  conversationId: string;
  status: number;
  closedAt: string | null;
  inserted: boolean;
}

export class TicketResolveUseCase {
  constructor(private readonly ticketRepo: TicketRepo) {}

  /**
   * POST /support/conversations/:id/resolve：坐席关闭会话
   * （WAITING_SUPPORT=1 / WAITING_USER=2 → CLOSED=3 + closed_at）。
   * 调用方（路由层）负责开事务 + 前置 role_type 校验，传入 `tx`。
   */
  async run(input: { adminUserId: string; adminRoleType: number; conversationId: string; tx: Tx }): Promise<ResolveResultDto> {
    const now = new Date();

    // 1. 锁读会话（缺行 → 领域错误）
    const conversation = await this.ticketRepo.lockConversation(input.conversationId, input.tx);
    if (conversation === null) {
      throw new SupportDomainError(SUP.SUPPORT_CONVERSATION_NOT_FOUND, `客服会话不存在：${input.conversationId}`);
    }

    // 2. 已 CLOSED=3 → 幂等静默返回既有值（不产生第二笔，验收红线）
    if (conversation.status === 3) {
      return {
        conversationId: conversation.id,
        status: conversation.status,
        closedAt:
          conversation.closedAt === null
            ? null
            : typeof conversation.closedAt === 'string'
              ? conversation.closedAt
              : conversation.closedAt.toISOString(),
        inserted: false,
      };
    }

    // 3. 坐席权限校验（首版同 player token + role_type 校验；完整
    //    Admin audience 中间件归 §9 第 9 步）
    if (
      !canAdminReply({
        adminRoleType: input.adminRoleType,
        adminUserId: input.adminUserId,
        assignedAdminUserId: conversation.assignedAdminUserId,
        conversationStatus: conversation.status,
      })
    ) {
      throw new SupportDomainError(SUP.SUPPORT_NOT_ASSIGNED, '会话未由你领取或无权关闭。');
    }

    // 4. 状态机推进（WAITING_SUPPORT=1 / WAITING_USER=2 → CLOSED=3，
    //    同事务回填 closed_at；影响行数 0 → 幂等静默返回）
    if (isValidConversationStatusTransition(conversation.status, 3)) {
      const updated = await this.ticketRepo.resolveConversation(input.conversationId, now, input.tx);
      return {
        conversationId: updated.id,
        status: updated.status,
        closedAt:
          updated.closedAt === null ? null : typeof updated.closedAt === 'string' ? updated.closedAt : updated.closedAt.toISOString(),
        inserted: false,
      };
    }

    // 非法状态机转换（理论上 CLOSED 已在步骤 2 拦截，此处为防御性兜底）
    throw new SupportDomainError(SUP.STORAGE_UNAVAILABLE, '会话状态机转换非法，请重试。', { retryable: true });
  }
}
