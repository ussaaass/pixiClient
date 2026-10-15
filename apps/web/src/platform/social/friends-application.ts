import type { FriendLookupResponseDto, SocialFriendDto, SocialMessageDto, SocialMessageListResponseDto, SocialOwnProfileResponseDto } from '@gameing/contracts/social';

export interface SocialFriendsGateway {
  ownProfile(): Promise<SocialOwnProfileResponseDto>;
  lookup(value: string): Promise<FriendLookupResponseDto>;
  listFriends(): Promise<SocialFriendDto[]>;
  requestFriend(userId: string): Promise<{ accepted: boolean }>;
  acceptFriend(userId: string): Promise<{ accepted: boolean }>;
  rejectFriend(userId: string): Promise<{ accepted: boolean }>;
  removeFriend(userId: string): Promise<{ accepted: boolean }>;
  openConversation(userId: string): Promise<{ conversationId: string }>;
  listMessages(conversationId: string): Promise<SocialMessageListResponseDto>;
  sendMessage(conversationId: string, body: { clientMessageId: string; body: string }): Promise<SocialMessageDto>;
}

export interface SocialFriendsApplication {
  ownProfile(): Promise<SocialOwnProfileResponseDto>;
  lookup(value: string): Promise<FriendLookupResponseDto>;
  listFriends(): Promise<SocialFriendDto[]>;
  requestFriend(userId: string): Promise<{ accepted: boolean }>;
  acceptFriend(userId: string): Promise<{ accepted: boolean }>;
  rejectFriend(userId: string): Promise<{ accepted: boolean }>;
  removeFriend(userId: string): Promise<{ accepted: boolean }>;
  openConversation(userId: string): Promise<{ conversationId: string }>;
  listMessages(conversationId: string): Promise<SocialMessageListResponseDto>;
  sendMessage(conversationId: string, body: { clientMessageId: string; body: string }): Promise<SocialMessageDto>;
}

export function createSocialFriendsApplication(gateway: SocialFriendsGateway): SocialFriendsApplication {
  return {
    ownProfile: () => gateway.ownProfile(),
    lookup: (value) => gateway.lookup(value),
    listFriends: () => gateway.listFriends(),
    requestFriend: (userId) => gateway.requestFriend(userId),
    acceptFriend: (userId) => gateway.acceptFriend(userId),
    rejectFriend: (userId) => gateway.rejectFriend(userId),
    removeFriend: (userId) => gateway.removeFriend(userId),
    openConversation: (userId) => gateway.openConversation(userId),
    listMessages: (conversationId) => gateway.listMessages(conversationId),
    sendMessage: (conversationId, body) => gateway.sendMessage(conversationId, body),
  };
}
