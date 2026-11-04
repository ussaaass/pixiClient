/**
 * support 模块用例：客服会话回复（POST /support/conversations/:id/messages）。
 *
 * 领域所有者：support 模块（support_message 追加 + support_conversation
 * 未读计数/状态机转换同事务更新 + outbox 同事务）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（坐席领取/回复/重开 + 消息
 * outbox→Socket 双端投递 + 断线补拉）、§4（锁顺序 support_conversation
 * → support_message，幂等先抢 `U(message_key)` 唯一约束；所有分录/outbox
 * 同事务）；数据库设计 SDD §5.9（support_message VISIBLE=1；未读计数
 * 与消息写入同事务更新；closed_at 后不可再追加消息）。
 *
 * 用例语义（用户侧发送 CUSTOMER 消息，坐席侧 ADMIN 回复经 Admin 端点
 * 复用本用例同型路径，首版同 player token + role_type 校验）：
 * - 锁读会话（SELECT ... FOR UPDATE；缺行 → SUPPORT_CONVERSATION_NOT_FOUND；
 *   CLOSED=3 → SUPPORT_CONVERSATION_CLOSED 不可再追加）；
 * - 用户侧权限校验：`user_id` = 请求者（SUPPORT_NOT_CONVERSATION_OWNER 语义，
 *   路由层映射 403）；坐席侧回复经 `canAdminReply` 纯函数前置校验
 *   （role_type 含 ADMIN=4 位 + assigned_admin_user_id = 操作者 + status ≠ CLOSED）；
 * - 追加 support_message VISIBLE=1（U(message_key) 幂等兜底——命中 →
 *   返回既有行（inserted: false，不产生第二行，验收红线"客服消息幂等"）；
 *   同事务更新会话未读计数（`unreadSide` 指定哪侧 +1）+ last_message_at；
 * - 状态机推进（用户 CUSTOMER 发送 → `markConversationWaitingUser`
 *   WAITING_SUPPORT=1 → WAITING_USER=2；坐席 ADMIN 回复不改状态机，
 *   仅未读计数）；
 * - 同事务写 outbox topic `support.message`（§6.3 outbox 权威；
 *   双端投递经 outbox worker 落地后投 /platform 与 /admin 两侧，
 *   §6.3 未闭环项，本用例只写行；payload 脱敏最小负载）。
 *
 * 错误码映射（SUP → 触发条件）：
 * - `SUPPORT_CONVERSATION_NOT_FOUND`：会话行缺失。
 * - `SUPPORT_CONVERSATION_CLOSED`：会话 status = CLOSED=3，closed_at 后不可再追加。
 * - `SUPPORT_NOT_CONVERSATION_OWNER`：请求者非会话 user_id（用户侧）。
 * - `SUPPORT_NOT_ASSIGNED`：坐席端点操作未 claim 的会话（assigned_admin_user_id=NULL）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 幂等键冲突（可重试）。
 * - 成功 → ReplyResultDto（201；重放 message_key 命中 = 200 语义由路由层
 *   按 `inserted` 标志决定）。
 *
 * 锁顺序（SDD §4）：support_conversation（行锁读 + UPDATE 未读计数）→
 * support_message（写新行，U(message_key) 兜底）→ outbox（同事务写行）。
 * 三步同事务（回滚即整事务回滚，不产生半写状态）。
 */

import { SupportDomainError, SUP, isDuplicateKeyError } from '../domain/errors.js';
import { canAdminReply, isValidConversationStatusTransition } from '../domain/ticket-rules.js';
import type { TicketRepo, SupportMessageRepo, Tx } from '../ports/support-repository.js';
import type { OutboxPort } from '../../wallet/ports/outbox-port.js';

/** 客服会话回复结果（wire DTO；ID 十进制字符串 wire）。 */
export interface ReplyResultDto {
  messageId: string;
  conversationId: string;
  messageKey: string;
  senderUserId: string | null;
  senderType: number;
  bodyText: string | null;
  messageType: number;
  createdAt: string;
  inserted: boolean;
}

export class TicketReplyUseCase {
  constructor(
    private readonly ticketRepo: TicketRepo,
    private readonly messageRepo: SupportMessageRepo,
  ) {}

