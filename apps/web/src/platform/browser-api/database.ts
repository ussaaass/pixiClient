import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { SocialPostDto, SocialPostReplyDto } from '@gameing/contracts/social';
import { CoinMarketTradeStatus, type CoinMarketPaymentMethodValue } from '@gameing/contracts/coin-market';
import type { AgentCapabilityCodeValue, ReferralBindingStatus } from '@gameing/contracts/invite-agent';
import type { RewardTypeValue } from '@gameing/contracts/referral';
import { FundingOrderStatus, FundingPaymentMethod, OrderType } from '@gameing/contracts/wallet-funding';

export type LocalUser = {
  userId: string;
  displayName: string;
  createdAt?: string;
  bio?: string;
  roleType: number;
  rewardType?: RewardTypeValue;
  status: 'ACTIVE' | 'LOCKED';
  authVersion: number;
  friendCode?: string;
  isDemoFixture?: boolean;
  inviteCode?: string;
  inviteCodeExpiresAt?: string;
};
export type LocalAgentDomain = { userId: string; status: 1 | 2 | 3 | 4 | 5; appliedAt: string; capabilities: AgentCapabilityCodeValue[]; updatedAt: string };
export type LocalReferralBinding = { userId: string; parent1UserId: string; parent2UserId?: string; parent3UserId?: string; parent4UserId?: string; createdAt: string; status: (typeof ReferralBindingStatus)[keyof typeof ReferralBindingStatus] };

export type LocalSocialFriendship = { pairKey: string; lowUserId: string; highUserId: string; requesterUserId: string; state: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'REMOVED'; updatedAt: string };
export type LocalSocialConversation = { conversationId: string; pairKey: string; lowUserId: string; highUserId: string; updatedAt: string; pendingFirstMessageUserId?: string; openMessagingDay?: string };
export type LocalSocialMessage = { messageId: string; conversationId: string; clientMessageId: string; senderUserId: string; body: string; attachments?: import('@gameing/contracts/social').SocialMessageAttachmentDto[]; createdAt: string };
export type LocalEncryptedAsset = { assetId: string; ownerUserId: string; authorizedUserIds: string[]; kind: import('@gameing/contracts/social').SocialMessageAttachmentKindValue; mimeType: string; fileName: string; byteSize: number; ciphertext: Blob; aes128Key: Uint8Array; hmacSha256Key: Uint8Array; createdAt: string };
export type LocalSocialContent = {
  contentId: string;
  contentType: 1 | 2;
  topicKey: string;
  postId: string;
  ownerUserId: string;
  createdAt: string;
  post?: SocialPostDto;
  reply?: SocialPostReplyDto;
};
export type LocalSocialInteraction = { interactionKey: string; actorUserId: string; targetType: 'POST' | 'REPLY' | 'USER'; targetId: string; action: 'DISLIKE' | 'FOLLOW_AUTHOR' | 'REPORT' | 'REPORT_USER' | 'BLOCK_USER'; active: boolean; reasonCode?: string; details?: string; createdAt: string; updatedAt: string };

export type LocalCredential = {
  credentialId: string;
  userId: string;
  kind: 'IDENTIFIER' | 'PASSWORD' | 'DEVICE' | 'RECOVERY' | 'TOTP' | 'TOTP_RECOVERY';
  identifierType?: 'USERNAME' | 'EMAIL' | 'PHONE';
  verified?: boolean;
  displayValue?: string;
  deviceId?: string;
  lookupKey?: string;
  secretHash?: string;
  credentialCiphertext?: string;
  salt?: string;
  state: 'PENDING' | 'ACTIVE' | 'REPLACED' | 'REVOKED' | 'EXPIRED';
  expiresAt?: string;
  pendingExpiresAt?: string;
};

export type LocalSession = {
  sessionId: string;
  userId: string;
  deviceId: string;
  refreshFamilyId: string;
  refreshHash: string;
  authVersion: number;
  state: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
  refreshExpiresAt: string;
};

