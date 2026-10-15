import { SupportConversationStatus, SupportSenderType } from '@gameing/contracts/support';
import type { CreateSupportConversationRequestDto, SendSupportMessageRequestDto, SupportConversationDto, SupportMessageDto } from '@gameing/contracts/support';
import type { LocalSupportConversation, LocalSupportMessage } from '../database';
import { openBrowserDevelopmentDatabase, type BrowserDevelopmentDatabase } from '../database';
import { SupportRepositoryConflictError, type SupportRepository } from '../../support/support-application';
import { statusAfterCustomerClose, statusAfterCustomerReply } from '../../support/support-domain';

function toConversation(row: LocalSupportConversation): SupportConversationDto {
  return {
    conversationId: row.conversationId,
    categoryType: row.categoryType,
    subject: row.subject,
    status: row.status,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMessage(row: LocalSupportMessage): SupportMessageDto {
  return {
    messageId: row.messageId,
    conversationId: row.conversationId,
    messageKey: row.messageKey,
    senderUserId: row.senderUserId,
    senderType: row.senderType,
    bodyText: row.bodyText,
    createdAt: row.createdAt,
  };
}

export class IndexedDbSupportRepository implements SupportRepository {
  constructor(private readonly database: BrowserDevelopmentDatabase) {}

  static async create(): Promise<IndexedDbSupportRepository> {
    return new IndexedDbSupportRepository(await openBrowserDevelopmentDatabase());
  }

  async listConversations(userId: string): Promise<SupportConversationDto[]> {
    const rows = await this.database.getAllFromIndex('support_conversations', 'by-user-updated', IDBKeyRange.bound([userId, ''], [userId, '\uffff']));
    return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(toConversation);
  }

  async listMessages(userId: string, conversationId: string): Promise<{ conversation: SupportConversationDto; messages: SupportMessageDto[] } | null> {
    const conversation = await this.database.get('support_conversations', conversationId);
    if (!conversation || conversation.userId !== userId) return null;
    const rows = await this.database.getAllFromIndex('support_messages', 'by-conversation', IDBKeyRange.bound([conversationId, ''], [conversationId, '\uffff']));
    return { conversation: toConversation(conversation), messages: rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map(toMessage) };
  }

  async createConversation(userId: string, request: CreateSupportConversationRequestDto): Promise<{ conversation: SupportConversationDto; firstMessage: SupportMessageDto }> {
    const transaction = this.database.transaction(['settings', 'support_conversations', 'support_messages'], 'readwrite');
    const conversations = transaction.objectStore('support_conversations');
    const messages = transaction.objectStore('support_messages');
    const duplicate = await messages.index('by-message-key').get(request.messageKey);
    if (duplicate) {
      const existing = await conversations.get(duplicate.conversationId);
      if (!existing || existing.userId !== userId) {
        await transaction.done;
        throw new SupportRepositoryConflictError();
      }
      await transaction.done;
      return { conversation: toConversation(existing), firstMessage: toMessage(duplicate) };
    }
    const createdAt = new Date().toISOString();
    const allocateId = async (): Promise<string> => {
      const settings = transaction.objectStore('settings');
      const current = await settings.get('next-id');
      const id = typeof current?.value === 'string' ? BigInt(current.value) : 1n;
      await settings.put({ key: 'next-id', value: (id + 1n).toString() });
      return id.toString();
    };
    const conversation: LocalSupportConversation = {
      conversationId: await allocateId(), userId, categoryType: request.categoryType,
      subject: request.subject.trim(), status: SupportConversationStatus.WAITING_SUPPORT,
      lastMessageAt: createdAt, createdAt, updatedAt: createdAt,
    };
    const message: LocalSupportMessage = {
      messageId: await allocateId(), conversationId: conversation.conversationId,
      messageKey: request.messageKey, senderUserId: userId,
      senderType: SupportSenderType.CUSTOMER, bodyText: request.bodyText.trim(), createdAt,
    };
    await conversations.put(conversation);
    await messages.put(message);
    await transaction.done;
    return { conversation: toConversation(conversation), firstMessage: toMessage(message) };
  }

  async sendMessage(userId: string, conversationId: string, request: SendSupportMessageRequestDto): Promise<SupportMessageDto | 'NOT_FOUND' | 'CLOSED'> {
    const transaction = this.database.transaction(['settings', 'support_conversations', 'support_messages'], 'readwrite');
    const conversations = transaction.objectStore('support_conversations');
    const messages = transaction.objectStore('support_messages');
    const duplicate = await messages.index('by-message-key').get(request.messageKey);
    if (duplicate) {
      const owner = await conversations.get(duplicate.conversationId);
      if (!owner || owner.userId !== userId || duplicate.conversationId !== conversationId) {
        await transaction.done;
        throw new SupportRepositoryConflictError();
      }
      await transaction.done;
      return toMessage(duplicate);
    }
    const conversation = await conversations.get(conversationId);
    if (!conversation || conversation.userId !== userId) {
      await transaction.done;
      return 'NOT_FOUND';
    }
    const nextStatus = statusAfterCustomerReply(conversation.status);
    if (nextStatus === null) {
      await transaction.done;
      return 'CLOSED';
    }
    const settings = transaction.objectStore('settings');
    const current = await settings.get('next-id');
    const id = typeof current?.value === 'string' ? BigInt(current.value) : 1n;
    await settings.put({ key: 'next-id', value: (id + 1n).toString() });
    const createdAt = new Date().toISOString();
    const message: LocalSupportMessage = {
      messageId: id.toString(), conversationId, messageKey: request.messageKey,
      senderUserId: userId, senderType: SupportSenderType.CUSTOMER,
      bodyText: request.bodyText.trim(), createdAt,
    };
    await messages.put(message);
    await conversations.put({ ...conversation, status: nextStatus, lastMessageAt: createdAt, updatedAt: createdAt });
    await transaction.done;
    return toMessage(message);
  }

  async closeConversation(userId: string, conversationId: string): Promise<SupportConversationDto | null> {
    const transaction = this.database.transaction('support_conversations', 'readwrite');
    const store = transaction.store;
    const conversation = await store.get(conversationId);
    if (!conversation || conversation.userId !== userId) {
      await transaction.done;
      return null;
    }
    if (conversation.status !== SupportConversationStatus.CLOSED) {
      const now = new Date().toISOString();
      await store.put({ ...conversation, status: statusAfterCustomerClose(), updatedAt: now });
      await transaction.done;
      return toConversation({ ...conversation, status: statusAfterCustomerClose(), updatedAt: now });
    }
    await transaction.done;
    return toConversation(conversation);
  }
}
