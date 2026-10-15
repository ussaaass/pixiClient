import { Value } from '@sinclair/typebox/value';
import {
  CreateSupportConversationRequestSchema,
  SendSupportMessageRequestSchema,
  SupportConversationDtoSchema,
  SupportConversationListResponseSchema,
  SupportMessageDtoSchema,
  SupportMessagesResponseSchema,
  type CreateSupportConversationRequestDto,
  type SendSupportMessageRequestDto,
  type SupportConversationDto,
  type SupportMessageDto,
} from '@gameing/contracts/support';

export type SupportFailure = 'INVALID_REQUEST' | 'CONVERSATION_NOT_FOUND' | 'CONVERSATION_CLOSED' | 'IDEMPOTENCY_KEY_REUSED' | 'INVALID_RESPONSE';
export type SupportResult<T> = { ok: true; value: T } | { ok: false; code: SupportFailure };
export class SupportRepositoryConflictError extends Error {
  constructor() { super('IDEMPOTENCY_KEY_REUSED'); }
}

export interface SupportRepository {
  listConversations(userId: string): Promise<SupportConversationDto[]>;
  listMessages(userId: string, conversationId: string): Promise<{ conversation: SupportConversationDto; messages: SupportMessageDto[] } | null>;
  createConversation(userId: string, request: CreateSupportConversationRequestDto): Promise<{ conversation: SupportConversationDto; firstMessage: SupportMessageDto }>;
  sendMessage(userId: string, conversationId: string, request: SendSupportMessageRequestDto): Promise<SupportMessageDto | 'NOT_FOUND' | 'CLOSED'>;
  closeConversation(userId: string, conversationId: string): Promise<SupportConversationDto | null>;
}

export class SupportUseCases {
  constructor(private readonly repository: SupportRepository) {}

  async listConversations(userId: string): Promise<SupportResult<SupportConversationDto[]>> {
    const conversations = await this.repository.listConversations(userId);
    return Value.Check(SupportConversationListResponseSchema, conversations) ? { ok: true, value: conversations } : { ok: false, code: 'INVALID_RESPONSE' };
  }

  async listMessages(userId: string, conversationId: string): Promise<SupportResult<{ conversation: SupportConversationDto; messages: SupportMessageDto[] }>> {
    const result = await this.repository.listMessages(userId, conversationId);
    if (!result) return { ok: false, code: 'CONVERSATION_NOT_FOUND' };
    return Value.Check(SupportMessagesResponseSchema, result) ? { ok: true, value: result } : { ok: false, code: 'INVALID_RESPONSE' };
  }

  async createConversation(userId: string, request: CreateSupportConversationRequestDto): Promise<SupportResult<{ conversation: SupportConversationDto; firstMessage: SupportMessageDto }>> {
    const normalized = { ...request, subject: request.subject.trim(), bodyText: request.bodyText.trim() };
    if (!Value.Check(CreateSupportConversationRequestSchema, normalized)) return { ok: false, code: 'INVALID_REQUEST' };
    let result: { conversation: SupportConversationDto; firstMessage: SupportMessageDto };
    try { result = await this.repository.createConversation(userId, normalized); }
    catch (error) { if (error instanceof SupportRepositoryConflictError) return { ok: false, code: 'IDEMPOTENCY_KEY_REUSED' }; throw error; }
    return Value.Check(SupportConversationDtoSchema, result.conversation) && Value.Check(SupportMessageDtoSchema, result.firstMessage)
      ? { ok: true, value: result }
      : { ok: false, code: 'INVALID_RESPONSE' };
  }

  async sendMessage(userId: string, conversationId: string, request: SendSupportMessageRequestDto): Promise<SupportResult<SupportMessageDto>> {
    const normalized = { ...request, bodyText: request.bodyText.trim() };
    if (!Value.Check(SendSupportMessageRequestSchema, normalized)) return { ok: false, code: 'INVALID_REQUEST' };
    let result: SupportMessageDto | 'NOT_FOUND' | 'CLOSED';
    try { result = await this.repository.sendMessage(userId, conversationId, normalized); }
    catch (error) { if (error instanceof SupportRepositoryConflictError) return { ok: false, code: 'IDEMPOTENCY_KEY_REUSED' }; throw error; }
    if (result === 'NOT_FOUND') return { ok: false, code: 'CONVERSATION_NOT_FOUND' };
    if (result === 'CLOSED') return { ok: false, code: 'CONVERSATION_CLOSED' };
    return Value.Check(SupportMessageDtoSchema, result) ? { ok: true, value: result } : { ok: false, code: 'INVALID_RESPONSE' };
  }