export type LocalChallenge = {
  challengeId: string;
  type: 'LOGIN_TOTP' | 'CONTACT_EMAIL' | 'CONTACT_PHONE' | 'TOTP_SETUP';
  userId?: string;
  identifierKey?: string;
  targetValue?: string;
  expectedCodeHash?: string;
  secretCiphertext?: string;
  state: 'ACTIVE' | 'CONSUMED' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
  failedAttempts: number;
};

export type LocalWelcomeGrant = {
  operationId: string;
  grantKey: string;
  userId: string;
  coins: string;
  turnoverRequirement: string;
  turnoverMultiplier: number;
  createdAt: string;
};

export type LocalAssetAccount = { accountId: string; userId: string; assetType: 1 | 2; amount: string; frozenAmount: string; version: number; status: 1 };
export type LocalAssetOperation = { operationId: string; idempotencyKey: string; operationType: 1 | 2 | 3 | 4 | 5 | 6 | 7; status: 1; createdAt: string; extra?: Record<string, string> };
export type LocalAssetEntry = { entryId: string; operationId: string; accountId: string; delta: string; frozenDelta?: string; balanceAfter: string; createdAt: string };
export type LocalAssetHold = { holdId: string; userId: string; accountId: string; businessType: 'COIN_MARKET_LISTING'; businessId: string; initialAmount: string; remainingAmount: string; consumedAmount: string; releasedAmount: string; status: 1 | 2 | 3; createdAt: string; updatedAt: string };
export type LocalCoinMarketListing = { listingId: string; sellerUserId: string; sellerLabel?: string; idempotencyKey: string; coins: string; availableCoins: string; priceCentsPer1000Coins: string; referenceCentsPer1000Coins: string; totalCents: string; assetHoldId: string; paymentMethods: CoinMarketPaymentMethodValue[]; paymentInstructions: string; reservedCoins: string; soldCoins: string; status: 1 | 2 | 3 | 4 | 5; createdAt: string; updatedAt: string };
export type LocalCoinMarketTrade = { tradeId: string; listingId: string; buyerUserId: string; sellerUserId: string; coins: string; grossCents: string; status: (typeof CoinMarketTradeStatus)[keyof typeof CoinMarketTradeStatus]; paymentMethod: CoinMarketPaymentMethodValue; paymentInstructions: string; paymentDeadlineAt: string; sellerDeadlineAt: string | null; buyerEvidenceDeadlineAt: string | null; sellerEvidenceDeadlineAt: string | null; platformDecisionDeadlineAt: string | null; paymentProof: string | null; appealReason: string | null; buyerEvidence: string | null; sellerEvidence: string | null; idempotencyKey: string; createdAt: string; updatedAt: string };
export type LocalTurnoverState = { userId: string; remainingCoins: string; updatedAt: string };
export type LocalPayoutAccount = { payoutAccountId: string; userId: string; idempotencyKey: string; requestFingerprint: string; channelType: 1 | 2 | 3 | 4 | 5; accountLabel: string; maskedAccount: string; isDefault: boolean; status: 1; createdAt: string };
export type LocalWithdrawal = { withdrawalId: string; userId: string; payoutAccountId: string; payoutAccountLabel: string; maskedAccount: string; netCnyFen: string; feeCnyFen: string; debitCnyFen: string; status: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9; payoutNotBeforeAt: string; createdAt: string; idempotencyKey: string };
export type LocalOrder = { orderId: string; orderNo: string; userId: string; orderType: (typeof OrderType)[keyof typeof OrderType]; channelId: string; channelName: string; paymentMethod: (typeof FundingPaymentMethod)[keyof typeof FundingPaymentMethod]; amountCnyFen: string; creditCoins: string; rateCoinUnits: string; rateCashFen: string; status: (typeof FundingOrderStatus)[keyof typeof FundingOrderStatus]; idempotencyKey: string; paidEventId?: string; usdtAmountMilli?: string; usdtRateCnyPerUsdt?: string; depositAddress?: string; expiresAt?: string; createdAt: string; paidAt: string | null };
export type LocalSupportConversation = { conversationId: string; userId: string; categoryType: 1 | 2 | 3 | 4 | 5; subject: string; status: 1 | 2 | 3; lastMessageAt: string | null; createdAt: string; updatedAt: string };
export type LocalSupportMessage = { messageId: string; conversationId: string; messageKey: string; senderUserId: string; senderType: 1; bodyText: string; createdAt: string };

