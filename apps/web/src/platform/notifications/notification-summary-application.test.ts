import { describe, expect, it, vi } from 'vitest';
import { NotificationAction, NotificationSource } from '@gameing/contracts/notifications';
import { SupportCategoryType, SupportConversationStatus } from '@gameing/contracts/support';
import { WalletActivityType, WalletAssetType } from '@gameing/contracts/wallet';
import { createNotificationSummaryApplication } from './notification-summary-application';

const now = '2026-10-15T12:00:00.000Z';

describe('notification summary application', () => {
  it('aggregates only source-owned records and sorts them by source time', async () => {
    const app = createNotificationSummaryApplication({
      announcements: async () => [{ announcementId: '345e5a79-4177-40be-8aa5-c872cf8e3d32', eventType: 'PLAYER_BURST', stateVersion: 1, kind: 'BROADCAST_ONLY', titleKey: 'PLAYER_BURST', safeParams: {}, scope: [{ type: 'GLOBAL_HALL' }], startsAt: '2026-10-15T10:00:00.000Z', expiresAt: '2026-10-15T10:15:00.000Z' }],
      walletActivity: async () => [{ entryId: '12', operationId: '20', activityType: WalletActivityType.WELCOME_GIFT, assetType: WalletAssetType.COIN, currency: 'COIN', delta: '1000', balanceAfter: '1000', occurredAt: now }],
      supportConversations: async () => [{ conversationId: '9', categoryType: SupportCategoryType.OTHER, subject: '测试咨询', status: SupportConversationStatus.WAITING_USER, lastMessageAt: now, createdAt: now, updatedAt: now }],
      socialFriends: async () => [{ userId: '8', displayName: '牌友', friendCode: 'ABCD2345', state: 'PENDING_INCOMING', updatedAt: '2026-10-15T11:00:00.000Z' }],
    });

    const result = await app.load(true);
    expect(result.unavailableSources).toEqual([]);
    expect(result.items.map((item) => item.source)).toEqual([
      NotificationSource.SUPPORT,
      NotificationSource.WALLET,
      NotificationSource.SOCIAL_FRIEND_REQUEST,
      NotificationSource.ANNOUNCEMENT,
    ]);
    expect(result.items[1]).toMatchObject({ title: '金币资产变动', action: NotificationAction.OPEN_WALLET });
    expect(result.items[0]).toMatchObject({ title: '客服会话更新', requiresAction: true });
    expect(result.items[2]).toMatchObject({ title: '新的好友申请', action: NotificationAction.OPEN_FRIENDS, requiresAction: true });
    expect(result.items[1]?.requiresAction).toBe(false);
    expect(result.items[3]?.requiresAction).toBe(false);
  });

  it('does not request private sources for guests and reports source failures for retry', async () => {
    const walletActivity = vi.fn(async () => []);
    const app = createNotificationSummaryApplication({
      announcements: async () => { throw new Error('offline'); },
      walletActivity,
      supportConversations: async () => [],
      socialFriends: async () => [],
    });

    const result = await app.load(false);
    expect(walletActivity).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
    expect(result.unavailableSources).toEqual([NotificationSource.ANNOUNCEMENT]);
  });
});
