import {
  SupportCategoryType,
  SupportConversationStatus,
  SupportSenderType,
  type SupportDeskConversationDto,
  type SupportDeskDetailResponseDto,
  type SupportDeskListResponseDto,
  type SupportDeskQueryDto,
  type SupportMessageDto,
} from '@gameing/contracts/support';
import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase } from '../browser-development-database';
import type { SupportDeskRepositoryPort } from './support-desk-application';
import { canClaimConversation, statusAfterSupportReopen, statusAfterSupportReply, statusAfterSupportResolve } from './support-desk-domain';

const DEMO_ACTOR_ID = '90001';
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const INITIAL_CONVERSATIONS: SupportDeskConversationDto[] = [
  { conversation: { conversationId: '93001', categoryType: SupportCategoryType.ACCOUNT, subject: '更换设备后无法登录', status: SupportConversationStatus.WAITING_SUPPORT, lastMessageAt: minutesAgo(35), createdAt: minutesAgo(35), updatedAt: minutesAgo(35) }, customerUserId: '95001', customerDisplayName: '林先生', assignedAdminUserId: null },
  { conversation: { conversationId: '93002', categoryType: SupportCategoryType.PAYMENT, subject: '充值订单状态咨询', status: SupportConversationStatus.WAITING_USER, lastMessageAt: minutesAgo(50), createdAt: minutesAgo(65), updatedAt: minutesAgo(50) }, customerUserId: '95002', customerDisplayName: '小雨', assignedAdminUserId: DEMO_ACTOR_ID },
  { conversation: { conversationId: '93003', categoryType: SupportCategoryType.GAME, subject: '十三张牌局结果反馈', status: SupportConversationStatus.CLOSED, lastMessageAt: minutesAgo(1400), createdAt: minutesAgo(1418), updatedAt: minutesAgo(1400) }, customerUserId: '95003', customerDisplayName: '周先生', assignedAdminUserId: DEMO_ACTOR_ID },
];

const INITIAL_MESSAGES: SupportMessageDto[] = [
  { messageId: '93101', conversationId: '93001', messageKey: 'a1111111-1111-4111-8111-111111111111', senderUserId: '95001', senderType: SupportSenderType.CUSTOMER, bodyText: '更换手机后登录一直提示需要验证设备，请问应该如何恢复？', createdAt: minutesAgo(35) },
  { messageId: '93102', conversationId: '93002', messageKey: 'a2222222-2222-4222-8222-222222222222', senderUserId: '95002', senderType: SupportSenderType.CUSTOMER, bodyText: '订单显示处理中已经一段时间了。', createdAt: minutesAgo(65) },
  { messageId: '93103', conversationId: '93002', messageKey: 'a3333333-3333-4333-8333-333333333333', senderUserId: DEMO_ACTOR_ID, senderType: SupportSenderType.ADMIN, bodyText: '我先帮你核对订单状态，请不要在聊天中发送支付密码或验证码。', createdAt: minutesAgo(50) },
  { messageId: '93104', conversationId: '93003', messageKey: 'a4444444-4444-4444-8444-444444444444', senderUserId: '95003', senderType: SupportSenderType.CUSTOMER, bodyText: '我想了解这局的结算结果。', createdAt: minutesAgo(1418) },
];

export class IndexedDbSupportDeskAdapter implements SupportDeskRepositoryPort {
  constructor(private readonly databaseName = ADMIN_DEVELOPMENT_DATABASE) {}