export type LocalCookie = {
  key: 'player-device' | 'player-refresh';
  nonce: Uint8Array;
  ciphertext: ArrayBuffer;
  updatedAt: string;
};

export type LocalSetting = { key: string; value: unknown };

export interface BrowserDevelopmentSchema extends DBSchema {
  users: { key: string; value: LocalUser; indexes: { 'by-friend-code': string; 'by-invite-code': string } };
  agent_domains: { key: string; value: LocalAgentDomain; indexes: { 'by-status': LocalAgentDomain['status'] } };
  referral_bindings: { key: string; value: LocalReferralBinding; indexes: { 'by-parent-1': string } };
  social_friendships: { key: string; value: LocalSocialFriendship; indexes: { 'by-low': string; 'by-high': string } };
  social_conversations: { key: string; value: LocalSocialConversation; indexes: { 'by-pair': string } };
  social_messages: { key: string; value: LocalSocialMessage; indexes: { 'by-conversation': [string, string]; 'by-client-id': string } };
  assets: { key: string; value: LocalEncryptedAsset; indexes: { 'by-owner-created': [string, string] } };
  social_content: { key: string; value: LocalSocialContent; indexes: { 'by-topic-created': [string, string]; 'by-post-created': [string, string] } };
  social_interactions: { key: string; value: LocalSocialInteraction; indexes: { 'by-key': string; 'by-actor-target': [string, string, string] } };
  credentials: {
    key: string;
    value: LocalCredential;
    indexes: { 'by-user-kind': [string, LocalCredential['kind']]; 'by-lookup': string; 'by-secret-hash': string };
  };
  sessions: { key: string; value: LocalSession; indexes: { 'by-user': string; 'by-refresh-family': string; 'by-refresh-hash': string } };
  challenges: { key: string; value: LocalChallenge; indexes: { 'by-user-type': [string, LocalChallenge['type']]; 'by-expiry': string } };
  welcome_grants: { key: string; value: LocalWelcomeGrant; indexes: { 'by-user': string; 'by-grant-key': string } };
  asset_accounts: { key: string; value: LocalAssetAccount; indexes: { 'by-user-asset': [string, 1 | 2] } };
  asset_operations: { key: string; value: LocalAssetOperation; indexes: { 'by-idempotency-key': string } };
  asset_entries: { key: string; value: LocalAssetEntry; indexes: { 'by-operation': string; 'by-account': string } };
  asset_holds: { key: string; value: LocalAssetHold; indexes: { 'by-user-status': [string, LocalAssetHold['status']]; 'by-business': [LocalAssetHold['businessType'], string] } };
  coin_market_listings: { key: string; value: LocalCoinMarketListing; indexes: { 'by-seller-created': [string, string]; 'by-seller-idempotency': [string, string] } };
  coin_market_trades: { key: string; value: LocalCoinMarketTrade; indexes: { 'by-buyer-created': [string, string]; 'by-seller-created': [string, string]; 'by-idempotency-key': [string, string] } };
  turnover_states: { key: string; value: LocalTurnoverState };
  payout_accounts: { key: string; value: LocalPayoutAccount; indexes: { 'by-user': string; 'by-idempotency-key': string } };
  wallet_withdrawals: { key: string; value: LocalWithdrawal; indexes: { 'by-user-created': [string, string]; 'by-idempotency-key': string } };
  orders: { key: string; value: LocalOrder; indexes: { 'by-user-created': [string, string]; 'by-idempotency-key': string } };
  support_conversations: { key: string; value: LocalSupportConversation; indexes: { 'by-user-updated': [string, string]; 'by-status-updated': [1 | 2 | 3, string] } };
  support_messages: { key: string; value: LocalSupportMessage; indexes: { 'by-conversation': [string, string]; 'by-message-key': string } };
  settings: { key: string; value: LocalSetting };
  local_cookie_jar: { key: LocalCookie['key']; value: LocalCookie };
}

const DATABASE_NAME = 'gameing_hall_browser_dev';
const DATABASE_VERSION = 16;

let opening: Promise<IDBPDatabase<BrowserDevelopmentSchema>> | undefined;

