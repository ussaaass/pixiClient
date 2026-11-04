/**
 * support 仓储适配器（Sequelize 实现各 Repo 端口；models/support.ts 2 model
 * 的唯一写入点，行锁/幂等/状态机转换全在此层）。
 *
 * 领域所有者：support 模块（models/support.ts 为其唯一 model 定义；
 * 各表行锁/幂等/状态机约定经本层落库，领域规则经 domain/ 纯函数校验）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 support_conversation →
 * support_message，幂等先抢唯一约束；所有分录/outbox 同事务）、§9 第 5 步
 * （客服坐席队列：领取/回复/重开幂等验收、消息补拉一致性）、§3.2
 * 实体归属矩阵（support owns support_conversation / support_message 2 表，
 * models/support.ts）；数据库设计 SDD §5.9（各表 U 约束、状态机
 * WAITING_SUPPORT=1 → WAITING_USER=2 → CLOSED=3 + closed_at、
 * closed_at 后不可再追加消息、未读计数与消息写入同事务更新）。
 *
 * 行锁与并发约定（与 rooms / social 适配器同款纪律）：
 * - `lock: 'FOR UPDATE'` 字符串字面量写法（InnoDB 行锁，§4 锁顺序）；
 * - 唯一约束幂等兜底：`U(message_key)` 命中 → 返回既有行
 *   （不产生第二行，验收红线"客服消息幂等"）；坐席 claim 经行值校验
 *   双兜底（已 claim 同 admin → 静默返回既有值；跨 admin → 抛错）；
 * - 状态机转换由用例层经 `domain/ticket-rules.ts` 纯函数前置校验，
 *   本层只做 UPDATE 落库（影响行数 0 = 状态已变 → 幂等静默返回既有值，
 *   CLOSED 重放不抛错；非幂等场景由用例层映射 STORAGE_UNAVAILABLE）；
 * - 未读计数与消息写入同事务更新（§5.9）：`appendSupportMessage` 内
 *   同事务 UPDATE 会话 userUnreadCount / supportUnreadCount +
 *   last_message_at（避免用例层额外一次 UPDATE 增加锁竞争）；
 * - 同事务写 outbox（§6.3 "所有分录/outbox 同事务"）：`appendSupportMessage`
 *   经 `input.outbox.append` 写 `support.message` 行，随事务提交/回滚。
 *
 * 错误码映射（support domain/errors.ts SUP 表）：
 * - `SUPPORT_CONVERSATION_NOT_FOUND`：会话行缺失。
 * - `SUPPORT_IDEMPOTENCY_KEY_REUSED`：跨坐席领取冲突（adapter 层 U 兜底）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 行缺失（可重试）。
 *
 * 结构约定（每表一类，不混类）：
 * 各 Repo 接口各有 `create` / `lockByPk` 等同名方法，一个类无法实现两个
 * 签名，故拆为 2 个独立类（`SequelizeTicketRepo` / `SequelizeSupportMessageRepo`），
 * 各实现自己的接口；共享 `txOf` 辅助函数保留在文件顶部，各 Repo 类都调。
 * 装配层（assembly.ts）按角色独立构造，与 rooms / social 模块同款模式。
 * 注：Sequelize 6 的 BIGINT 列在严格模式（string 属性接口）下 create/update
 * 入参经 `as never` 桥接（rooms 适配器同款写法，_shared.ts 第 8 条）。
 */

import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import type { SupportConversationModel, SupportMessageModel } from '../../../infrastructure/database/models/support.js';
import { SupportConversationStatus, SupportMessageStatus } from '../../../infrastructure/database/models/support.js';
import type { OutboxPort } from '../../wallet/ports/outbox-port.js';
import type { TicketRepo, SupportMessageRepo, Tx } from '../ports/support-repository.js';
import { SupportDomainError, SUP } from '../domain/errors.js';

