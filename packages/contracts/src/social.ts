import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const BigIdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const TopicKeySchema = Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,47}$' });
const UtcTimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });

export const SocialContentStatus = {
  PUBLISHED: 'PUBLISHED',
  PENDING_REVIEW: 'PENDING_REVIEW',
  HIDDEN: 'HIDDEN',
} as const;

export const SocialModerationResourceType = { POST: 'POST', REPLY: 'REPLY' } as const;
export const SocialModerationCaseStatus = { OPEN: 1, RESOLVED: 2, DISMISSED: 3 } as const;
export const SocialModerationAction = { APPROVE: 'APPROVE', HIDE: 'HIDE', RESTORE: 'RESTORE', DISMISS: 'DISMISS' } as const;
export type SocialModerationActionCode = (typeof SocialModerationAction)[keyof typeof SocialModerationAction];
const SocialModerationResourceSchema = Type.Union([Type.Literal('POST'), Type.Literal('REPLY')]);
const SocialModerationCaseStatusSchema = Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]);
const SocialModerationActionSchema = Type.Union([Type.Literal('APPROVE'), Type.Literal('HIDE'), Type.Literal('RESTORE'), Type.Literal('DISMISS')]);
const SocialModerationRequestKeySchema = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });

export const SocialModerationCaseDtoSchema = Type.Object({
  caseId: BigIdSchema,
  resourceType: SocialModerationResourceSchema,
  resourceId: BigIdSchema,
  topicTitle: Type.String({ minLength: 1, maxLength: 48 }),
  contentTitle: Type.String({ maxLength: 80 }),
  contentBody: Type.String({ minLength: 1, maxLength: 2000 }),
  authorLabel: Type.String({ minLength: 1, maxLength: 48 }),
  contentStatus: Type.Union([Type.Literal('PUBLISHED'), Type.Literal('PENDING_REVIEW'), Type.Literal('HIDDEN')]),
  caseStatus: SocialModerationCaseStatusSchema,
  reasonCode: Type.String({ minLength: 1, maxLength: 48 }),
  reporterCount: Type.Integer({ minimum: 1 }),
  reportSummary: Type.String({ maxLength: 300 }),
  agentDomainId: Type.Union([BigIdSchema, Type.Null()]),
  createdAt: UtcTimestampSchema,
}, { additionalProperties: false });
export const SocialModerationQuerySchema = Type.Object({
  resourceType: Type.Optional(SocialModerationResourceSchema),
  caseStatus: Type.Optional(SocialModerationCaseStatusSchema),
  keyword: Type.Optional(Type.String({ maxLength: 80 })),
  cursor: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,8}$' })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
export const SocialModerationListResponseSchema = Type.Object({
  items: Type.Array(SocialModerationCaseDtoSchema, { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  nextCursor: Type.Union([Type.String({ pattern: '^[1-9][0-9]{0,8}$' }), Type.Null()]),
}, { additionalProperties: false });
export const SocialModerationDecisionRequestSchema = Type.Object({
  action: SocialModerationActionSchema,
  reason: Type.String({ minLength: 3, maxLength: 500 }),
  requestKey: SocialModerationRequestKeySchema,
}, { additionalProperties: false });
export const SocialModerationAuditDtoSchema = Type.Object({
  auditId: BigIdSchema,
  caseId: BigIdSchema,
  action: SocialModerationActionSchema,
  reviewerAdminUserId: BigIdSchema,
  reason: Type.String({ minLength: 3, maxLength: 500 }),
  previousStatus: Type.Union([Type.Literal('PUBLISHED'), Type.Literal('PENDING_REVIEW'), Type.Literal('HIDDEN')]),
  nextStatus: Type.Union([Type.Literal('PUBLISHED'), Type.Literal('PENDING_REVIEW'), Type.Literal('HIDDEN')]),
  createdAt: UtcTimestampSchema,
}, { additionalProperties: false });
export const SocialModerationAuditListResponseSchema = Type.Array(SocialModerationAuditDtoSchema, { maxItems: 100 });
export const SocialModerationDecisionResponseSchema = Type.Object({ item: SocialModerationCaseDtoSchema, audit: SocialModerationAuditDtoSchema }, { additionalProperties: false });
export const SocialModerationEndpoint = {
  list: { method: 'GET', path: '/api/v1/admin/social/moderation-cases', response: SocialModerationListResponseSchema, successStatus: 200 },
  audits: { method: 'GET', path: '/api/v1/admin/social/moderation-cases/:caseId/audits', response: SocialModerationAuditListResponseSchema, successStatus: 200 },
  decide: { method: 'POST', path: '/api/v1/admin/social/moderation-cases/:caseId/decisions', request: SocialModerationDecisionRequestSchema, response: SocialModerationDecisionResponseSchema, successStatus: 200 },
} as const;

export const SocialTopicDtoSchema = Type.Object({
  topicId: BigIdSchema,
  topicKey: TopicKeySchema,
  title: Type.String({ minLength: 1, maxLength: 48 }),
  description: Type.String({ maxLength: 160 }),
  status: Type.Literal('ACTIVE'),
}, { additionalProperties: false });

export const SocialPostDtoSchema = Type.Object({
  postId: BigIdSchema,
  topicId: BigIdSchema,
  topicKey: TopicKeySchema,
  title: Type.String({ minLength: 1, maxLength: 80 }),
  body: Type.String({ minLength: 1, maxLength: 2000 }),
  authorLabel: Type.String({ minLength: 1, maxLength: 48 }),
  isOwnPost: Type.Boolean(),
  assetIds: Type.Array(BigIdSchema, { maxItems: 4 }),
  status: Type.Union([
    Type.Literal(SocialContentStatus.PUBLISHED),
    Type.Literal(SocialContentStatus.PENDING_REVIEW),
    Type.Literal(SocialContentStatus.HIDDEN),
  ]),
  createdAt: UtcTimestampSchema,
}, { additionalProperties: false });

export const SocialPostReplyDtoSchema = Type.Object({
  replyId: BigIdSchema,
  postId: BigIdSchema,
  parentReplyId: Type.Optional(BigIdSchema),
  body: Type.String({ minLength: 1, maxLength: 1000 }),
  authorLabel: Type.String({ minLength: 1, maxLength: 48 }),
  isOwnReply: Type.Boolean(),
  assetIds: Type.Array(BigIdSchema, { maxItems: 4 }),
  status: Type.Union([
    Type.Literal(SocialContentStatus.PUBLISHED),
    Type.Literal(SocialContentStatus.PENDING_REVIEW),
    Type.Literal(SocialContentStatus.HIDDEN),
  ]),
  createdAt: UtcTimestampSchema,
}, { additionalProperties: false });

export const CreateSocialPostRequestSchema = Type.Object({
  topicKey: TopicKeySchema,
  title: Type.String({ minLength: 1, maxLength: 80 }),
  body: Type.String({ minLength: 1, maxLength: 2000 }),
  assetIds: Type.Optional(Type.Array(BigIdSchema, { maxItems: 4 })),
}, { additionalProperties: false });

export const CreateSocialPostReplyRequestSchema = Type.Object({
  body: Type.String({ minLength: 1, maxLength: 1000 }),
  parentReplyId: Type.Optional(BigIdSchema),
  assetIds: Type.Optional(Type.Array(BigIdSchema, { maxItems: 4 })),
}, { additionalProperties: false });

const FriendLookupSchema = Type.Object({ value: Type.String({ minLength: 3, maxLength: 64 }) }, { additionalProperties: false });
const FriendRequestSchema = Type.Object({ userId: BigIdSchema }, { additionalProperties: false });
const ClientMessageIdSchema = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
const DirectMessageRequestSchema = Type.Object({ clientMessageId: ClientMessageIdSchema, body: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false });
export const SocialFriendDtoSchema = Type.Object({ userId: BigIdSchema, displayName: Type.String({ minLength: 1, maxLength: 48 }), friendCode: Type.String({ minLength: 8, maxLength: 16 }), state: Type.Union([Type.Literal('PENDING_INCOMING'), Type.Literal('PENDING_OUTGOING'), Type.Literal('ACCEPTED')]), updatedAt: UtcTimestampSchema }, { additionalProperties: false });
export const SocialMessageDtoSchema = Type.Object({ messageId: BigIdSchema, conversationId: BigIdSchema, clientMessageId: ClientMessageIdSchema, senderUserId: BigIdSchema, body: Type.String({ minLength: 1, maxLength: 2000 }), createdAt: UtcTimestampSchema }, { additionalProperties: false });
export const FriendLookupResponseSchema = Type.Array(Type.Object({ userId: BigIdSchema, displayName: Type.String({ minLength: 1, maxLength: 48 }), friendCode: Type.String({ minLength: 8, maxLength: 16 }) }, { additionalProperties: false }), { maxItems: 10 });
export const SocialFriendListResponseSchema = Type.Array(SocialFriendDtoSchema, { maxItems: 500 });
export const SocialMessageListResponseSchema = Type.Object({ conversationId: BigIdSchema, messages: Type.Array(SocialMessageDtoSchema, { maxItems: 100 }) }, { additionalProperties: false });
export const SocialFriendRequestResponseSchema = Type.Object({ accepted: Type.Boolean() }, { additionalProperties: false });
export const SocialConversationResponseSchema = Type.Object({ conversationId: BigIdSchema }, { additionalProperties: false });
export const SocialOwnProfileResponseSchema = Type.Object({ userId: BigIdSchema, displayName: Type.String({ minLength: 1, maxLength: 48 }), friendCode: Type.String({ minLength: 8, maxLength: 16 }) }, { additionalProperties: false });
export const SocialAccessResponseSchema = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
export const SocialEndpoint = {
  access: { method: 'GET', path: '/api/v1/me/social/access', response: SocialAccessResponseSchema, successStatus: 200 },
  profile: { method: 'GET', path: '/api/v1/me/social/profile', response: SocialOwnProfileResponseSchema, successStatus: 200 },
  lookup: { method: 'POST', path: '/api/v1/me/social/friends/lookup', request: FriendLookupSchema, response: FriendLookupResponseSchema, successStatus: 200 },
  friends: { method: 'GET', path: '/api/v1/me/social/friends', response: SocialFriendListResponseSchema, successStatus: 200 },
  request: { method: 'POST', path: '/api/v1/me/social/friend-requests', request: FriendRequestSchema, response: SocialFriendRequestResponseSchema, successStatus: 200 },
  accept: { method: 'POST', path: '/api/v1/me/social/friend-requests/:userId/accept', response: SocialFriendRequestResponseSchema, successStatus: 200 },
  reject: { method: 'POST', path: '/api/v1/me/social/friend-requests/:userId/reject', response: SocialFriendRequestResponseSchema, successStatus: 200 },
  removeFriend: { method: 'POST', path: '/api/v1/me/social/friends/:userId/remove', response: SocialFriendRequestResponseSchema, successStatus: 200 },
  conversation: { method: 'POST', path: '/api/v1/me/social/conversations', request: FriendRequestSchema, response: SocialConversationResponseSchema, successStatus: 200 },
  messages: { method: 'GET', path: '/api/v1/me/social/conversations/:conversationId/messages', response: SocialMessageListResponseSchema, successStatus: 200 },
  sendMessage: { method: 'POST', path: '/api/v1/me/social/conversations/:conversationId/messages', request: DirectMessageRequestSchema, response: SocialMessageDtoSchema, successStatus: 201 },
} as const;

export type SocialTopicDto = Static<typeof SocialTopicDtoSchema>;
export type SocialPostDto = Static<typeof SocialPostDtoSchema>;
export type SocialPostReplyDto = Static<typeof SocialPostReplyDtoSchema>;
export type SocialModerationCaseDto = Static<typeof SocialModerationCaseDtoSchema>;
export type SocialModerationQueryDto = Static<typeof SocialModerationQuerySchema>;
export type SocialModerationListResponseDto = Static<typeof SocialModerationListResponseSchema>;
export type SocialModerationDecisionRequestDto = Static<typeof SocialModerationDecisionRequestSchema>;
export type SocialModerationAuditDto = Static<typeof SocialModerationAuditDtoSchema>;
export type SocialModerationAuditListResponseDto = Static<typeof SocialModerationAuditListResponseSchema>;
export type SocialModerationDecisionResponseDto = Static<typeof SocialModerationDecisionResponseSchema>;
export type CreateSocialPostRequestDto = Static<typeof CreateSocialPostRequestSchema>;
export type CreateSocialPostReplyRequestDto = Static<typeof CreateSocialPostReplyRequestSchema>;
export type SocialFriendDto = Static<typeof SocialFriendDtoSchema>;
export type SocialMessageDto = Static<typeof SocialMessageDtoSchema>;
export type FriendLookupResponseDto = Static<typeof FriendLookupResponseSchema>;
export type SocialFriendListResponseDto = Static<typeof SocialFriendListResponseSchema>;
export type SocialMessageListResponseDto = Static<typeof SocialMessageListResponseSchema>;
export type SocialOwnProfileResponseDto = Static<typeof SocialOwnProfileResponseSchema>;
export type SocialAccessResponseDto = Static<typeof SocialAccessResponseSchema>;
