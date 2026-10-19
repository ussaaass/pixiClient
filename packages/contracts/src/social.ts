import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const BigIdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const TopicKeySchema = Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,47}$' });
const UtcTimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });
const PublicProfileKeySchema = Type.String({ pattern: '^[A-Z0-9]{8,16}$' });

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
  authorProfileKey: Type.Optional(PublicProfileKeySchema),
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
  authorProfileKey: Type.Optional(PublicProfileKeySchema),
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
export const SocialContentResourceType = { POST: 'POST', REPLY: 'REPLY' } as const;
export const SocialContentAction = { DISLIKE: 'DISLIKE', CLEAR_DISLIKE: 'CLEAR_DISLIKE', FOLLOW_AUTHOR: 'FOLLOW_AUTHOR', UNFOLLOW_AUTHOR: 'UNFOLLOW_AUTHOR', REPORT: 'REPORT' } as const;
export const SocialReportReason = { SPAM: 'SPAM', ABUSE: 'ABUSE', FRAUD: 'FRAUD', SEXUAL_CONTENT: 'SEXUAL_CONTENT', OTHER: 'OTHER' } as const;
const SocialContentResourceTypeSchema = Type.Union([Type.Literal('POST'), Type.Literal('REPLY')]);
const SocialContentActionSchema = Type.Union(Object.values(SocialContentAction).map((value) => Type.Literal(value)));
const SocialReportReasonSchema = Type.Union(Object.values(SocialReportReason).map((value) => Type.Literal(value)));
export const SocialContentActionRequestSchema = Type.Object({ resourceType: SocialContentResourceTypeSchema, resourceId: BigIdSchema, action: SocialContentActionSchema, reasonCode: Type.Optional(SocialReportReasonSchema), details: Type.Optional(Type.String({ maxLength: 300 })) }, { additionalProperties: false });
export const SocialContentActionStateSchema = Type.Object({ disliked: Type.Boolean(), followingAuthor: Type.Boolean(), reported: Type.Boolean() }, { additionalProperties: false });