export function openBrowserDevelopmentDatabase(): Promise<IDBPDatabase<BrowserDevelopmentSchema>> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IDENTITY_STORAGE_UNAVAILABLE'));
  if (!opening) {
    opening = openDB<BrowserDevelopmentSchema>(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(database, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
        database.createObjectStore('users', { keyPath: 'userId' });
        const credentials = database.createObjectStore('credentials', { keyPath: 'credentialId' });
        credentials.createIndex('by-user-kind', ['userId', 'kind']);
        credentials.createIndex('by-lookup', 'lookupKey', { unique: true });
        credentials.createIndex('by-secret-hash', 'secretHash');
        const sessions = database.createObjectStore('sessions', { keyPath: 'sessionId' });
        sessions.createIndex('by-user', 'userId');
        sessions.createIndex('by-refresh-family', 'refreshFamilyId');
        sessions.createIndex('by-refresh-hash', 'refreshHash');
        const challenges = database.createObjectStore('challenges', { keyPath: 'challengeId' });
        challenges.createIndex('by-user-type', ['userId', 'type']);
        challenges.createIndex('by-expiry', 'expiresAt');
        const grants = database.createObjectStore('welcome_grants', { keyPath: 'operationId' });
        grants.createIndex('by-user', 'userId', { unique: true });
        database.createObjectStore('settings', { keyPath: 'key' });
        database.createObjectStore('local_cookie_jar', { keyPath: 'key' });
        }
        if (oldVersion < 2) {
          transaction.objectStore('welcome_grants').createIndex('by-grant-key', 'grantKey', { unique: true });
          const accounts = database.createObjectStore('asset_accounts', { keyPath: 'accountId' });
          accounts.createIndex('by-user-asset', ['userId', 'assetType'], { unique: true });
          const operations = database.createObjectStore('asset_operations', { keyPath: 'operationId' });
          operations.createIndex('by-idempotency-key', 'idempotencyKey', { unique: true });
          const entries = database.createObjectStore('asset_entries', { keyPath: 'entryId' });
          entries.createIndex('by-operation', 'operationId');
          entries.createIndex('by-account', 'accountId');
          database.createObjectStore('turnover_states', { keyPath: 'userId' });
        }
        if (oldVersion < 3) {
          const conversations = database.createObjectStore('support_conversations', { keyPath: 'conversationId' });
          conversations.createIndex('by-user-updated', ['userId', 'updatedAt']);
          conversations.createIndex('by-status-updated', ['status', 'updatedAt']);
          const messages = database.createObjectStore('support_messages', { keyPath: 'messageId' });
          messages.createIndex('by-conversation', ['conversationId', 'createdAt']);
          messages.createIndex('by-message-key', 'messageKey', { unique: true });
        }
        if (oldVersion < 4) {
          const users = transaction.objectStore('users');
          users.createIndex('by-friend-code', 'friendCode', { unique: true });
          const friendships = database.createObjectStore('social_friendships', { keyPath: 'pairKey' });
          friendships.createIndex('by-low', 'lowUserId');
          friendships.createIndex('by-high', 'highUserId');
          const conversations = database.createObjectStore('social_conversations', { keyPath: 'conversationId' });
          conversations.createIndex('by-pair', 'pairKey', { unique: true });
          const messages = database.createObjectStore('social_messages', { keyPath: 'messageId' });
          messages.createIndex('by-conversation', ['conversationId', 'createdAt']);
          messages.createIndex('by-client-id', 'clientMessageId', { unique: true });
        }
        if (oldVersion < 5) {
          const users = transaction.objectStore('users');
          users.createIndex('by-invite-code', 'inviteCode', { unique: true });
          const domains = database.createObjectStore('agent_domains', { keyPath: 'userId' });
          domains.createIndex('by-status', 'status');
        }
        if (oldVersion < 6) {
          const payoutAccounts = database.createObjectStore('payout_accounts', { keyPath: 'payoutAccountId' });
          payoutAccounts.createIndex('by-user', 'userId');
          const withdrawals = database.createObjectStore('wallet_withdrawals', { keyPath: 'withdrawalId' });
          withdrawals.createIndex('by-user-created', ['userId', 'createdAt']);
          withdrawals.createIndex('by-idempotency-key', 'idempotencyKey', { unique: true });
        }
        if (oldVersion < 7) transaction.objectStore('payout_accounts').createIndex('by-idempotency-key', 'idempotencyKey', { unique: true });
        if (oldVersion < 8) {
          const content = database.createObjectStore('social_content', { keyPath: 'contentId' });
          content.createIndex('by-topic-created', ['topicKey', 'createdAt']);
          content.createIndex('by-post-created', ['postId', 'createdAt']);
        }
        if (oldVersion < 9) {
          const content = transaction.objectStore('social_content') as unknown as IDBObjectStore;
          if (content.indexNames.contains('by-owner')) content.deleteIndex('by-owner');
        }
        if (oldVersion < 10) {
          const bindings = database.createObjectStore('referral_bindings', { keyPath: 'userId' });
          bindings.createIndex('by-parent-1', 'parent1UserId');
        }
        if (oldVersion < 11) {
          const orders = database.createObjectStore('orders', { keyPath: 'orderId' });
          orders.createIndex('by-user-created', ['userId', 'createdAt']);
          orders.createIndex('by-idempotency-key', 'idempotencyKey', { unique: true });
        }
        if (oldVersion < 12) {
          const holds = database.createObjectStore('asset_holds', { keyPath: 'holdId' });
          holds.createIndex('by-user-status', ['userId', 'status']);
          holds.createIndex('by-business', ['businessType', 'businessId'], { unique: true });
          const listings = database.createObjectStore('coin_market_listings', { keyPath: 'listingId' });
          listings.createIndex('by-seller-created', ['sellerUserId', 'createdAt']);
        }
        if (oldVersion < 13) {
          const listings = transaction.objectStore('coin_market_listings') as unknown as IDBObjectStore;
          if (listings.indexNames.contains('by-idempotency-key')) listings.deleteIndex('by-idempotency-key');
          listings.createIndex('by-seller-idempotency', ['sellerUserId', 'idempotencyKey'], { unique: true });
        }
        if (oldVersion < 14) {
          const trades = database.createObjectStore('coin_market_trades', { keyPath: 'tradeId' });
          trades.createIndex('by-buyer-created', ['buyerUserId', 'createdAt']);
          trades.createIndex('by-seller-created', ['sellerUserId', 'createdAt']);
          trades.createIndex('by-idempotency-key', ['buyerUserId', 'idempotencyKey'], { unique: true });
          const listingStore = transaction.objectStore('coin_market_listings') as unknown as IDBObjectStore;
          const cursorRequest = listingStore.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const value = cursor.value as LocalCoinMarketListing;
            if (!Array.isArray(value.paymentMethods)) cursor.update({ ...value, paymentMethods: [1], paymentInstructions: '', reservedCoins: '0', soldCoins: '0', status: 2 });
            cursor.continue();
          };
        }
        if (oldVersion < 15) {
          const interactions = database.createObjectStore('social_interactions', { keyPath: 'interactionKey' });
          interactions.createIndex('by-key', 'interactionKey', { unique: true });
          interactions.createIndex('by-actor-target', ['actorUserId', 'targetType', 'targetId']);
        }
        if (oldVersion < 16) {
          const assets = database.createObjectStore('assets', { keyPath: 'assetId' });
          assets.createIndex('by-owner-created', ['ownerUserId', 'createdAt']);
        }
      },
      blocked() {
        window.dispatchEvent(new CustomEvent('browser-database-upgrade-blocked'));
      },
      blocking() {
        opening = undefined;
      },
      terminated() {
        opening = undefined;
      },
    }).catch((error: unknown) => {
      opening = undefined;
      throw error;
    });
  }
  return opening;
}

export async function resetBrowserDevelopmentDatabase(): Promise<void> {
  (await opening)?.close();
  opening = undefined;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('IDENTITY_STORAGE_UNAVAILABLE'));
    request.onblocked = () => reject(new Error('IDENTITY_STORAGE_UPGRADE_BLOCKED'));
  });
}

export type BrowserDevelopmentDatabase = IDBPDatabase<BrowserDevelopmentSchema>;
