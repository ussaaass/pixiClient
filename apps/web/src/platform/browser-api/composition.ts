import { createPlayerEntryApplication } from '../player-entry/player-entry-application';
import { BrowserPlayerIdentityAdapter } from './player-identity-adapter';
import { createBrowserApiFetch, ensureLocalDeviceRegistration } from './dispatcher';
import { randomToken } from './crypto';
import { shallowRef } from 'vue';
import type { SessionResponseDto } from '@gameing/contracts/identity';
import { readLocalContactChallengeCode } from './identity/local-contact-challenge-inbox';
import { createApiClient } from '../http/api-client';
import { createWalletApplication } from '../wallet/wallet-application';
import { createSupportClientApplication } from '../support/support-application';
import { createSocialFriendsApplication } from '../social/friends-application';
import { createNotificationSummaryApplication } from '../notifications/notification-summary-application';
import { getActivePlatformAnnouncements } from '../announcements-api';
import { createInviteAgentApplication } from '../invite-agent/invite-agent-application';
import { createSocialApplication } from '../social/social-application';
import { openBrowserDevelopmentDatabase } from './database';
import { IndexedDbSocialRepository } from './social/indexeddb-social-repository';
import { InviteAgentEndpoint } from '@gameing/contracts/invite-agent';
import type { WalletFundingApplication } from '../../wallet-funding/wallet-funding-application';

