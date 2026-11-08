/**
 * support 模块用例：坐席领取（POST /admin/support/conversations/:id/claim）。
 *
 * 领域所有者：support 模块（support_conversation 行锁读 + assigned_admin_user_id
 * 幂等 claim）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（坐席领取/回复/重开幂等验收）、
 * §4（幂等先抢唯一约束；所有分录/outbox 同事务）；数据库设计 SDD §5.9
 * （support_conversation assigned_admin_user_id 待领取=NULL，claim 后
 * 绑定坐席；坐席端点首版同 player token + role_type 校验，完整 Admin
 * audience 中间件归 §9 第 9 步）。
 *
 * 用例语义：
 * - 锁读会话（SELECT ... FOR UPDATE；缺行 → SUPPORT_CONVERSATION_NOT_FOUND）；
 * - 幂等键 `support:claim:{conversationId}:{adminUserId}`（`supportClaimKeyOf`
 *   纯函数生成）：已 claim 同 admin → 静默返回既有值（不产生第二笔，
 *   验收红线"坐席领取幂等"）；已 claim 异 admin → SUPPORT_IDEMPOTENCY_KEY_REUSED
 *   （跨坐席冲突，路由层映射 409）；
 * - claim 成功：assigned_admin_user_id 从 NULL → adminUserId（会话状态保持
 *   WAITING_SUPPORT=1 或 WAITING_USER=2，不改 status——领取不推进状态机，
 *   仅绑定坐席）。
 *
 * 错误码映射（SUP → 触发条件）：
 * - `SUPPORT_CONVERSATION_NOT_FOUND`：会话行缺失。
 * - `SUPPORT_IDEMPOTENCY_KEY_REUSED`：跨坐席领取冲突（已 claim 异 admin）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 状态机影响行数 0（可重试）。
 * - 成功 → ClaimResultDto（200；重放同 admin = 200 幂等，异 admin = 409）。
 *
 * 锁顺序（SDD §4）：support_conversation（行锁读 + UPDATE assigned_admin_user_id），
 * 单表操作无跨表锁竞争。
 */

import { SupportDomainError, SUP, isDuplicateKeyError } from '../domain/errors.js';
import { supportClaimKeyOf } from '../domain/ticket-rules.js';
import type { TicketRepo, Tx } from '../ports/support-repository.js';

/** 坐席领取结果（wire DTO；ID 十进制字符串 wire）。 */
export interface ClaimResultDto {
  conversationId: string;
  assignedAdminUserId: string;
  status: number;
  inserted: boolean;
}

export class TicketClaimUseCase {
  constructor(private readonly ticketRepo: TicketRepo) {}

  /**
   * POST /admin/support/conversations/:id/claim：坐席领取（幂等键双兜底）。
   * 调用方（路由层）负责开事务 + 前置 role_type 校验，传入 `tx`。
   */
  async run(input: { conversationId: string; adminUserId: string; adminRoleType: number; tx: Tx }): Promise<ClaimResultDto> {
    void supportClaimKeyOf(input.conversationId, input.adminUserId); // 幂等键生成（U 约束兜底）
    // Claim is an admin-only command. Enforce the ADMIN bit at the application
    // boundary as well as any HTTP boundary, so a misconfigured caller cannot
    // turn a player/agent role into a support assignment.
    if ((input.adminRoleType & 4) === 0) {
      throw new SupportDomainError(SUP.SUPPORT_NOT_ASSIGNED, '无坐席权限（需 ADMIN role bit）。');
    }

    // 1. 锁读会话（缺行 → 可重试）
    const conversation = await this.ticketRepo.lockConversation(input.conversationId, input.tx);
    if (conversation === null) {
      throw new SupportDomainError(SUP.SUPPORT_CONVERSATION_NOT_FOUND, `客服会话不存在：${input.conversationId}`);
    }

    // 2. 幂等 claim（adapter 层 U(message_key 等价键) + 行值校验双兜底）
    let result: { inserted: boolean; conversation: { id: string; status: number; assignedAdminUserId: string | null } };
    try {
      result = await this.ticketRepo.claimConversation(input.conversationId, input.adminUserId, input.tx);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U 键命中：读回既有行，按 assigned_admin_user_id 判定同/异 admin
        const existing = await this.ticketRepo.lockConversation(input.conversationId, input.tx);
        if (existing !== null && existing.assignedAdminUserId !== null) {
          if (existing.assignedAdminUserId === input.adminUserId) {
            // 同 admin 幂等重放 → 静默返回既有值
            return {
              conversationId: existing.id,
              assignedAdminUserId: existing.assignedAdminUserId,
              status: existing.status,
              inserted: false,
            };
          }
          // 异 admin → 跨坐席冲突
          throw new SupportDomainError(SUP.SUPPORT_IDEMPOTENCY_KEY_REUSED, '该会话已被其他坐席领取。');
        }
      }
      throw err;
    }

    return {
      conversationId: result.conversation.id,
      assignedAdminUserId: result.conversation.assignedAdminUserId ?? input.adminUserId,
      status: result.conversation.status,
      inserted: result.inserted,
    };
  }
}