  /**
   * POST /support/conversations/:id/messages（用户侧 CUSTOMER 消息）。
   * 调用方（路由层）负责开事务，传入 `tx`；outbox 经本用例内部
   * `messageRepo.appendSupportMessage` 同事务写（adapter 层绑定）。
   */
  async run(input: {
    userId: string;
    conversationId: string;
    bodyText: string | null;
    messageKey: string;
    messageType: number;
    senderType: number; // CUSTOMER=1 / ADMIN=2 / SYSTEM=3
    senderUserId: string | null; // SYSTEM=3 时 null
    adminRoleType?: number; // 坐席侧回复时 role_type 校验用
    tx: Tx;
    outbox: OutboxPort;
  }): Promise<ReplyResultDto> {
    const { tx, outbox } = input;

    // 1. 锁读会话（缺行 / CLOSED → 领域错误）
    const conversation = await this.ticketRepo.lockConversation(input.conversationId, tx);
    if (conversation === null) {
      throw new SupportDomainError(SUP.SUPPORT_CONVERSATION_NOT_FOUND, `客服会话不存在：${input.conversationId}`);
    }
    if (conversation.status === 3 || conversation.closedAt !== null) {
      // CLOSED=3：closed_at 后不可再追加消息（§5.9）
      throw new SupportDomainError(SUP.SUPPORT_CONVERSATION_CLOSED, '会话已关闭，不可再追加消息。');
    }

    // 2. 权限校验（用户侧 / 坐席侧）
    if (input.senderType === 1) {
      // CUSTOMER=1：请求者必须是会话 user_id
      if (conversation.userId !== input.userId) {
        throw new SupportDomainError(SUP.SUPPORT_NOT_CONVERSATION_OWNER, '你不是该客服会话的所有者。');
      }
    } else {
      // ADMIN=2 / SYSTEM=3：坐席侧（首版同 player token + role_type 校验；
      // 完整 Admin audience 中间件归 §9 第 9 步）
      const roleType = input.adminRoleType ?? 0;
      if (
        !canAdminReply({
          adminRoleType: roleType,
          adminUserId: input.userId,
          assignedAdminUserId: conversation.assignedAdminUserId,
          conversationStatus: conversation.status,
        })
      ) {
        // 未 claim / 非本坐席 / 非 ADMIN role → SUPPORT_NOT_ASSIGNED（路由层映射 403/409）
        throw new SupportDomainError(SUP.SUPPORT_NOT_ASSIGNED, '会话未由你领取或无权回复。');
      }
    }

    // 3. 追加 support_message VISIBLE=1（U(message_key) 幂等兜底；
    //    同事务更新未读计数 + last_message_at + 写 outbox 行）
    let messageResult: {
      inserted: boolean;
      message: {
        id: string;
        createdAt: Date | string;
        messageKey: string;
        senderUserId: string | null;
        senderType: number;
        messageType: number;
        bodyText: string | null;
      };
    };
    try {
      messageResult = await this.messageRepo.appendSupportMessage({
        supportConversationId: input.conversationId,
        messageKey: input.messageKey,
        senderUserId:
          input.senderUserId !== null && input.senderType !== 3 ? input.senderUserId : input.senderType === 3 ? null : input.senderUserId,
        senderType: input.senderType,
        messageType: input.messageType,
        bodyText: input.bodyText,
        assetId: null,
        unreadSide: input.senderType === 1 ? 'support' : 'customer',
        outbox,
        tx,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(message_key) 命中 = 幂等重放（前次已写入，直接读回既有行）
        const existing = await this.messageRepo.findMessageByKey(input.messageKey, tx);
        if (existing !== null) {
          messageResult = {
            inserted: false,
            message: {
              id: existing.id,
              createdAt: existing.createdAt,
              messageKey: existing.messageKey,
              senderUserId: existing.senderUserId,
              senderType: existing.senderType,
              messageType: existing.messageType,
              bodyText: existing.bodyText,
            },
          };
        } else {
          throw new SupportDomainError(SUP.STORAGE_UNAVAILABLE, '客服消息幂等键冲突，请重试。', { retryable: true });
        }
      } else {
        throw err;
      }
    }

    // 4. 状态机推进（用户 CUSTOMER 发送 → WAITING_SUPPORT=1 → WAITING_USER=2；
    //    坐席 ADMIN 回复不改状态机；SYSTEM 通知不改状态机）
    if (input.senderType === 1) {
      // 仅从 WAITING_SUPPORT=1 推进（WAITING_USER=2 → 幂等静默）
      const fromStatus = conversation.status;
      const toStatus = 2;
      if (isValidConversationStatusTransition(fromStatus, toStatus) && fromStatus !== toStatus) {
        await this.ticketRepo.markConversationWaitingUser(input.conversationId, tx);
      }
    }

    // 5. 组装 wire DTO
    return {
      messageId: messageResult.message.id,
      conversationId: input.conversationId,
      messageKey: input.messageKey,
      senderUserId: messageResult.message.senderUserId,
      senderType: input.senderType,
      bodyText: input.bodyText,
      messageType: input.messageType,
      createdAt:
        typeof messageResult.message.createdAt === 'string'
          ? messageResult.message.createdAt
          : messageResult.message.createdAt.toISOString(),
      inserted: messageResult.inserted,
    };
  }
}