export async function createBrowserDevelopmentIdentity() {
  const fetchPort = await createBrowserApiFetch();
  const sessionState = shallowRef<SessionResponseDto>();
  const adapter = new BrowserPlayerIdentityAdapter(fetchPort, (session) => { sessionState.value = session; });
  const api = createApiClient(fetchPort);
  const socialRepository = new IndexedDbSocialRepository(await openBrowserDevelopmentDatabase(), () => {
    const user = adapter.currentSession?.user;
    return user ? { userId: user.userId, displayName: user.displayName } : null;
  });
  const socialApplication = createSocialApplication(socialRepository);
  const walletApplication = createWalletApplication(
    () => adapter.withValidAccessToken((accessToken) => api.walletSummary(accessToken)),
    (cursor) => adapter.withValidAccessToken((accessToken) => api.walletActivity(accessToken, cursor)),
    (request) => adapter.withValidAccessToken((accessToken) => api.walletTransferQuote(request, accessToken)),
    (request) => adapter.withValidAccessToken((accessToken) => api.walletTransfer(request, accessToken)),
    (request) => adapter.withValidAccessToken((accessToken) => api.walletExchangeQuote(request, accessToken)),
    (request) => adapter.withValidAccessToken((accessToken) => api.walletExchange(request, accessToken)),
    () => adapter.withValidAccessToken((accessToken) => api.walletPayoutAccounts(accessToken)),
    (request) => adapter.withValidAccessToken((accessToken) => api.walletCreatePayoutAccount(request, accessToken)),
    (payoutAccountId) => adapter.withValidAccessToken((accessToken) => api.walletDeletePayoutAccount(payoutAccountId, accessToken)),
    (request) => adapter.withValidAccessToken((accessToken) => api.walletWithdrawalQuote(request, accessToken)),
    () => adapter.withValidAccessToken((accessToken) => api.walletWithdrawals(accessToken)),
    (request) => adapter.withValidAccessToken((accessToken) => api.walletCreateWithdrawal(request, accessToken)),
    (withdrawalId) => adapter.withValidAccessToken((accessToken) => api.walletCancelWithdrawal(withdrawalId, accessToken)),
  );
  const walletFundingApplication: WalletFundingApplication = {
    listChannels: () => adapter.withValidAccessToken((token) => api.fundingChannels(token)),
    listOrders: () => adapter.withValidAccessToken((token) => api.fundingOrders(token)),
    createOrder: (request) => adapter.withValidAccessToken((token) => api.createFundingOrder(request, token)),
    simulatePayment: (request) => adapter.withValidAccessToken((token) => api.simulateFundingPayment(request, token)),
  };
  const supportApplication = createSupportClientApplication({
    listConversations: (token) => api.listSupportConversations(token),
    createConversation: (request, token) => api.createSupportConversation(request, token),
    listMessages: (conversationId, token) => api.listSupportMessages(conversationId, token),
    sendMessage: (conversationId, request, token) => api.sendSupportMessage(conversationId, request, token),
    closeConversation: (conversationId, token) => api.closeSupportConversation(conversationId, token),
  }, (operation) => adapter.withValidAccessToken(operation));
  const socialFriendsApplication = createSocialFriendsApplication({
    ownProfile: () => adapter.withValidAccessToken((token) => api.socialProfile(token)),
    lookup: (value) => adapter.withValidAccessToken((token) => api.lookupSocialFriends(value, token)),
    listFriends: () => adapter.withValidAccessToken((token) => api.listSocialFriends(token)),
    requestFriend: (userId) => adapter.withValidAccessToken((token) => api.requestSocialFriend(userId, token)),
    acceptFriend: (userId) => adapter.withValidAccessToken((token) => api.acceptSocialFriend(userId, token)),
    rejectFriend: (userId) => adapter.withValidAccessToken((token) => api.rejectSocialFriend(userId, token)),
    removeFriend: (userId) => adapter.withValidAccessToken((token) => api.removeSocialFriend(userId, token)),
    openConversation: (userId) => adapter.withValidAccessToken((token) => api.openSocialConversation(userId, token)),
    listMessages: (conversationId) => adapter.withValidAccessToken((token) => api.listSocialMessages(conversationId, token)),
    sendMessage: (conversationId, request) => adapter.withValidAccessToken((token) => api.sendSocialMessage(conversationId, request, token)),
  });
  const notificationSummaryApplication = createNotificationSummaryApplication({
    announcements: getActivePlatformAnnouncements,
    walletActivity: async () => (await adapter.withValidAccessToken((token) => api.walletActivity(token))).items,
    supportConversations: async () => {
      const result = await supportApplication.listConversations();
      if (!result.ok) throw new Error(result.code);
      return result.value;
    },
    socialFriends: () => socialFriendsApplication.listFriends(),
  });
  const inviteAgentApplication = createInviteAgentApplication({
    getInviteLink: () => adapter.withValidAccessToken((token) => api.getInviteLink(token)),
    issueInviteLink: () => adapter.withValidAccessToken((token) => api.issueInviteLink(token)),
    getAgentDomain: () => adapter.withValidAccessToken((token) => api.getAgentDomain(token)),
    applyAgentDomain: () => adapter.withValidAccessToken((token) => api.applyAgentDomain(token)),
    withdrawAgentDomain: () => adapter.withValidAccessToken((token) => api.withdrawAgentDomain(token)),
  });
  const application = createPlayerEntryApplication(adapter);
  return {
    application,
    walletApplication,
    walletFundingApplication,
    supportApplication,
    socialApplication,
    socialFriendsApplication,
    checkSocialAccess: () => adapter.withValidAccessToken((token) => api.socialAccess(token)),
    notificationSummaryApplication,
    inviteAgentApplication,
    sessionState,
    createTestAccount: () => adapter.createTestAccount(),
    readDevelopmentContactChallengeCode(challengeId: string): string | undefined {
      const userId = adapter.currentSession?.user.userId;
      return userId ? readLocalContactChallengeCode(userId, challengeId) : undefined;
    },
    async start(): Promise<void> {
      const currentUrl = new URL(window.location.href);
      const inviteCode = currentUrl.searchParams.get('inviteCode');
      if (inviteCode) {
        try {
          await fetchPort(InviteAgentEndpoint.captureAttribution.path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inviteCode }),
          });
        } catch {
          // Attribution is best-effort; an unavailable local adapter must not block lobby entry.
        } finally {
          currentUrl.searchParams.delete('inviteCode');
          window.history.replaceState(window.history.state, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
        }
      }
      const credentialResponse = await fetchPort('/api/v1/auth/device-credential', { method: 'GET', credentials: 'include' });
      const payload = await credentialResponse.json() as { data?: { available?: boolean } };
      if (payload.data?.available) {
        if (localStorage.getItem('gameing-hall.browser-device-login-suppressed') === 'true') return;
        await application.checkCurrentDevice();
        return;
      }
      const session = await ensureLocalDeviceRegistration(fetchPort, randomToken());
      adapter.acceptSession(session);
    },
  };
}
