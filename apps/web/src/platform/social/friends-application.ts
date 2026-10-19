import type { FriendLookupResponseDto, SocialConversationListResponseDto, SocialFriendDto, SocialMessageAttachmentDto, SocialMessageDto, SocialMessageListResponseDto, SocialOwnProfileResponseDto } from '@gameing/contracts/social';
import type { SocialMessageAssetApplication } from '../assets/social-message-asset-application';

export interface SocialFriendsGateway {
  ownProfile(): Promise<SocialOwnProfileResponseDto>;
  lookup(value: string): Promise<FriendLookupResponseDto>;
  listFriends(): Promise<SocialFriendDto[]>;
  requestFriend(userId: string): Promise<{ accepted: boolean }>;
  acceptFriend(userId: string): Promise<{ accepted: boolean }>;
  rejectFriend(userId: string): Promise<{ accepted: boolean }>;
  removeFriend(userId: string): Promise<{ accepted: boolean }>;
  listConversations(): Promise<SocialConversationListResponseDto>;
  openConversation(userId: string): Promise<{ conversationId: string }>;
  listMessages(conversationId: string): Promise<SocialMessageListResponseDto>;
  sendMessage(conversationId: string, body: { clientMessageId: string; body: string; attachments?: SocialMessageAttachmentDto[] }): Promise<SocialMessageDto>;
}

export interface SocialFriendsApplication {
  ownProfile(): Promise<SocialOwnProfileResponseDto>;
  lookup(value: string): Promise<FriendLookupResponseDto>;
  listFriends(): Promise<SocialFriendDto[]>;
  requestFriend(userId: string): Promise<{ accepted: boolean }>;
  acceptFriend(userId: string): Promise<{ accepted: boolean }>;
  rejectFriend(userId: string): Promise<{ accepted: boolean }>;
  removeFriend(userId: string): Promise<{ accepted: boolean }>;
  listConversations(): Promise<SocialConversationListResponseDto>;
  openConversation(userId: string): Promise<{ conversationId: string }>;
  listMessages(conversationId: string): Promise<SocialMessageListResponseDto>;
  sendMessage(conversationId: string, body: { clientMessageId: string; body: string; attachments?: SocialMessageAttachmentDto[] }): Promise<SocialMessageDto>;
  uploadAttachment(file: File, recipientUserId: string): Promise<SocialMessageAttachmentDto>;
  openAttachment(assetId: string, viewerUserId: string): Promise<Blob>;
}

export function createSocialFriendsApplication(gateway: SocialFriendsGateway, attachments: SocialMessageAssetApplication): SocialFriendsApplication {
  return {
    ownProfile: () => gateway.ownProfile(),
    lookup: (value) => gateway.lookup(value),
    listFriends: () => gateway.listFriends(),
    requestFriend: (userId) => gateway.requestFriend(userId),
    acceptFriend: (userId) => gateway.acceptFriend(userId),
    rejectFriend: (userId) => gateway.rejectFriend(userId),
    removeFriend: (userId) => gateway.removeFriend(userId),
    listConversations: () => gateway.listConversations(),
    openConversation: (userId) => gateway.openConversation(userId),
    listMessages: (conversationId) => gateway.listMessages(conversationId),
    sendMessage: (conversationId, body) => gateway.sendMessage(conversationId, body),
    uploadAttachment: (file, recipientUserId) => attachments.upload(file, recipientUserId),
    openAttachment: (assetId, viewerUserId) => attachments.open(assetId, viewerUserId),
  };
}