  async list(query: SupportDeskQueryDto): Promise<SupportDeskListResponseDto> {
    const db = await openAdminDevelopmentDatabase(this.databaseName);
    await this.ensureSeed(db);
    const keyword = query.keyword?.trim().toLocaleLowerCase();
    const all = (await db.getAll('support_desk_conversations'))
      .filter((item) => query.status === undefined || item.conversation.status === query.status)
      .filter((item) => !keyword || `${item.conversation.subject} ${item.customerDisplayName} ${item.customerUserId} ${item.conversation.conversationId}`.toLocaleLowerCase().includes(keyword))
      .sort((a, b) => b.conversation.updatedAt.localeCompare(a.conversation.updatedAt) || b.conversation.conversationId.localeCompare(a.conversation.conversationId));
    const pageSize = query.pageSize ?? 20;
    const start = query.cursor ? Number(query.cursor) - 1 : 0;
    const items = all.slice(start, start + pageSize);
    const next = start + items.length;
    return { items, total: all.length, nextCursor: next < all.length ? String(next + 1) : null };
  }

  async detail(conversationId: string): Promise<SupportDeskDetailResponseDto | null> {
    const db = await openAdminDevelopmentDatabase(this.databaseName);
    await this.ensureSeed(db);
    const item = await db.get('support_desk_conversations', conversationId);
    return item ? this.readDetail(db, item) : null;
  }

  async claim(conversationId: string, actorUserId: string, requestKey: string): Promise<SupportDeskDetailResponseDto | 'NOT_FOUND' | 'CLOSED' | 'ASSIGNED_TO_OTHER' | 'REQUEST_KEY_REUSED'> {
    return this.applyStatusAction(conversationId, actorUserId, requestKey, 'CLAIM');
  }

  async reply(conversationId: string, actorUserId: string, request: { bodyText: string; messageKey: string }): Promise<SupportDeskDetailResponseDto | 'NOT_FOUND' | 'CLOSED' | 'ASSIGNED_TO_OTHER' | 'REQUEST_KEY_REUSED'> {
    const db = await openAdminDevelopmentDatabase(this.databaseName);
    await this.ensureSeed(db);
    const transaction = db.transaction(['support_desk_conversations', 'support_desk_messages'], 'readwrite');
    const conversations = transaction.objectStore('support_desk_conversations');
    const messages = transaction.objectStore('support_desk_messages');
    const previous = await messages.index('by-message-key').get(request.messageKey);
    if (previous) {
      const owner = await conversations.get(previous.conversationId);
      await transaction.done;
      if (previous.conversationId !== conversationId || previous.senderUserId !== actorUserId || previous.bodyText !== request.bodyText.trim() || !owner) return 'REQUEST_KEY_REUSED';
      return this.detail(conversationId) as Promise<SupportDeskDetailResponseDto>;
    }
    const item = await conversations.get(conversationId);
    if (!item) { await transaction.done; return 'NOT_FOUND'; }
    if (item.assignedAdminUserId !== actorUserId) { await transaction.done; return item.assignedAdminUserId === null ? 'ASSIGNED_TO_OTHER' : 'ASSIGNED_TO_OTHER'; }
    const nextStatus = statusAfterSupportReply(item.conversation.status);
    if (nextStatus === null) { await transaction.done; return 'CLOSED'; }
    const createdAt = new Date().toISOString();
    const message: SupportMessageDto = { messageId: newLocalId(), conversationId, messageKey: request.messageKey, senderUserId: actorUserId, senderType: SupportSenderType.ADMIN, bodyText: request.bodyText.trim(), createdAt };
    await messages.add(message);
    await conversations.put({ ...item, conversation: { ...item.conversation, status: nextStatus, lastMessageAt: createdAt, updatedAt: createdAt } });
    await transaction.done;
    return this.detail(conversationId) as Promise<SupportDeskDetailResponseDto>;
  }

  async resolve(conversationId: string, actorUserId: string, requestKey: string): Promise<SupportDeskDetailResponseDto | 'NOT_FOUND' | 'CLOSED' | 'ASSIGNED_TO_OTHER' | 'REQUEST_KEY_REUSED'> {
    return this.applyStatusAction(conversationId, actorUserId, requestKey, 'RESOLVE');
  }