/** 取事务（Sequelize Transaction 鸭子类型；与 rooms / social 适配器同款约定）。
 * 返回 `Transaction | null`（exactOptionalPropertyTypes 下 undefined 不可赋给
 * null 槽，统一 null 化）。 */
function txOf(tx?: Tx): Transaction | null {
  return (tx?.transaction as Transaction | undefined) ?? null;
}

/** 共享 support 2 model 类（构造注入，不用全局，SDD §4）。 */
type SupportModels = {
  SupportConversationModel: typeof SupportConversationModel;
  SupportMessageModel: typeof SupportMessageModel;
};

// ---------------------------------------------------------------------------
// TicketRepo（support_conversation）
// ---------------------------------------------------------------------------

/**
 * 客服会话仓储（TicketRepo；Sequelize 实现）。
 * 创建（WAITING_SUPPORT=1）+ 行锁读 + 坐席 claim（assigned_admin_user_id
 * 幂等绑定）+ resolve（CLOSED=3 + closed_at）+ 状态机推进
 * （WAITING_SUPPORT=1 → WAITING_USER=2）。
 */
export class SequelizeTicketRepo implements TicketRepo {
  constructor(private readonly models: SupportModels) {}

  async createConversation(input: {
    userId: string;
    categoryType: number;
    subject: string;
    orderId: string | null;
    withdrawalId: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; conversation: SupportConversationModel }> {
    const txq = txOf(input.tx);
    // 一个用户可创建多个独立问题会话（无 U 约束防重，重放由首条消息
    // U(message_key) 兜底判定）；直接 INSERT 新行。
    const conversation = await this.models.SupportConversationModel.create(
      {
        userId: input.userId as never,
        categoryType: input.categoryType,
        subject: input.subject,
        orderId: input.orderId,
        withdrawalId: input.withdrawalId,
        status: SupportConversationStatus.WAITING_SUPPORT,
        userUnreadCount: 0,
        supportUnreadCount: 0,
      } as never,
      { transaction: txq } as never,
    );
    return { inserted: true, conversation };
  }

  async lockConversation(conversationId: string, tx: Tx): Promise<SupportConversationModel | null> {
    const txq = txOf(tx);
    const row = await this.models.SupportConversationModel.findByPk(conversationId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    return row;
  }

  async findConversationsByUser(userId: string, tx: Tx): Promise<SupportConversationModel[]> {
    const txq = txOf(tx);
    const rows = await this.models.SupportConversationModel.findAll({
      where: { userId: userId as never },
      order: [
        ['lastMessageAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: 1000,
      transaction: txq,
    } as never);
    return rows;
  }

  async claimConversation(
    conversationId: string,
    adminUserId: string,
    tx: Tx,
  ): Promise<{ inserted: boolean; conversation: SupportConversationModel }> {
    const txq = txOf(tx);
    // 行锁读（幂等键 support:claim:{conversationId}:{adminUserId} 经行值
    // 校验双兜底；U(message_key) 等价语义——support_conversation 无独立
    // claim U 约束，幂等经 assigned_admin_user_id 行值判定）
    const conversation = await this.models.SupportConversationModel.findByPk(conversationId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (conversation === null) {
      throw new SupportDomainError(SUP.SUPPORT_CONVERSATION_NOT_FOUND, `客服会话不存在：${conversationId}`);
    }
    // 已 claim 同 admin → 静默返回既有值（不产生第二笔，验收红线"坐席领取幂等"）
    if (conversation.assignedAdminUserId === adminUserId) {
      return { inserted: false, conversation };
    }
    // 未 claim（NULL）→ 绑定本坐席
    if (conversation.assignedAdminUserId === null) {
      await this.models.SupportConversationModel.update(
        { assignedAdminUserId: adminUserId as never } as never,
        { where: { id: conversation.id }, transaction: txq } as never,
      );
      conversation.assignedAdminUserId = adminUserId;
      return { inserted: true, conversation };
    }
    // 已 claim 异 admin → 跨坐席冲突（路由层映射 409）
    throw new SupportDomainError(SUP.SUPPORT_IDEMPOTENCY_KEY_REUSED, '该会话已被其他坐席领取。');
  }

  async resolveConversation(conversationId: string, closedAt: Date, tx: Tx): Promise<SupportConversationModel> {
    const txq = txOf(tx);
    const [affected] = await this.models.SupportConversationModel.update(
      {
        status: SupportConversationStatus.CLOSED,
        closedAt,
      } as never,
      {
        where: {
          id: conversationId,
          status: { [Op.in]: [SupportConversationStatus.WAITING_SUPPORT, SupportConversationStatus.WAITING_USER] },
        },
        transaction: txq,
        lock: txq ? 'FOR UPDATE' : undefined,
      } as never,
    );
    if (affected === 0) {
      // 已 CLOSED（幂等重放）或行缺失——读回既有值；缺失 → 抛可重试
      const row = await this.models.SupportConversationModel.findByPk(conversationId, {
        transaction: txq,
      } as never);
      if (row === null) {
        throw new SupportDomainError(SUP.SUPPORT_CONVERSATION_NOT_FOUND, `客服会话不存在：${conversationId}`);
      }
      // 已 CLOSED → 幂等静默返回既有值（不产生第二笔）
      if (row.status === SupportConversationStatus.CLOSED) {
        return row;
      }
      throw new SupportDomainError(SUP.STORAGE_UNAVAILABLE, '客服会话状态机转换失败（影响行数 0），请重试。', {
        retryable: true,
      });
    }
    const row = await this.models.SupportConversationModel.findByPk(conversationId, {
      transaction: txq,
    });
    if (row === null) {
      throw new SupportDomainError(SUP.SUPPORT_CONVERSATION_NOT_FOUND, `客服会话不存在：${conversationId}`);
    }
    return row;
  }

  async markConversationWaitingUser(conversationId: string, tx: Tx): Promise<SupportConversationModel> {
    const txq = txOf(tx);
    // WAITING_SUPPORT=1 → WAITING_USER=2（用户回复后客服侧进入待处理；
    // WAITING_USER=2 幂等静默；CLOSED=3 不可推进——where 限定 from = 1）
    const [affected] = await this.models.SupportConversationModel.update(
      { status: SupportConversationStatus.WAITING_USER } as never,
      {
        where: {
          id: conversationId,
          status: SupportConversationStatus.WAITING_SUPPORT,
        },
        transaction: txq,
        lock: txq ? 'FOR UPDATE' : undefined,
      } as never,
    );
    if (affected === 0) {
      // WAITING_USER 幂等重放 → 静默返回既有值
      const row = await this.models.SupportConversationModel.findByPk(conversationId, {
        transaction: txq,
      } as never);
      if (row === null) {
        throw new SupportDomainError(SUP.SUPPORT_CONVERSATION_NOT_FOUND, `客服会话不存在：${conversationId}`);
      }
      if (row.status === SupportConversationStatus.WAITING_USER) {
        return row;
      }
      // CLOSED=3 不可推进（防御性兜底）
      throw new SupportDomainError(SUP.STORAGE_UNAVAILABLE, '客服会话状态机转换失败（影响行数 0），请重试。', {
        retryable: true,
      });
    }
    const row = await this.models.SupportConversationModel.findByPk(conversationId, {
      transaction: txq,
    } as never);
    if (row === null) {
      throw new SupportDomainError(SUP.SUPPORT_CONVERSATION_NOT_FOUND, `客服会话不存在：${conversationId}`);
    }
    return row;
  }
}

// ---------------------------------------------------------------------------
// SupportMessageRepo（support_message）
// ---------------------------------------------------------------------------

/**
 * 客服消息仓储（SupportMessageRepo；Sequelize 实现）。
 * 追加（U(message_key) 幂等兜底 + 同事务更新会话未读计数 / last_message_at +
 * 同事务写 outbox `support.message` 行）+ 按 message_key 查（幂等重放）+
 * 按会话列出全部消息（id 升序，maxItems=1000）。
 */
export class SequelizeSupportMessageRepo implements SupportMessageRepo {
  constructor(private readonly models: SupportModels) {}

  async appendSupportMessage(input: {
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
  }): Promise<{ inserted: boolean; message: SupportMessageModel }> {
    const txq = txOf(input.tx);
    // 1. U(message_key) 幂等兜底：先读既有行，命中 → 返回（inserted: false）
    const existing = await this.models.SupportMessageModel.findOne({
      where: { messageKey: input.messageKey },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (existing !== null) {
      return { inserted: false, message: existing };
    }
    // 2. 写 support_message VISIBLE=1（BIGINT sender_user_id 经 as never 桥接；
    //    SYSTEM=3 → senderUserId=NULL）
    const message = (await this.models.SupportMessageModel.create(
      {
        supportConversationId: input.supportConversationId as never,
        messageKey: input.messageKey,
        senderUserId: input.senderUserId as never,
        senderType: input.senderType,
        messageType: input.messageType,
        bodyText: input.bodyText,
        assetId: input.assetId,
        status: SupportMessageStatus.VISIBLE,
      } as never,
      { transaction: txq } as never,
    )) as SupportMessageModel;
    // 3. 同事务更新会话未读计数 + last_message_at（§5.9 "未读计数与消息写入
    //    同事务更新"；INT UNSIGNED 计数列经 read-then-write 更新，避免
    //    依赖方言特定 Op（首版固定 1，登记决策点：可经配置注入））
    const now = new Date();
    const conv = await this.models.SupportConversationModel.findByPk(input.supportConversationId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (conv === null) {
      throw new SupportDomainError(SUP.SUPPORT_CONVERSATION_NOT_FOUND, `客服会话不存在：${input.supportConversationId}`);
    }
    const updates: Record<string, unknown> = { lastMessageAt: now };
    if (input.unreadSide === 'customer') {
      updates.userUnreadCount = (typeof conv.userUnreadCount === 'number' ? conv.userUnreadCount : 0) + 1; // 用户侧未读 +1
    } else if (input.unreadSide === 'support') {
      updates.supportUnreadCount = (typeof conv.supportUnreadCount === 'number' ? conv.supportUnreadCount : 0) + 1; // 客服侧未读 +1
    }
    // unreadSide === 'none'（SYSTEM 通知）：两侧均不计未读，仅更新 last_message_at
    await this.models.SupportConversationModel.update(
      updates as never,
      { where: { id: input.supportConversationId }, transaction: txq } as never,
    );
    // 4. 同事务写 outbox topic `support.message`（§6.3 outbox 权威；
    //    payload 脱敏最小负载，不含全文）
    await input.outbox.append({
      topic: 'support.message',
      userId: null, // 双端投递 /platform 与 /admin（§6.3 未闭环项：outbox worker 落地）
      payload: {
        messageId: message.id,
        conversationId: input.supportConversationId,
        senderType: input.senderType,
        messageType: input.messageType,
      },
      eventKey: `support:message:${input.messageKey}`,
    });
    return { inserted: true, message };
  }

  async findMessageByKey(messageKey: string, tx: Tx): Promise<SupportMessageModel | null> {
    const txq = txOf(tx);
    const row = await this.models.SupportMessageModel.findOne({
      where: { messageKey },
      transaction: txq,
    } as never);
    return row;
  }

  async listMessagesByConversation(conversationId: string, tx: Tx): Promise<SupportMessageModel[]> {
    const txq = txOf(tx);
    const rows = await this.models.SupportMessageModel.findAll({
      where: { supportConversationId: conversationId as never },
      order: [['id', 'ASC']],
      limit: 1000,
      transaction: txq,
    } as never);
    return rows;
  }
}
