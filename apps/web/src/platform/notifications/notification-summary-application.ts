import { Value } from '@sinclair/typebox/value';
import type { PlatformAnnouncement } from '@gameing/contracts/platform-events/announcement';
import { NotificationAction, NotificationSource, NotificationSummaryResponseSchema, type NotificationSummaryItemDto, type NotificationSummaryResponseDto } from '@gameing/contracts/notifications';
import type { SocialFriendDto } from '@gameing/contracts/social';
import { SupportConversationStatus, type SupportConversationDto } from '@gameing/contracts/support';
import type { WalletActivityItemDto } from '@gameing/contracts/wallet';

export interface NotificationSourcePort {
  announcements(): Promise<PlatformAnnouncement[]>;
  walletActivity(): Promise<WalletActivityItemDto[]>;
  supportConversations(): Promise<SupportConversationDto[]>;
  socialFriends(): Promise<SocialFriendDto[]>;
}

export interface NotificationSummaryApplication {
  load(authenticated: boolean): Promise<NotificationSummaryResponseDto>;
}

function announcedAt(value: PlatformAnnouncement): NotificationSummaryItemDto {
  return {
    itemId: `announcement:${value.announcementId}`,
    source: NotificationSource.ANNOUNCEMENT,
    sourceId: value.announcementId,
    title: '大厅活动',
    summary: value.publicActorLabel ? `${value.publicActorLabel} 的活动播报，查看范围和规则。` : '有新的大厅活动，点击查看适用范围和规则。',
    occurredAt: value.startsAt,
    action: NotificationAction.OPEN_ANNOUNCEMENT,
    requiresAction: false,
  };
}

function walletItem(value: WalletActivityItemDto): NotificationSummaryItemDto {
  const delta = value.delta.startsWith('-') ? value.delta : `+${value.delta}`;
  return {
    itemId: `wallet:${value.entryId}`,
    source: NotificationSource.WALLET,
    sourceId: value.entryId,
    title: value.currency === 'COIN' ? '金币资产变动' : '余额资产变动',
    summary: `${delta} ${value.currency === 'COIN' ? '金币' : '分'} · 当前余额 ${value.balanceAfter}`,
    occurredAt: value.occurredAt,
    action: NotificationAction.OPEN_WALLET,
    requiresAction: false,
  };
}

function supportItem(value: SupportConversationDto): NotificationSummaryItemDto {
  const statusCopy = value.status === SupportConversationStatus.WAITING_SUPPORT ? '等待客服回复' : value.status === SupportConversationStatus.WAITING_USER ? '等待你回复' : '会话已结束';
  return {
    itemId: `support:${value.conversationId}`,
    source: NotificationSource.SUPPORT,
    sourceId: value.conversationId,
    title: '客服会话更新',
    summary: `${value.subject} · ${statusCopy}`,
    occurredAt: value.updatedAt,
    action: NotificationAction.OPEN_SUPPORT,
    requiresAction: value.status === SupportConversationStatus.WAITING_USER,
  };
}

function friendRequestItem(value: SocialFriendDto): NotificationSummaryItemDto {
  return {
    itemId: `friend-request:${value.userId}`,
    source: NotificationSource.SOCIAL_FRIEND_REQUEST,
    sourceId: value.userId,
    title: '新的好友申请',
    summary: `${value.displayName} 想添加你为好友。`,
    occurredAt: value.updatedAt,
    action: NotificationAction.OPEN_FRIENDS,
    requiresAction: true,
  };
}

export function createNotificationSummaryApplication(sources: NotificationSourcePort): NotificationSummaryApplication {
  return {
    async load(authenticated) {
      const items: NotificationSummaryItemDto[] = [];
      const unavailableSources: NotificationSummaryResponseDto['unavailableSources'] = [];
      const [announcements, wallet, support, social] = await Promise.allSettled([
        sources.announcements(),
        authenticated ? sources.walletActivity() : Promise.resolve([]),
        authenticated ? sources.supportConversations() : Promise.resolve([]),
        authenticated ? sources.socialFriends() : Promise.resolve([]),
      ]);
      if (announcements.status === 'fulfilled') items.push(...announcements.value.map(announcedAt));
      else unavailableSources.push(NotificationSource.ANNOUNCEMENT);
      if (wallet.status === 'fulfilled') items.push(...wallet.value.map(walletItem));
      else unavailableSources.push(NotificationSource.WALLET);
      if (support.status === 'fulfilled') items.push(...support.value.map(supportItem));
      else unavailableSources.push(NotificationSource.SUPPORT);
      if (social.status === 'fulfilled') items.push(...social.value.filter((friend) => friend.state === 'PENDING_INCOMING').map(friendRequestItem));
      else unavailableSources.push(NotificationSource.SOCIAL_FRIEND_REQUEST);
      items.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || left.itemId.localeCompare(right.itemId));
      const response: NotificationSummaryResponseDto = { items: items.slice(0, 100), unavailableSources };
      if (!Value.Check(NotificationSummaryResponseSchema, response)) throw new Error('NOTIFICATION_SUMMARY_INVALID');
      return response;
    },
  };
}