const FriendLookupSchema = Type.Object({ value: Type.String({ minLength: 3, maxLength: 64 }) }, { additionalProperties: false });
const FriendRequestSchema = Type.Object({ userId: BigIdSchema }, { additionalProperties: false });
const ClientMessageIdSchema = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
export const SocialMessageAttachmentKind = { IMAGE: 1, VIDEO: 2, AUDIO: 3 } as const;
export type SocialMessageAttachmentKindValue = (typeof SocialMessageAttachmentKind)[keyof typeof SocialMessageAttachmentKind];
const SocialMessageAttachmentKindSchema = Type.Union([Type.Literal(SocialMessageAttachmentKind.IMAGE), Type.Literal(SocialMessageAttachmentKind.VIDEO), Type.Literal(SocialMessageAttachmentKind.AUDIO)]);
export const SocialMessageAttachmentDtoSchema = Type.Object({ assetId: BigIdSchema, kind: SocialMessageAttachmentKindSchema, mimeType: Type.String({ minLength: 3, maxLength: 96 }), fileName: Type.String({ minLength: 1, maxLength: 160 }), byteSize: Type.Integer({ minimum: 1, maximum: 52_428_800 }) }, { additionalProperties: false });
const SocialMessageAttachmentsSchema = Type.Array(SocialMessageAttachmentDtoSchema, { maxItems: 4 });
const DirectMessageRequestSchema = Type.Object({ clientMessageId: ClientMessageIdSchema, body: Type.String({ maxLength: 2000 }), attachments: Type.Optional(SocialMessageAttachmentsSchema) }, { additionalProperties: false });
export const SocialFriendDtoSchema = Type.Object({ userId: BigIdSchema, displayName: Type.String({ minLength: 1, maxLength: 48 }), friendCode: Type.String({ minLength: 8, maxLength: 16 }), state: Type.Union([Type.Literal('PENDING_INCOMING'), Type.Literal('PENDING_OUTGOING'), Type.Literal('ACCEPTED')]), updatedAt: UtcTimestampSchema }, { additionalProperties: false });
export const SocialMessageDtoSchema = Type.Object({ messageId: BigIdSchema, conversationId: BigIdSchema, clientMessageId: ClientMessageIdSchema, senderUserId: BigIdSchema, body: Type.String({ maxLength: 2000 }), attachments: Type.Optional(SocialMessageAttachmentsSchema), createdAt: UtcTimestampSchema }, { additionalProperties: false });
export const FriendLookupResponseSchema = Type.Array(Type.Object({ userId: BigIdSchema, displayName: Type.String({ minLength: 1, maxLength: 48 }), friendCode: Type.String({ minLength: 8, maxLength: 16 }) }, { additionalProperties: false }), { maxItems: 10 });
export const SocialFriendListResponseSchema = Type.Array(SocialFriendDtoSchema, { maxItems: 500 });
export const SocialMessageListResponseSchema = Type.Object({ conversationId: BigIdSchema, messages: Type.Array(SocialMessageDtoSchema, { maxItems: 100 }), peerIsFriend: Type.Boolean(), canSend: Type.Boolean(), requiresReply: Type.Boolean() }, { additionalProperties: false });
export const SocialConversationPreviewSchema = Type.Object({ conversationId: BigIdSchema, peerUserId: BigIdSchema, peerDisplayName: Type.String({ minLength: 1, maxLength: 48 }), peerFriendCode: Type.String({ minLength: 8, maxLength: 16 }), peerIsFriend: Type.Boolean(), lastMessage: Type.Optional(Type.String({ maxLength: 2000 })), lastMessageAt: Type.Optional(UtcTimestampSchema) }, { additionalProperties: false });
export const SocialConversationListResponseSchema = Type.Array(SocialConversationPreviewSchema, { maxItems: 100 });
export const SocialFriendRequestResponseSchema = Type.Object({ accepted: Type.Boolean() }, { additionalProperties: false });
export const SocialConversationResponseSchema = Type.Object({ conversationId: BigIdSchema }, { additionalProperties: false });
export const SocialOwnProfileResponseSchema = Type.Object({ userId: BigIdSchema, displayName: Type.String({ minLength: 1, maxLength: 48 }), friendCode: Type.String({ minLength: 8, maxLength: 16 }) }, { additionalProperties: false });
export const SocialAccessResponseSchema = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
export const SocialPublicProfileRelationship = { NONE: 'NONE', REQUEST_SENT: 'REQUEST_SENT', REQUEST_RECEIVED: 'REQUEST_RECEIVED', FRIEND: 'FRIEND' } as const;
const SocialPublicProfileRelationshipSchema = Type.Union(Object.values(SocialPublicProfileRelationship).map((value) => Type.Literal(value)));
const SocialFavoriteGameSchema = Type.Object({ gameKey: Type.String({ minLength: 2, maxLength: 64 }), gameName: Type.String({ minLength: 1, maxLength: 48 }), settledRounds: Type.Integer({ minimum: 1 }), recentResults: Type.Array(Type.Object({ result: Type.Union([Type.Literal('WIN'), Type.Literal('LOSS'), Type.Literal('DRAW')]), settledAt: UtcTimestampSchema }, { additionalProperties: false }), { maxItems: 5 }) }, { additionalProperties: false });
export const SocialPublicProfileDtoSchema = Type.Object({
  publicProfileKey: PublicProfileKeySchema,
  isSelf: Type.Boolean(),
  publicCode: Type.String({ pattern: '^[A-Z0-9]{8,16}$' }),
  displayName: Type.String({ minLength: 1, maxLength: 48 }),
  avatarAssetId: Type.Union([BigIdSchema, Type.Null()]),
  bio: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
  joinedMonth: Type.String({ pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' }),
  recentWonCoins: Type.String({ pattern: '^(0|[1-9][0-9]{0,19})$' }),
  recentWinRate: Type.Object({ wins: Type.Integer({ minimum: 0 }), losses: Type.Integer({ minimum: 0 }), draws: Type.Integer({ minimum: 0 }), rateBps: Type.Union([Type.Integer({ minimum: 0, maximum: 10000 }), Type.Null()]), periodDays: Type.Literal(30) }, { additionalProperties: false }),
  favoriteGames: Type.Array(SocialFavoriteGameSchema, { maxItems: 3 }),
  completedCoinMarketTradeCount: Type.Integer({ minimum: 0 }),
  profileLandingUrl: Type.String({ minLength: 1, maxLength: 512 }),
  relationship: SocialPublicProfileRelationshipSchema,
  followedByMe: Type.Boolean(),
  blockedByMe: Type.Boolean(),
  reportedByMe: Type.Boolean(),
}, { additionalProperties: false });
export const SocialAuthorReportRequestSchema = Type.Object({ publicProfileKey: PublicProfileKeySchema, reasonCode: SocialReportReasonSchema, details: Type.Optional(Type.String({ maxLength: 300 })) }, { additionalProperties: false });
export const SocialAuthorBlockRequestSchema = Type.Object({ publicProfileKey: PublicProfileKeySchema, blocked: Type.Boolean() }, { additionalProperties: false });
export const SocialAuthorBlockResponseSchema = Type.Object({ blocked: Type.Boolean() }, { additionalProperties: false });
export const SocialAuthorReportResponseSchema = Type.Object({ submitted: Type.Boolean() }, { additionalProperties: false });
export const SocialPublicProfilePostsResponseSchema = Type.Object({ items: Type.Array(SocialPostDtoSchema, { maxItems: 100 }), nextCursor: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]) }, { additionalProperties: false });
export const SocialEndpoint = {
  access: { method: 'GET', path: '/api/v1/me/social/access', response: SocialAccessResponseSchema, successStatus: 200 },
  profile: { method: 'GET', path: '/api/v1/me/social/profile', response: SocialOwnProfileResponseSchema, successStatus: 200 },
  publicProfile: { method: 'GET', path: '/api/v1/social/users/:publicProfileKey', response: SocialPublicProfileDtoSchema, successStatus: 200 },
  publicProfilePosts: { method: 'GET', path: '/api/v1/social/users/:publicProfileKey/posts', response: SocialPublicProfilePostsResponseSchema, successStatus: 200 },
  blockAuthor: { method: 'POST', path: '/api/v1/me/social/users/:publicProfileKey/block', request: SocialAuthorBlockRequestSchema, response: SocialAuthorBlockResponseSchema, successStatus: 200 },
  reportAuthor: { method: 'POST', path: '/api/v1/me/social/users/:publicProfileKey/report', request: SocialAuthorReportRequestSchema, response: SocialAuthorReportResponseSchema, successStatus: 201 },
  lookup: { method: 'POST', path: '/api/v1/me/social/friends/lookup', request: FriendLookupSchema, response: FriendLookupResponseSchema, successStatus: 200 },
  friends: { method: 'GET', path: '/api/v1/me/social/friends', response: SocialFriendListResponseSchema, successStatus: 200 },
  request: { method: 'POST', path: '/api/v1/me/social/friend-requests', request: FriendRequestSchema, response: SocialFriendRequestResponseSchema, successStatus: 200 },
  accept: { method: 'POST', path: '/api/v1/me/social/friend-requests/:userId/accept', response: SocialFriendRequestResponseSchema, successStatus: 200 },
  reject: { method: 'POST', path: '/api/v1/me/social/friend-requests/:userId/reject', response: SocialFriendRequestResponseSchema, successStatus: 200 },
  removeFriend: { method: 'POST', path: '/api/v1/me/social/friends/:userId/remove', response: SocialFriendRequestResponseSchema, successStatus: 200 },
  conversations: { method: 'GET', path: '/api/v1/me/social/conversations', response: SocialConversationListResponseSchema, successStatus: 200 },
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
export type SocialContentActionRequestDto = Static<typeof SocialContentActionRequestSchema>;
export type SocialContentActionStateDto = Static<typeof SocialContentActionStateSchema>;
export type SocialFriendDto = Static<typeof SocialFriendDtoSchema>;
export type SocialMessageAttachmentDto = Static<typeof SocialMessageAttachmentDtoSchema>;
export type SocialMessageDto = Static<typeof SocialMessageDtoSchema>;
export type FriendLookupResponseDto = Static<typeof FriendLookupResponseSchema>;
export type SocialFriendListResponseDto = Static<typeof SocialFriendListResponseSchema>;
export type SocialMessageListResponseDto = Static<typeof SocialMessageListResponseSchema>;
export type SocialConversationPreviewDto = Static<typeof SocialConversationPreviewSchema>;
export type SocialConversationListResponseDto = Static<typeof SocialConversationListResponseSchema>;
export type SocialOwnProfileResponseDto = Static<typeof SocialOwnProfileResponseSchema>;
export type SocialAccessResponseDto = Static<typeof SocialAccessResponseSchema>;
export type SocialPublicProfileDto = Static<typeof SocialPublicProfileDtoSchema>;
export type SocialPublicProfilePostsResponseDto = Static<typeof SocialPublicProfilePostsResponseSchema>;
export type SocialAuthorReportRequestDto = Static<typeof SocialAuthorReportRequestSchema>;
export type SocialPublicProfileRelationshipValue = (typeof SocialPublicProfileRelationship)[keyof typeof SocialPublicProfileRelationship];
