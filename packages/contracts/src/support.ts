import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const BigIdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const MessageKeySchema = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
const TimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });

export const SupportCategoryType = { ACCOUNT: 1, PAYMENT: 2, WITHDRAWAL: 3, GAME: 4, OTHER: 5 } as const;
export const SupportConversationStatus = { WAITING_SUPPORT: 1, WAITING_USER: 2, CLOSED: 3 } as const;
export const SupportSenderType = { CUSTOMER: 1, ADMIN: 2, SYSTEM: 3 } as const;

const CategorySchema = Type.Union(Object.values(SupportCategoryType).map((value) => Type.Literal(value)));
const StatusSchema = Type.Union(Object.values(SupportConversationStatus).map((value) => Type.Literal(value)));
const SenderTypeSchema = Type.Union(Object.values(SupportSenderType).map((value) => Type.Literal(value)));

export const SupportConversationDtoSchema = Type.Object({
  conversationId: BigIdSchema,
  categoryType: CategorySchema,
  subject: Type.String({ minLength: 3, maxLength: 160 }),
  status: StatusSchema,
  lastMessageAt: Type.Union([TimestampSchema, Type.Null()]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}, { additionalProperties: false });

export const SupportMessageDtoSchema = Type.Object({
  messageId: BigIdSchema,
  conversationId: BigIdSchema,
  messageKey: MessageKeySchema,
  senderUserId: Type.Union([BigIdSchema, Type.Null()]),
  senderType: SenderTypeSchema,
  bodyText: Type.String({ minLength: 1, maxLength: 4000 }),
  createdAt: TimestampSchema,
}, { additionalProperties: false });

export const CreateSupportConversationRequestSchema = Type.Object({
  categoryType: CategorySchema,
  subject: Type.String({ minLength: 3, maxLength: 160 }),
  bodyText: Type.String({ minLength: 1, maxLength: 4000 }),
  messageKey: MessageKeySchema,
}, { additionalProperties: false });

export const SendSupportMessageRequestSchema = Type.Object({
  bodyText: Type.String({ minLength: 1, maxLength: 4000 }),
  messageKey: MessageKeySchema,
}, { additionalProperties: false });
export const EmptySupportRequestSchema = Type.Object({}, { additionalProperties: false });

export const SupportConversationListResponseSchema = Type.Array(SupportConversationDtoSchema, { maxItems: 1000 });
export const SupportConversationCreatedResponseSchema = Type.Object({ conversation: SupportConversationDtoSchema, firstMessage: SupportMessageDtoSchema }, { additionalProperties: false });
export const SupportMessagesResponseSchema = Type.Object({ conversation: SupportConversationDtoSchema, messages: Type.Array(SupportMessageDtoSchema, { maxItems: 1000 }) }, { additionalProperties: false });
export const SupportConversationClosedResponseSchema = Type.Object({ conversation: SupportConversationDtoSchema }, { additionalProperties: false });

// Admin's support desk uses the same conversation/message DTOs as the player
// client and adds only the minimum desk projection needed for queue ownership.
export const SupportDeskConversationDtoSchema = Type.Object({
  conversation: SupportConversationDtoSchema,
  customerUserId: BigIdSchema,
  customerDisplayName: Type.String({ minLength: 1, maxLength: 80 }),
  assignedAdminUserId: Type.Union([BigIdSchema, Type.Null()]),
}, { additionalProperties: false });
export const SupportDeskQuerySchema = Type.Object({
  status: Type.Optional(StatusSchema),
  keyword: Type.Optional(Type.String({ maxLength: 80 })),
  cursor: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,8}$' })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
export const SupportDeskListResponseSchema = Type.Object({
  items: Type.Array(SupportDeskConversationDtoSchema, { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  nextCursor: Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,8}$' }), Type.Null()]),
}, { additionalProperties: false });
export const SupportDeskDetailResponseSchema = Type.Object({
  item: SupportDeskConversationDtoSchema,
  messages: Type.Array(SupportMessageDtoSchema, { maxItems: 1000 }),
}, { additionalProperties: false });
export const SupportDeskActionRequestSchema = Type.Object({ requestKey: MessageKeySchema }, { additionalProperties: false });
export const SupportDeskReplyRequestSchema = SendSupportMessageRequestSchema;
export const SupportDeskEndpoint = {
  list: { method: 'GET', path: '/api/v1/admin/support/conversations', response: SupportDeskListResponseSchema, successStatus: 200 },
  detail: { method: 'GET', path: '/api/v1/admin/support/conversations/:conversationId', response: SupportDeskDetailResponseSchema, successStatus: 200 },
  claim: { method: 'POST', path: '/api/v1/admin/support/conversations/:conversationId/claim', request: SupportDeskActionRequestSchema, response: SupportDeskDetailResponseSchema, successStatus: 200 },
  reply: { method: 'POST', path: '/api/v1/admin/support/conversations/:conversationId/messages', request: SupportDeskReplyRequestSchema, response: SupportDeskDetailResponseSchema, successStatus: 200 },
  resolve: { method: 'POST', path: '/api/v1/admin/support/conversations/:conversationId/resolve', request: SupportDeskActionRequestSchema, response: SupportDeskDetailResponseSchema, successStatus: 200 },
  reopen: { method: 'POST', path: '/api/v1/admin/support/conversations/:conversationId/reopen', request: SupportDeskActionRequestSchema, response: SupportDeskDetailResponseSchema, successStatus: 200 },
} as const;

export const SupportEndpoint = {
  listConversations: { method: 'GET', path: '/api/v1/me/support/conversations', response: SupportConversationListResponseSchema, successStatus: 200 },
  createConversation: { method: 'POST', path: '/api/v1/me/support/conversations', request: CreateSupportConversationRequestSchema, response: SupportConversationCreatedResponseSchema, successStatus: 201 },
  listMessages: { method: 'GET', path: '/api/v1/me/support/conversations/:conversationId/messages', response: SupportMessagesResponseSchema, successStatus: 200 },
  sendMessage: { method: 'POST', path: '/api/v1/me/support/conversations/:conversationId/messages', request: SendSupportMessageRequestSchema, response: SupportMessageDtoSchema, successStatus: 201 },
  closeConversation: { method: 'POST', path: '/api/v1/me/support/conversations/:conversationId/close', request: EmptySupportRequestSchema, response: SupportConversationClosedResponseSchema, successStatus: 200 },
} as const;

export type SupportConversationDto = Static<typeof SupportConversationDtoSchema>;
export type SupportMessageDto = Static<typeof SupportMessageDtoSchema>;
export type CreateSupportConversationRequestDto = Static<typeof CreateSupportConversationRequestSchema>;
export type SendSupportMessageRequestDto = Static<typeof SendSupportMessageRequestSchema>;
export type SupportDeskConversationDto = Static<typeof SupportDeskConversationDtoSchema>;
export type SupportDeskQueryDto = Static<typeof SupportDeskQuerySchema>;
export type SupportDeskListResponseDto = Static<typeof SupportDeskListResponseSchema>;
export type SupportDeskDetailResponseDto = Static<typeof SupportDeskDetailResponseSchema>;
export type SupportDeskActionRequestDto = Static<typeof SupportDeskActionRequestSchema>;
export type SupportDeskReplyRequestDto = Static<typeof SupportDeskReplyRequestSchema>;