  async closeConversation(userId: string, conversationId: string): Promise<SupportResult<SupportConversationDto>> {
    const conversation = await this.repository.closeConversation(userId, conversationId);
    return conversation && Value.Check(SupportConversationDtoSchema, conversation)
      ? { ok: true, value: conversation }
      : { ok: false, code: 'CONVERSATION_NOT_FOUND' };
  }
}

export interface SupportClientApiPort {
  listConversations(accessToken: string): Promise<SupportConversationDto[]>;
  listMessages(conversationId: string, accessToken: string): Promise<{ conversation: SupportConversationDto; messages: SupportMessageDto[] }>;
  createConversation(request: CreateSupportConversationRequestDto, accessToken: string): Promise<{ conversation: SupportConversationDto; firstMessage: SupportMessageDto }>;
  sendMessage(conversationId: string, request: SendSupportMessageRequestDto, accessToken: string): Promise<SupportMessageDto>;
  closeConversation(conversationId: string, accessToken: string): Promise<{ conversation: SupportConversationDto }>;
}

export interface SupportClientApplication {
  listConversations(): Promise<SupportResult<SupportConversationDto[]>>;
  listMessages(conversationId: string): Promise<SupportResult<{ conversation: SupportConversationDto; messages: SupportMessageDto[] }>>;
  createConversation(request: CreateSupportConversationRequestDto): Promise<SupportResult<{ conversation: SupportConversationDto; firstMessage: SupportMessageDto }>>;
  sendMessage(conversationId: string, request: SendSupportMessageRequestDto): Promise<SupportResult<SupportMessageDto>>;
  closeConversation(conversationId: string): Promise<SupportResult<SupportConversationDto>>;
}

export function createSupportClientApplication(api: SupportClientApiPort, withAccessToken: <T>(operation: (token: string) => Promise<T>) => Promise<T>): SupportClientApplication {
  return {
    async listConversations() {
      const value = await withAccessToken((token) => api.listConversations(token));
      return Value.Check(SupportConversationListResponseSchema, value) ? { ok: true, value } : { ok: false, code: 'INVALID_RESPONSE' };
    },
    async listMessages(conversationId) {
      const value = await withAccessToken((token) => api.listMessages(conversationId, token));
      return Value.Check(SupportMessagesResponseSchema, value) ? { ok: true, value } : { ok: false, code: 'INVALID_RESPONSE' };
    },
    async createConversation(request) {
      const normalized = { ...request, subject: request.subject.trim(), bodyText: request.bodyText.trim() };
      if (!Value.Check(CreateSupportConversationRequestSchema, normalized)) return { ok: false, code: 'INVALID_REQUEST' };
      const value = await withAccessToken((token) => api.createConversation(normalized, token));
      return Value.Check(SupportConversationDtoSchema, value.conversation) && Value.Check(SupportMessageDtoSchema, value.firstMessage)
        ? { ok: true, value }
        : { ok: false, code: 'INVALID_RESPONSE' };
    },
    async sendMessage(conversationId, request) {
      const normalized = { ...request, bodyText: request.bodyText.trim() };
      if (!Value.Check(SendSupportMessageRequestSchema, normalized)) return { ok: false, code: 'INVALID_REQUEST' };
      const value = await withAccessToken((token) => api.sendMessage(conversationId, normalized, token));
      return Value.Check(SupportMessageDtoSchema, value) ? { ok: true, value } : { ok: false, code: 'INVALID_RESPONSE' };
    },
    async closeConversation(conversationId) {
      const value = await withAccessToken((token) => api.closeConversation(conversationId, token));
      return Value.Check(SupportConversationDtoSchema, value.conversation) ? { ok: true, value: value.conversation } : { ok: false, code: 'INVALID_RESPONSE' };
    },
  };
}