  async reopen(conversationId: string, actorUserId: string, requestKey: string): Promise<SupportDeskDetailResponseDto | 'NOT_FOUND' | 'CLOSED' | 'ASSIGNED_TO_OTHER' | 'REQUEST_KEY_REUSED'> {
    return this.applyStatusAction(conversationId, actorUserId, requestKey, 'REOPEN');
  }

  private async applyStatusAction(conversationId: string, actorUserId: string, requestKey: string, action: 'CLAIM' | 'RESOLVE' | 'REOPEN'): Promise<SupportDeskDetailResponseDto | 'NOT_FOUND' | 'CLOSED' | 'ASSIGNED_TO_OTHER' | 'REQUEST_KEY_REUSED'> {
    const db = await openAdminDevelopmentDatabase(this.databaseName);
    await this.ensureSeed(db);
    const transaction = db.transaction(['support_desk_conversations', 'support_desk_command_receipts'], 'readwrite');
    const store = transaction.objectStore('support_desk_conversations');
    const receipts = transaction.objectStore('support_desk_command_receipts');
    const previous = await receipts.get(requestKey);
    if (previous) {
      await transaction.done;
      if (previous.conversationId !== conversationId || previous.actorUserId !== actorUserId || previous.action !== action) return 'REQUEST_KEY_REUSED';
      return this.detail(conversationId) as Promise<SupportDeskDetailResponseDto>;
    }
    const item = await store.get(conversationId);
    if (!item) { await transaction.done; return 'NOT_FOUND'; }
    if (action === 'CLAIM' && !canClaimConversation(item, actorUserId)) {
      await transaction.done;
      return item.conversation.status === SupportConversationStatus.CLOSED ? 'CLOSED' : 'ASSIGNED_TO_OTHER';
    }
    if (action !== 'CLAIM' && item.assignedAdminUserId !== actorUserId) { await transaction.done; return 'ASSIGNED_TO_OTHER'; }
    const now = new Date().toISOString();
    let updated = item;
    if (action === 'CLAIM' && item.assignedAdminUserId === null) {
      updated = { ...item, assignedAdminUserId: actorUserId, conversation: { ...item.conversation, updatedAt: now } };
    } else if (action === 'RESOLVE' && item.conversation.status !== SupportConversationStatus.CLOSED) {
      updated = { ...item, conversation: { ...item.conversation, status: statusAfterSupportResolve(), updatedAt: now } };
    } else if (action === 'REOPEN') {
      const next = statusAfterSupportReopen(item.conversation.status);
      if (next !== null) updated = { ...item, conversation: { ...item.conversation, status: next, updatedAt: now } };
    }
    if (updated !== item) await store.put(updated);
    await receipts.add({ requestKey, conversationId, actorUserId, action, createdAt: now });
    await transaction.done;
    return this.detail(conversationId) as Promise<SupportDeskDetailResponseDto>;
  }

  private async readDetail(db: Awaited<ReturnType<typeof openAdminDevelopmentDatabase>>, item: SupportDeskConversationDto): Promise<SupportDeskDetailResponseDto> {
    const messages = await db.getAllFromIndex('support_desk_messages', 'by-conversation-created', IDBKeyRange.bound([item.conversation.conversationId, ''], [item.conversation.conversationId, '\uffff']));
    return { item, messages: messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId)) };
  }

  private async ensureSeed(db: Awaited<ReturnType<typeof openAdminDevelopmentDatabase>>): Promise<void> {
    if (await db.count('support_desk_conversations') > 0) return;
    const transaction = db.transaction(['support_desk_conversations', 'support_desk_messages'], 'readwrite');
    for (const item of INITIAL_CONVERSATIONS) await transaction.objectStore('support_desk_conversations').put(item);
    for (const message of INITIAL_MESSAGES) await transaction.objectStore('support_desk_messages').put(message);
    await transaction.done;
  }
}

function newLocalId(): string {
  return (BigInt(Date.now()) * 1_000_000n + BigInt(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000)).toString();
}
