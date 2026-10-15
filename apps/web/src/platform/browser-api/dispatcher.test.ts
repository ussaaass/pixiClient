import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';
import { IdentityEndpoint } from '@gameing/contracts/identity';
import { resetBrowserDevelopmentDatabase } from './database';
import { BrowserApiServer, createBrowserApiFetch, createDevelopmentTestAccount, ensureLocalDeviceRegistration } from './dispatcher';
import { decryptRecoveryQrPayload, randomToken } from './crypto';
import { LocalIdentityApplication } from './identity/local-identity-application';
import { openBrowserDevelopmentDatabase } from './database';
import { BrowserPlayerIdentityAdapter } from './player-identity-adapter';
import { LocalCookieJar } from './local-cookie-jar';
import { createBrowserDevelopmentIdentity } from './composition';
import { createPlayerEntryApplication } from '../player-entry/player-entry-application';
import PlayerEntryPage from '../../components/PlayerEntryPage.vue';
import { clearLocalContactChallengeInbox, readLocalContactChallengeCode } from './identity/local-contact-challenge-inbox';
import { decodeBase32, generateTotp, verifyTotp } from './identity/totp';
import { WalletEndpoint } from '@gameing/contracts/wallet';
import { WalletErrorCode } from '@gameing/contracts/wallet';
import { SupportEndpoint, SupportCategoryType, SupportConversationStatus } from '@gameing/contracts/support';
import { SocialEndpoint } from '@gameing/contracts/social';
import { RewardType } from '@gameing/contracts/referral';
import { ReferralBindingStatus } from '@gameing/contracts/invite-agent';
import { InviteAgentEndpoint } from '@gameing/contracts/invite-agent';
import { IndexedDbWalletRepository } from './wallet/indexeddb-wallet-repository';
import { FundingOrderStatus, FundingPaymentMethod, WalletFundingDevelopmentEndpoint, WalletFundingEndpoint } from '@gameing/contracts/wallet-funding';

describe('Browser API identity dispatcher', () => {
  afterEach(async () => { clearLocalContactChallengeInbox(); await resetBrowserDevelopmentDatabase(); });

  it('validates real password credentials and returns a shared session envelope', async () => {
    const account = await createDevelopmentTestAccount();
    const server = new BrowserApiServer();
    const response = await server.handle(new Request(`http://local${IdentityEndpoint.passwordLogin.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'password-login-test' },
      body: JSON.stringify({ identifier: account.identifier, password: account.password }),
    }));
    const envelope = await response.json() as { data: { user: { userId: string }; accessToken: string; tokenType: string } };
    expect(response.status).toBe(200);
    expect(envelope.data.user.userId).toBe(account.userId);
    expect(envelope.data.accessToken.split('.')).toHaveLength(3);
    expect(envelope.data.tokenType).toBe('Bearer');
  });

  it('serves identity settings only for an active bearer session using the shared response DTO', async () => {
    const account = await createDevelopmentTestAccount();
    const fetchPort = await createBrowserApiFetch();
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    await identity.passwordLogin({ identifier: account.identifier, password: account.password });

    const settings = await identity.getIdentitySettings();
    expect(settings).toMatchObject({
      username: account.identifier,
      email: null,
      phone: null,
      passwordConfigured: true,
      totpEnabled: false,
      recoveryCredential: { available: true },
    });

    await identity.logout();
    await expect(identity.getIdentitySettings()).rejects.toMatchObject({ code: 'ACCESS_TOKEN_INVALID' });
  });

  it('supports authenticated friend lookup by friend code and username, requests, acceptance, and persistent direct messages', async () => {
    const first = await createDevelopmentTestAccount();
    const second = await createDevelopmentTestAccount();
    const fetchPort = await createBrowserApiFetch();
    const login = async (identifier: string, password: string): Promise<string> => {
      const response = await fetchPort(IdentityEndpoint.passwordLogin.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password }) });
      const body = await response.json() as { data: { accessToken: string } };
      expect(response.status).toBe(200);
      return body.data.accessToken;
    };
    const firstToken = await login(first.identifier, first.password);
    const secondToken = await login(second.identifier, second.password);
    const authorized = (token: string) => ({ Authorization: `Bearer ${token}` });
    const profileResponse = await fetchPort(SocialEndpoint.profile.path, { headers: authorized(firstToken) });
    const profileEnvelope = await profileResponse.json() as { data: { friendCode: string } };
    expect(profileResponse.status).toBe(200);

    const byCode = await fetchPort(SocialEndpoint.lookup.path, { method: 'POST', headers: { ...authorized(secondToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ value: profileEnvelope.data.friendCode }) });
    const byCodeEnvelope = await byCode.json() as { data: Array<{ userId: string }> };
    const byName = await fetchPort(SocialEndpoint.lookup.path, { method: 'POST', headers: { ...authorized(secondToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ value: first.identifier }) });
    expect(byCodeEnvelope.data[0]?.userId).toBe(first.userId);
    expect(((await byName.json()) as { data: Array<{ userId: string }> }).data[0]?.userId).toBe(first.userId);

    await fetchPort(SocialEndpoint.request.path, { method: 'POST', headers: { ...authorized(secondToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: first.userId }) });
    const pendingResponse = await fetchPort(SocialEndpoint.friends.path, { headers: authorized(firstToken) });
    expect(((await pendingResponse.json()) as { data: Array<{ state: string }> }).data[0]?.state).toBe('PENDING_INCOMING');
    const acceptPath = SocialEndpoint.accept.path.replace(':userId', second.userId);
    const acceptResponse = await fetchPort(acceptPath, { method: 'POST', headers: { ...authorized(firstToken), 'Content-Type': 'application/json' }, body: '{}' });
    expect(acceptResponse.status).toBe(200);

    const openResponse = await fetchPort(SocialEndpoint.conversation.path, { method: 'POST', headers: { ...authorized(secondToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: first.userId }) });
    const conversationId = ((await openResponse.json()) as { data: { conversationId: string } }).data.conversationId;
    const messagePath = SocialEndpoint.messages.path.replace(':conversationId', conversationId);
    const messageBody = { clientMessageId: crypto.randomUUID(), body: '你好，来练一局吗？' };
    const sent = await fetchPort(messagePath, { method: 'POST', headers: { ...authorized(secondToken), 'Content-Type': 'application/json' }, body: JSON.stringify(messageBody) });
    expect(sent.status, await sent.clone().text()).toBe(201);
    const history = await fetchPort(messagePath, { headers: authorized(firstToken) });
    expect(((await history.json()) as { data: { messages: Array<{ body: string }> } }).data.messages[0]?.body).toBe(messageBody.body);
    const retry = await fetchPort(messagePath, { method: 'POST', headers: { ...authorized(secondToken), 'Content-Type': 'application/json' }, body: JSON.stringify(messageBody) });
    expect(retry.status).toBe(201);
    const repeatedHistory = await fetchPort(messagePath, { headers: authorized(firstToken) });
    expect(((await repeatedHistory.json()) as { data: { messages: unknown[] } }).data.messages).toHaveLength(1);

    const third = await createDevelopmentTestAccount();
    const thirdToken = await login(third.identifier, third.password);
    await fetchPort(SocialEndpoint.request.path, { method: 'POST', headers: { ...authorized(thirdToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: first.userId }) });
    const rejectPath = SocialEndpoint.reject.path.replace(':userId', third.userId);
    const rejected = await fetchPort(rejectPath, { method: 'POST', headers: { ...authorized(firstToken), 'Content-Type': 'application/json' }, body: '{}' });
    expect(rejected.status).toBe(200);
    const removePath = SocialEndpoint.removeFriend.path.replace(':userId', second.userId);
    const removed = await fetchPort(removePath, { method: 'POST', headers: { ...authorized(firstToken), 'Content-Type': 'application/json' }, body: '{}' });
    expect(removed.status).toBe(200);
    const friendsAfterRemove = await fetchPort(SocialEndpoint.friends.path, { headers: authorized(firstToken) });
    expect(((await friendsAfterRemove.json()) as { data: unknown[] }).data).toHaveLength(0);
    const removedHistory = await fetchPort(messagePath, { headers: authorized(firstToken) });
    expect(removedHistory.status).toBe(200);
    const blockedSend = await fetchPort(messagePath, { method: 'POST', headers: { ...authorized(firstToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ clientMessageId: crypto.randomUUID(), body: '再次联系' }) });
    expect(blockedSend.status).toBe(409);
  });

  it('issues a reusable two-year invite link and persists a pending agent application that can be withdrawn', async () => {
    const account = await createDevelopmentTestAccount();
    const fetchPort = await createBrowserApiFetch();
    const login = await fetchPort(IdentityEndpoint.passwordLogin.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: account.identifier, password: account.password }) });
    const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const initial = await fetchPort(InviteAgentEndpoint.inviteLink.path, { headers });
    expect(((await initial.json()) as { data: unknown }).data).toBeNull();
    const created = await fetchPort(InviteAgentEndpoint.issueInviteLink.path, { method: 'POST', headers, body: '{}' });
    const invite = ((await created.json()) as { data: import('@gameing/contracts/invite-agent').InviteLinkDto }).data;
    const repeated = await fetchPort(InviteAgentEndpoint.issueInviteLink.path, { method: 'POST', headers, body: '{}' });
    expect(((await repeated.json()) as { data: { inviteCode: string } }).data.inviteCode).toBe(invite.inviteCode);
    expect(invite.url).toContain(`inviteCode=${invite.inviteCode}`);
    expect(Date.parse(invite.expiresAt) - Date.now()).toBeGreaterThan(729 * 24 * 60 * 60 * 1000);

    const applied = await fetchPort(InviteAgentEndpoint.applyAgentDomain.path, { method: 'POST', headers, body: JSON.stringify({ acknowledged: true }) });
    expect(applied.status).toBe(201);
    expect(((await applied.json()) as { data: { status: number } }).data.status).toBe(1);
    const duplicate = await fetchPort(InviteAgentEndpoint.applyAgentDomain.path, { method: 'POST', headers, body: JSON.stringify({ acknowledged: true }) });
    expect(duplicate.status).toBe(409);
    const withdrawn = await fetchPort(InviteAgentEndpoint.withdrawAgentDomain.path, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(((await withdrawn.json()) as { data: { withdrawn: boolean } }).data.withdrawn).toBe(true);
    const state = await fetchPort(InviteAgentEndpoint.agentDomain.path, { headers });
    expect(((await state.json()) as { data: { status: number } }).data.status).toBe(5);
    const reapplied = await fetchPort(InviteAgentEndpoint.applyAgentDomain.path, { method: 'POST', headers, body: JSON.stringify({ acknowledged: true }) });
    expect(reapplied.status).toBe(201);
    expect(((await reapplied.json()) as { data: { status: number } }).data.status).toBe(1);
  });

  it('captures an invite candidate for the configured TTL and binds the four-level ancestry on first local account creation', async () => {
    const inviter = await createDevelopmentTestAccount();
    const fetchPort = await createBrowserApiFetch();
    const login = await fetchPort(IdentityEndpoint.passwordLogin.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: inviter.identifier, password: inviter.password }) });
    const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const issued = await fetchPort(InviteAgentEndpoint.issueInviteLink.path, { method: 'POST', headers, body: '{}' });
    const invite = ((await issued.json()) as { data: import('@gameing/contracts/invite-agent').InviteLinkDto }).data;
    const database = await openBrowserDevelopmentDatabase();
    await database.put('settings', { key: 'system_config:referral.attribution.candidate_ttl_seconds', value: '120' });

    const captured = await fetchPort(InviteAgentEndpoint.captureAttribution.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteCode: invite.inviteCode }) });
    expect(captured.status).toBe(200);
    const capturedData = ((await captured.json()) as { data: { captured: boolean; expiresAt: string } }).data;
    expect(capturedData.captured).toBe(true);
    const expiry = Date.parse(capturedData.expiresAt);
    expect(expiry - Date.now()).toBeGreaterThan(119_000);
    expect(expiry - Date.now()).toBeLessThanOrEqual(120_000);

    const created = await ensureLocalDeviceRegistration(fetchPort, randomToken());
    expect(await database.get('referral_bindings', created.user.userId)).toMatchObject({ userId: created.user.userId, parent1UserId: inviter.userId, status: ReferralBindingStatus.ACTIVE });
  });

  it('hides and rejects social access when the direct parent uses customer-loss rewards', async () => {
    const inviter = await createDevelopmentTestAccount();
    const database = await openBrowserDevelopmentDatabase();
    const parent = await database.get('users', inviter.userId);
    await database.put('users', { ...parent!, rewardType: RewardType.CUSTOMER_LOSS_REBATE });
    const fetchPort = await createBrowserApiFetch();
    const login = await fetchPort(IdentityEndpoint.passwordLogin.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: inviter.identifier, password: inviter.password }) });
    const inviterToken = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
    const inviteResponse = await fetchPort(InviteAgentEndpoint.issueInviteLink.path, { method: 'POST', headers: { Authorization: `Bearer ${inviterToken}`, 'Content-Type': 'application/json' }, body: '{}' });
    const invite = ((await inviteResponse.json()) as { data: import('@gameing/contracts/invite-agent').InviteLinkDto }).data;
    const captured = await fetchPort(InviteAgentEndpoint.captureAttribution.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteCode: invite.inviteCode }) });
    expect(captured.status).toBe(200);

    const child = await ensureLocalDeviceRegistration(fetchPort, randomToken());
    const access = await fetchPort(SocialEndpoint.access.path, { headers: { Authorization: `Bearer ${child.accessToken}` } });
    expect(((await access.json()) as { data: { enabled: boolean } }).data.enabled).toBe(false);
    const profile = await fetchPort(SocialEndpoint.profile.path, { headers: { Authorization: `Bearer ${child.accessToken}` } });
    expect(profile.status).toBe(403);
    expect(((await profile.json()) as { code: string }).code).toBe('SOCIAL_ACCESS_DISABLED');
  });

  it('quotes and transfers coins by resolved recipient with 5% extra fee, turnover gating and idempotent balanced entries', async () => {
    const sender = await createDevelopmentTestAccount();
    const recipient = await createDevelopmentTestAccount();
    const database = await openBrowserDevelopmentDatabase();
    const walletRepository = new IndexedDbWalletRepository(database);
    await walletRepository.grantWelcomeGift(sender.userId);
    await walletRepository.grantWelcomeGift(recipient.userId);
    const fetchPort = await createBrowserApiFetch();
    const loginResponse = await fetchPort(IdentityEndpoint.passwordLogin.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: sender.identifier, password: sender.password }) });
    const token = ((await loginResponse.json()) as { data: { accessToken: string } }).data.accessToken;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const socialProfile = await fetchPort(SocialEndpoint.profile.path, { headers: { Authorization: `Bearer ${token}` } });
    const ownFriendCode = ((await socialProfile.json()) as { data: { friendCode: string } }).data.friendCode;
    const lookup = await fetchPort(SocialEndpoint.lookup.path, { method: 'POST', headers, body: JSON.stringify({ value: recipient.identifier }) });
    const found = ((await lookup.json()) as { data: Array<{ userId: string; displayName: string }> }).data[0];
    expect(found?.userId).toBe(recipient.userId);
    expect(ownFriendCode).toBeTruthy();

    const amount = { recipientUserId: recipient.userId, coins: '100' };
    const blocked = await fetchPort(WalletEndpoint.transferQuote.path, { method: 'POST', headers, body: JSON.stringify(amount) });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { code: string }).code).toBe(WalletErrorCode.TURNOVER_INCOMPLETE);
    await database.put('turnover_states', { userId: sender.userId, remainingCoins: '0', updatedAt: new Date().toISOString() });

    const quoteResponse = await fetchPort(WalletEndpoint.transferQuote.path, { method: 'POST', headers, body: JSON.stringify(amount) });
    expect(quoteResponse.status).toBe(200);
    const quote = ((await quoteResponse.json()) as { data: import('@gameing/contracts/wallet').WalletTransferQuoteDto }).data;
    expect(quote).toMatchObject({ coins: '100', feeCoins: '5', totalCoins: '105', feeRateBps: 500, recipientDisplayName: recipient.displayName });
    const changedQuote = await fetchPort(WalletEndpoint.transfer.path, { method: 'POST', headers, body: JSON.stringify({ quote: { ...quote, feeRateBps: 600 }, idempotencyKey: crypto.randomUUID() }) });
    expect(changedQuote.status).toBe(409);
    const expiredQuote = await fetchPort(WalletEndpoint.transfer.path, { method: 'POST', headers, body: JSON.stringify({ quote: { ...quote, expiresAt: '2026-01-01T00:00:00.000Z' }, idempotencyKey: crypto.randomUUID() }) });
    expect(expiredQuote.status).toBe(409);
    const overBalanceQuote = await fetchPort(WalletEndpoint.transferQuote.path, { method: 'POST', headers, body: JSON.stringify({ recipientUserId: recipient.userId, coins: '953' }) });
    const tooLarge = ((await overBalanceQuote.json()) as { data: import('@gameing/contracts/wallet').WalletTransferQuoteDto }).data;
    const insufficient = await fetchPort(WalletEndpoint.transfer.path, { method: 'POST', headers, body: JSON.stringify({ quote: tooLarge, idempotencyKey: crypto.randomUUID() }) });
    expect(insufficient.status).toBe(409);
    expect(((await insufficient.json()) as { code: string }).code).toBe(WalletErrorCode.INSUFFICIENT_AVAILABLE_BALANCE);
    const transferRequest = { quote, idempotencyKey: crypto.randomUUID() };
    const sent = await fetchPort(WalletEndpoint.transfer.path, { method: 'POST', headers, body: JSON.stringify(transferRequest) });
    expect(sent.status, await sent.clone().text()).toBe(201);
    const result = ((await sent.json()) as { data: import('@gameing/contracts/wallet').WalletTransferResultDto }).data;
    expect(result).toMatchObject({ recipientUserId: recipient.userId, coins: '100', feeCoins: '5', totalCoins: '105' });
    const repeated = await fetchPort(WalletEndpoint.transfer.path, { method: 'POST', headers, body: JSON.stringify(transferRequest) });
    expect(((await repeated.json()) as { data: { operationId: string } }).data.operationId).toBe(result.operationId);
    const conflictingRetry = await fetchPort(WalletEndpoint.transfer.path, { method: 'POST', headers, body: JSON.stringify({ ...transferRequest, quote: { ...quote, coins: '101', feeCoins: '6', totalCoins: '107' } }) });
    expect(conflictingRetry.status).toBe(409);

    const senderSummary = await walletRepository.getSummary(sender.userId);
    const recipientSummary = await walletRepository.getSummary(recipient.userId);
    expect(senderSummary.assets[0]).toMatchObject({ amount: '895', availableAmount: '895' });
    expect(recipientSummary.assets[0]).toMatchObject({ amount: '1100', availableAmount: '1100' });
    const operationEntries = await database.getAllFromIndex('asset_entries', 'by-operation', result.operationId);
    expect(operationEntries).toHaveLength(3);
    expect(operationEntries.reduce((sum, entry) => sum + BigInt(entry.delta), 0n)).toBe(0n);
    const senderActivity = await fetchPort(WalletEndpoint.activity.path, { headers: { Authorization: `Bearer ${token}` } });
    expect(((await senderActivity.json()) as { data: { items: Array<{ activityType: number; transferCoins?: string; feeCoins?: string }> } }).data.items[0]).toMatchObject({ activityType: 2, transferCoins: '100', feeCoins: '5' });
  });

  it('exchanges coins into cash atomically, floors fractional fen, snapshots the ratio, and retries idempotently', async () => {
    const account = await createDevelopmentTestAccount();
    const database = await openBrowserDevelopmentDatabase();
    const walletRepository = new IndexedDbWalletRepository(database);
    await walletRepository.grantWelcomeGift(account.userId);
    await database.put('turnover_states', { userId: account.userId, remainingCoins: '0', updatedAt: new Date().toISOString() });
    const settings = await database.getAll('settings');
    const systemUserId = settings.find((item) => item.key === 'wallet:system-user-id')?.value as string;
    await database.put('settings', { key: 'system_config:cny_to_coin_ratio', value: '1:3' });
    await database.put('asset_accounts', { accountId: `${systemUserId}:2`, userId: systemUserId, assetType: 2, amount: '1000', frozenAmount: '0', version: 1, status: 1 });
    const login = await (await createBrowserApiFetch())(IdentityEndpoint.passwordLogin.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: account.identifier, password: account.password }) });
    const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const quoteResponse = await (await createBrowserApiFetch())(WalletEndpoint.exchangeQuote.path, { method: 'POST', headers, body: JSON.stringify({ coins: '5' }) });
    expect(quoteResponse.status, await quoteResponse.clone().text()).toBe(200);
    const quote = ((await quoteResponse.json()) as { data: import('@gameing/contracts/wallet').WalletExchangeQuoteDto }).data;
    expect(quote).toMatchObject({ coins: '5', cnyFen: '166', rateCoinUnits: '3', rateCashFen: '100' });
    const request = { quote, idempotencyKey: crypto.randomUUID() };
    const exchanged = await (await createBrowserApiFetch())(WalletEndpoint.exchange.path, { method: 'POST', headers, body: JSON.stringify(request) });
    expect(exchanged.status, await exchanged.clone().text()).toBe(201);
    const result = ((await exchanged.json()) as { data: import('@gameing/contracts/wallet').WalletExchangeResultDto }).data;
    const retry = await (await createBrowserApiFetch())(WalletEndpoint.exchange.path, { method: 'POST', headers, body: JSON.stringify(request) });
    expect(((await retry.json()) as { data: { operationId: string } }).data.operationId).toBe(result.operationId);
    const entries = await database.getAllFromIndex('asset_entries', 'by-operation', result.operationId);
    expect(entries).toHaveLength(4);
    expect(entries.filter((entry) => entry.accountId.endsWith(':1')).reduce((sum, entry) => sum + BigInt(entry.delta), 0n)).toBe(0n);
    expect(entries.filter((entry) => entry.accountId.endsWith(':2')).reduce((sum, entry) => sum + BigInt(entry.delta), 0n)).toBe(0n);
    expect(await database.getFromIndex('asset_accounts', 'by-user-asset', [account.userId, 1])).toMatchObject({ amount: '995' });
    expect(await database.getFromIndex('asset_accounts', 'by-user-asset', [account.userId, 2])).toMatchObject({ amount: '166' });
  });

  it('adds a masked demo payout method, quotes net withdrawal with fee, holds funds, and releases them on cancellation', async () => {
    const account = await createDevelopmentTestAccount();
    const database = await openBrowserDevelopmentDatabase();
    const walletRepository = new IndexedDbWalletRepository(database);
    await walletRepository.grantWelcomeGift(account.userId);
    await database.put('turnover_states', { userId: account.userId, remainingCoins: '0', updatedAt: new Date().toISOString() });
    await database.put('asset_accounts', { accountId: `${account.userId}:2`, userId: account.userId, assetType: 2, amount: '20000', frozenAmount: '0', version: 1, status: 1 });
    const fetchPort = await createBrowserApiFetch();
    const login = await fetchPort(IdentityEndpoint.passwordLogin.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: account.identifier, password: account.password }) });
    const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const payoutRequest = { channelType: 1, accountLabel: '演练账户', accountReference: 'test-account-1234', idempotencyKey: crypto.randomUUID() };
    const payoutResponse = await fetchPort(WalletEndpoint.createPayoutAccount.path, { method: 'POST', headers, body: JSON.stringify(payoutRequest) });
    expect(payoutResponse.status, await payoutResponse.clone().text()).toBe(201);
    const payout = ((await payoutResponse.json()) as { data: import('@gameing/contracts/wallet').PayoutAccountDto }).data;
    expect(payout.maskedAccount).toBe('•••• 1234');
    const payoutRetry = await fetchPort(WalletEndpoint.createPayoutAccount.path, { method: 'POST', headers, body: JSON.stringify(payoutRequest) });
    expect(((await payoutRetry.json()) as { data: { payoutAccountId: string } }).data.payoutAccountId).toBe(payout.payoutAccountId);
    expect(await database.count('payout_accounts')).toBe(1);
    const tooSmall = await fetchPort(WalletEndpoint.withdrawalQuote.path, { method: 'POST', headers, body: JSON.stringify({ payoutAccountId: payout.payoutAccountId, netCnyFen: '9999' }) });
    expect(tooSmall.status).toBe(400);
    expect(((await tooSmall.json()) as { code: string }).code).toBe('WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID');
    const quoteResponse = await fetchPort(WalletEndpoint.withdrawalQuote.path, { method: 'POST', headers, body: JSON.stringify({ payoutAccountId: payout.payoutAccountId, netCnyFen: '10000' }) });
    expect(quoteResponse.status, await quoteResponse.clone().text()).toBe(200);
    const quote = ((await quoteResponse.json()) as { data: import('@gameing/contracts/wallet').WithdrawalQuoteDto }).data;
    expect(quote).toMatchObject({ netCnyFen: '10000', feeCnyFen: '500', debitCnyFen: '10500' });
    const request = { quote, idempotencyKey: crypto.randomUUID() };
    const createdResponse = await fetchPort(WalletEndpoint.createWithdrawal.path, { method: 'POST', headers, body: JSON.stringify(request) });
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
    const created = ((await createdResponse.json()) as { data: import('@gameing/contracts/wallet').WithdrawalDto }).data;
    const retry = await fetchPort(WalletEndpoint.createWithdrawal.path, { method: 'POST', headers, body: JSON.stringify(request) });
    expect(((await retry.json()) as { data: { withdrawalId: string } }).data.withdrawalId).toBe(created.withdrawalId);
    expect(await database.get('asset_accounts', `${account.userId}:2`)).toMatchObject({ amount: '20000', frozenAmount: '10500' });
    const cancelPath = WalletEndpoint.cancelWithdrawal.path.replace(':withdrawalId', created.withdrawalId);
    const cancelled = await fetchPort(cancelPath, { method: 'POST', headers, body: '{}' });
    expect(((await cancelled.json()) as { data: { status: number } }).data.status).toBe(7);
    expect(await database.get('asset_accounts', `${account.userId}:2`)).toMatchObject({ amount: '20000', frozenAmount: '0' });
  });

  it('creates a shared-DTO recharge order, credits the wallet once after an exact local mock payment, and exposes the ledger entry', async () => {
    const account = await createDevelopmentTestAccount();
    const database = await openBrowserDevelopmentDatabase();
    await new IndexedDbWalletRepository(database).grantWelcomeGift(account.userId);
    const fetchPort = await createBrowserApiFetch();
    const login = await fetchPort(IdentityEndpoint.passwordLogin.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: account.identifier, password: account.password }) });
    const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const channelsResponse = await fetchPort(WalletFundingEndpoint.channels.path, { headers });
    expect(channelsResponse.status).toBe(200);
    expect(((await channelsResponse.json()) as { data: Array<{ displayName: string }> }).data[0]?.displayName).toContain('本机模拟');

    const fractionalCoins = await fetchPort(WalletFundingEndpoint.createOrder.path, { method: 'POST', headers, body: JSON.stringify({ channelId: 'local-alipay', amountCnyFen: '1', idempotencyKey: crypto.randomUUID() }) });
    expect(fractionalCoins.status).toBe(400);
    expect(((await fractionalCoins.json()) as { code: string }).code).toBe('INVALID_ORDER_AMOUNT');
    expect(await database.count('orders')).toBe(0);

    const createRequest = { channelId: 'local-alipay', amountCnyFen: '1000', idempotencyKey: crypto.randomUUID() };
    const createdResponse = await fetchPort(WalletFundingEndpoint.createOrder.path, { method: 'POST', headers, body: JSON.stringify(createRequest) });
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
    const order = ((await createdResponse.json()) as { data: import('@gameing/contracts/wallet-funding').FundingOrderDto }).data;
    expect(order).toMatchObject({ amountCnyFen: '1000', creditCoins: '100', status: 1 });
    const createRetry = await fetchPort(WalletFundingEndpoint.createOrder.path, { method: 'POST', headers, body: JSON.stringify(createRequest) });
    expect(((await createRetry.json()) as { data: { orderId: string } }).data.orderId).toBe(order.orderId);

    const paymentEventId = crypto.randomUUID();
    const mismatch = await fetchPort(WalletFundingDevelopmentEndpoint.simulatePayment.path, { method: 'POST', headers, body: JSON.stringify({ orderId: order.orderId, paidAmountCnyFen: '1001', paymentEventId }) });
    expect(mismatch.status).toBe(409);
    expect(await database.get('asset_accounts', `${account.userId}:1`)).toMatchObject({ amount: '1000' });

    const paidRequest = { orderId: order.orderId, paidAmountCnyFen: order.amountCnyFen, paymentEventId };
    const paidResponse = await fetchPort(WalletFundingDevelopmentEndpoint.simulatePayment.path, { method: 'POST', headers, body: JSON.stringify(paidRequest) });
    expect(paidResponse.status, await paidResponse.clone().text()).toBe(200);
    expect(((await paidResponse.json()) as { data: { status: number } }).data.status).toBe(2);
    const paidRetry = await fetchPort(WalletFundingDevelopmentEndpoint.simulatePayment.path, { method: 'POST', headers, body: JSON.stringify(paidRequest) });
    expect(((await paidRetry.json()) as { data: { status: number } }).data.status).toBe(2);
    expect(await database.get('asset_accounts', `${account.userId}:1`)).toMatchObject({ amount: '1100' });
    expect(await database.count('asset_operations')).toBe(2);
    const fundingOperation = await database.getFromIndex('asset_operations', 'by-idempotency-key', `funding:${order.orderId}`);
    const purchaseEntries = await database.getAllFromIndex('asset_entries', 'by-operation', fundingOperation!.operationId);
    expect(purchaseEntries.map((entry) => entry.delta).sort()).toEqual(['-100', '100', '1000']);
    const systemUserId = (await database.get('settings', 'wallet:system-user-id'))?.value as string;
    expect(await database.get('asset_accounts', `${systemUserId}:2`)).toMatchObject({ amount: '1000' });
    const listed = await fetchPort(WalletEndpoint.activity.path, { headers });
    const entries = ((await listed.json()) as { data: { items: Array<{ activityType: number; purchaseOrderNo?: string; purchaseAmountCnyFen?: string }> } }).data.items;
    expect(entries).toContainEqual(expect.objectContaining({ activityType: 5, purchaseOrderNo: order.orderNo, purchaseAmountCnyFen: '1000' }));
  });

  it('snapshots the configured TRON FX rate and allocates unique increasing USDT invoice suffixes before mock settlement', async () => {
    const account = await createDevelopmentTestAccount();
    const database = await openBrowserDevelopmentDatabase();
    await new IndexedDbWalletRepository(database).grantWelcomeGift(account.userId);
    await database.put('settings', { key: 'system_config:fx.usdt_cny_rate', value: '6.7' });
    await database.put('settings', { key: 'system_config:usdt.deposit_window_minutes', value: '15' });
    const fetchPort = await createBrowserApiFetch();
    const login = await fetchPort(IdentityEndpoint.passwordLogin.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: account.identifier, password: account.password }) });
    const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const channels = await fetchPort(WalletFundingEndpoint.channels.path, { headers });
    expect(((await channels.json()) as { data: Array<{ paymentMethod: number }> }).data).toContainEqual(expect.objectContaining({ paymentMethod: FundingPaymentMethod.USDT_TRON }));

    const create = (idempotencyKey: string) => fetchPort(WalletFundingEndpoint.createOrder.path, { method: 'POST', headers, body: JSON.stringify({ channelId: 'local-usdt-tron', amountCnyFen: '10000', idempotencyKey }) });
    const firstResponse = await create(crypto.randomUUID());
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(201);
    const first = ((await firstResponse.json()) as { data: import('@gameing/contracts/wallet-funding').FundingOrderDto }).data;
    const secondResponse = await create(crypto.randomUUID());
    expect(secondResponse.status, await secondResponse.clone().text()).toBe(201);
    const second = ((await secondResponse.json()) as { data: import('@gameing/contracts/wallet-funding').FundingOrderDto }).data;
    expect(first.usdtInvoice).toMatchObject({ displayAmountUsdt: '14.910', rateCnyPerUsdt: '6.7' });
    expect(second.usdtInvoice).toMatchObject({ displayAmountUsdt: '14.911', rateCnyPerUsdt: '6.7' });
    expect(first.usdtInvoice?.expiresAt).toBe(second.usdtInvoice?.expiresAt);
    expect(first.usdtInvoice?.depositAddress).toContain('NOT-AN-ADDRESS');

    await database.put('settings', { key: 'system_config:fx.usdt_cny_rate', value: '8.0' });
    const wrongAmount = await fetchPort(WalletFundingDevelopmentEndpoint.simulatePayment.path, { method: 'POST', headers, body: JSON.stringify({ orderId: first.orderId, paidAmountUsdtMilli: '14911', paymentEventId: crypto.randomUUID() }) });
    expect(wrongAmount.status).toBe(409);
    expect(await database.get('asset_accounts', `${account.userId}:1`)).toMatchObject({ amount: '1000' });

    const paidRequest = { orderId: first.orderId, paidAmountUsdtMilli: first.usdtInvoice!.amountUsdtMilli, paymentEventId: crypto.randomUUID() };
    const paid = await fetchPort(WalletFundingDevelopmentEndpoint.simulatePayment.path, { method: 'POST', headers, body: JSON.stringify(paidRequest) });
    expect(paid.status, await paid.clone().text()).toBe(200);
    const paidRetry = await fetchPort(WalletFundingDevelopmentEndpoint.simulatePayment.path, { method: 'POST', headers, body: JSON.stringify(paidRequest) });
    expect(paidRetry.status).toBe(200);
    expect(await database.get('asset_accounts', `${account.userId}:1`)).toMatchObject({ amount: '2000' });
    const pendingSecond = await database.get('orders', second.orderId);
    await database.put('orders', { ...pendingSecond!, expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const listedOrders = await fetchPort(WalletFundingEndpoint.orders.path, { headers });
    const listed = ((await listedOrders.json()) as { data: Array<{ orderId: string; status: number }> }).data;
    expect(listed.find((item) => item.orderId === second.orderId)?.status).toBe(FundingOrderStatus.EXPIRED);
    const expiredReplay = await fetchPort(WalletFundingDevelopmentEndpoint.simulatePayment.path, { method: 'POST', headers, body: JSON.stringify({ orderId: second.orderId, paidAmountUsdtMilli: second.usdtInvoice!.amountUsdtMilli, paymentEventId: crypto.randomUUID() }) });
    expect(expiredReplay.status).toBe(409);
    expect(await database.get('asset_accounts', `${account.userId}:1`)).toMatchObject({ amount: '2000' });
  });

  it('requires a verified contact or username plus password before a device-only account can quote withdrawal', async () => {
    const fetchPort = await createBrowserApiFetch();
    const session = await ensureLocalDeviceRegistration(fetchPort, randomToken());
    const headers = { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' };
    const payout = await fetchPort(WalletEndpoint.createPayoutAccount.path, { method: 'POST', headers, body: JSON.stringify({ channelType: 1, accountLabel: '演练方式', accountReference: 'test-identity-1234', idempotencyKey: crypto.randomUUID() }) });
    const payoutId = ((await payout.json()) as { data: { payoutAccountId: string } }).data.payoutAccountId;
    const quote = await fetchPort(WalletEndpoint.withdrawalQuote.path, { method: 'POST', headers, body: JSON.stringify({ payoutAccountId: payoutId, netCnyFen: '10000' }) });
    expect(quote.status).toBe(403);
    expect(((await quote.json()) as { code: string }).code).toBe('WITHDRAWAL_IDENTITY_REQUIRED');
  });

  it('grants the welcome gift once with balanced ledger entries and exposes the turnover summary', async () => {
    const fetchPort = await createBrowserApiFetch();
    const deviceCode = randomToken();
    const session = await ensureLocalDeviceRegistration(fetchPort, deviceCode);
    const database = await openBrowserDevelopmentDatabase();
    const wallet = await fetchPort(WalletEndpoint.summary.path, { headers: { Authorization: `Bearer ${session.accessToken}` } });
    const envelope = await wallet.json() as { data: import('@gameing/contracts/wallet').WalletSummaryResponseDto };
    const activityResponse = await fetchPort(WalletEndpoint.activity.path, { headers: { Authorization: `Bearer ${session.accessToken}` } });
    const activityEnvelope = await activityResponse.json() as { data: import('@gameing/contracts/wallet').WalletActivityResponseDto };
    expect(wallet.status).toBe(200);
    expect(activityResponse.status).toBe(200);
    expect(envelope.data).toMatchObject({
      assets: [
        { currency: 'COIN', amount: '1000', availableAmount: '1000' },
        { currency: 'CNY', amount: '0', availableAmount: '0' },
      ],
      turnover: { remainingCoins: '5000', canTransferOrWithdraw: false },
      welcomeGift: { coins: '1000', turnoverRequirement: '5000' },
    });
    const grantsBeforeRetry = await database.getAll('welcome_grants');
    expect(grantsBeforeRetry).toHaveLength(1);
    await ensureLocalDeviceRegistration(fetchPort, deviceCode);
    expect(await database.getAll('welcome_grants')).toHaveLength(1);
    expect(await database.getAll('asset_operations')).toHaveLength(1);
    const entries = await database.getAll('asset_entries');
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.delta).sort()).toEqual(['-1000', '1000']);
    expect(entries[0]?.operationId).toBe(entries[1]?.operationId);
    expect(activityEnvelope.data.items).toHaveLength(1);
    expect(activityEnvelope.data.nextCursor).toBeNull();
    expect(activityEnvelope.data.items[0]).toMatchObject({
      operationId: entries[0]?.operationId,
      activityType: 1,
      assetType: 1,
      currency: 'COIN',
      delta: '1000',
      balanceAfter: '1000',
    });
  });

  it('restores the same device account through the local cookie jar after a fresh browser API adapter is created', async () => {
    const firstFetch = await createBrowserApiFetch();
    const registered = await ensureLocalDeviceRegistration(firstFetch, randomToken());
    const secondFetch = await createBrowserApiFetch();
    const deviceResponse = await secondFetch('/api/v1/auth/device-credential', { method: 'GET' });
    expect((await deviceResponse.json() as { data: { available: boolean } }).data.available).toBe(true);
    const loginResponse = await secondFetch('/api/v1/auth/device-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const loggedIn = await loginResponse.json() as { data: { user: { userId: string } } };
    expect(loggedIn.data.user.userId).toBe(registered.user.userId);
    const database = await openBrowserDevelopmentDatabase();
    expect((await database.getAllFromIndex('welcome_grants', 'by-user', registered.user.userId))).toHaveLength(1);
  });

  it('does not expose wallet balances without an active bearer session', async () => {
    const response = await (await createBrowserApiFetch())(WalletEndpoint.summary.path);
    const payload = await response.json() as { code: string; data: null };
    expect(response.status).toBe(401);
    expect(payload).toMatchObject({ code: 'ACCESS_TOKEN_INVALID', data: null });
    const activity = await (await createBrowserApiFetch())(WalletEndpoint.activity.path);
    expect(activity.status).toBe(401);
  });

  it('paginates the authenticated user ledger with a stable timestamp and entry cursor', async () => {
    const fetchPort = await createBrowserApiFetch();
    const session = await ensureLocalDeviceRegistration(fetchPort, randomToken());
    const database = await openBrowserDevelopmentDatabase();
    const account = await database.getFromIndex('asset_accounts', 'by-user-asset', [session.user.userId, 1]);
    expect(account).toBeDefined();
    const transaction = database.transaction(['asset_operations', 'asset_entries'], 'readwrite');
    for (let index = 0; index < 51; index++) {
      const operationId = (10_000n + BigInt(index)).toString();
      const entryId = (20_000n + BigInt(index)).toString();
      const occurredAt = new Date(Date.UTC(2025, 0, 1) + index * 1_000).toISOString();
      await transaction.objectStore('asset_operations').put({ operationId, idempotencyKey: `pagination-fixture:${index}`, operationType: 1, status: 1, createdAt: occurredAt });
      await transaction.objectStore('asset_entries').put({ entryId, operationId, accountId: account!.accountId, delta: '1', balanceAfter: '1000', createdAt: occurredAt });
    }
    await transaction.done;
    const authorization = { Authorization: `Bearer ${session.accessToken}` };
    const firstResponse = await fetchPort(WalletEndpoint.activity.path, { headers: authorization });
    const first = (await firstResponse.json() as { data: import('@gameing/contracts/wallet').WalletActivityResponseDto }).data;
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    const nextResponse = await fetchPort(`${WalletEndpoint.activity.path}?cursor=${encodeURIComponent(first.nextCursor!)}`, { headers: authorization });
    const next = (await nextResponse.json() as { data: import('@gameing/contracts/wallet').WalletActivityResponseDto }).data;
    expect(next.items).toHaveLength(2);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...first.items, ...next.items].map((item) => item.entryId)).size).toBe(52);
    const malformed = await fetchPort(`${WalletEndpoint.activity.path}?cursor=invalid`, { headers: authorization });
    expect(malformed.status).toBe(400);
  });

  it('creates, resumes, replies to, and closes an owned support conversation idempotently', async () => {
    const fetchPort = await createBrowserApiFetch();
    const session = await ensureLocalDeviceRegistration(fetchPort, randomToken());
    const authorization = { Authorization: `Bearer ${session.accessToken}` };
    const createRequest = {
      categoryType: SupportCategoryType.ACCOUNT,
      subject: '无法使用恢复二维码',
      bodyText: '我需要人工协助核验账号。',
      messageKey: crypto.randomUUID(),
    };
    const createdResponse = await fetchPort(SupportEndpoint.createConversation.path, { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(createRequest) });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { data: { conversation: { conversationId: string; status: number }; firstMessage: { messageId: string } } };
    expect(created.data.conversation.status).toBe(SupportConversationStatus.WAITING_SUPPORT);
    const replay = await fetchPort(SupportEndpoint.createConversation.path, { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(createRequest) });
    expect((await replay.json() as typeof created).data).toEqual(created.data);

    const messagePath = SupportEndpoint.listMessages.path.replace(':conversationId', created.data.conversation.conversationId);
    const firstMessageResponse = await fetchPort(messagePath, { headers: authorization });
    expect(firstMessageResponse.status).toBe(200);
    expect((await firstMessageResponse.json() as { data: { messages: unknown[] } }).data.messages).toHaveLength(1);

    const reply = { bodyText: '我还可以提供注册时间。', messageKey: crypto.randomUUID() };
    const sent = await fetchPort(messagePath, { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(reply) });
    expect(sent.status).toBe(201);
    const replayedMessage = await fetchPort(messagePath, { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(reply) });
    expect((await replayedMessage.json() as { data: unknown }).data).toEqual((await sent.clone().json() as { data: unknown }).data);
    const refreshedMessages = await fetchPort(messagePath, { headers: authorization });
    expect((await refreshedMessages.json() as { data: { messages: unknown[] } }).data.messages).toHaveLength(2);
    const list = await fetchPort(SupportEndpoint.listConversations.path, { headers: authorization });
    expect((await list.json() as { data: Array<{ conversationId: string }> }).data).toHaveLength(1);

    const closePath = SupportEndpoint.closeConversation.path.replace(':conversationId', created.data.conversation.conversationId);
    const closed = await fetchPort(closePath, { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: '{}' });
    expect((await closed.json() as { data: { conversation: { status: number } } }).data.conversation.status).toBe(SupportConversationStatus.CLOSED);
    const rejected = await fetchPort(messagePath, { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...reply, messageKey: crypto.randomUUID() }) });
    expect(rejected.status).toBe(409);
  });

  it('prevents another account from reading an owned support conversation', async () => {
    const fetchPort = await createBrowserApiFetch();
    const owner = await ensureLocalDeviceRegistration(fetchPort, randomToken());
    const intruder = await ensureLocalDeviceRegistration(fetchPort, randomToken());
    const response = await fetchPort(SupportEndpoint.createConversation.path, {
      method: 'POST', headers: { Authorization: `Bearer ${owner.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryType: SupportCategoryType.OTHER, subject: '账号问题咨询', bodyText: '请协助检查。', messageKey: crypto.randomUUID() }),
    });
    const payload = await response.json() as { data: { conversation: { conversationId: string } } };
    const path = SupportEndpoint.listMessages.path.replace(':conversationId', payload.data.conversation.conversationId);
    const denied = await fetchPort(path, { headers: { Authorization: `Bearer ${intruder.accessToken}` } });
    expect(denied.status).toBe(404);
  });

  it('refreshes a stale access token once and clears local session when refresh is revoked', async () => {
    const fixture = await createDevelopmentTestAccount();
    const baseFetch = await createBrowserApiFetch();
    let refreshCount = 0;
    const fetchPort = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith(IdentityEndpoint.refresh.path)) {
        refreshCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return baseFetch(input, init);
    };
    let current: import('@gameing/contracts/identity').SessionResponseDto | undefined;
    const identity = new BrowserPlayerIdentityAdapter(fetchPort, (session) => { current = session; });
    await identity.passwordLogin({ identifier: fixture.identifier, password: fixture.password });
    const original = identity.currentSession!;
    identity.acceptSession({ ...original, accessToken: 'expired.access.token' });

    await expect(Promise.all([identity.getIdentitySettings(), identity.getIdentitySettings()])).resolves.toEqual([
      expect.objectContaining({ passwordConfigured: true }),
      expect.objectContaining({ passwordConfigured: true }),
    ]);
    expect(refreshCount).toBe(1);
    expect(identity.currentSession?.accessToken).not.toBe('expired.access.token');
    expect(current?.accessToken).toBe(identity.currentSession?.accessToken);

    const database = await openBrowserDevelopmentDatabase();
    const sessions = await database.getAllFromIndex('sessions', 'by-user', fixture.userId);
    const activeSession = sessions.find((session) => session.state === 'ACTIVE')!;
    await database.put('sessions', { ...activeSession, state: 'REVOKED' });
    await expect(identity.getIdentitySettings()).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    expect(identity.currentSession).toBeUndefined();
    expect(current).toBeUndefined();

    await identity.passwordLogin({ identifier: fixture.identifier, password: fixture.password });
    await new LocalCookieJar().remove('player-refresh');
    identity.acceptSession({ ...identity.currentSession!, accessToken: 'revoked.access.token' });
    await expect(identity.getIdentitySettings()).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    expect(identity.currentSession).toBeUndefined();
    expect(current).toBeUndefined();
  });

  it('keeps the old recovery QR active until the new encrypted QR is generated, downloaded, and confirmed', async () => {
    const fixture = await createDevelopmentTestAccount();
    const fetchPort = await createBrowserApiFetch();
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    await identity.passwordLogin({ identifier: fixture.identifier, password: fixture.password });

    const old = await decryptRecoveryQrPayload(fixture.recoveryQrPayload, fixture.recoveryQrPassword);
    const prepared = await identity.prepareRecoveryCredential({ password: fixture.password, qrPassword: 'new-qr-password-2026' });
    const decoded = await decryptRecoveryQrPayload(prepared.qrPayload, 'new-qr-password-2026');
    expect(decoded).toMatchObject({ credentialId: prepared.credentialId, expiresAt: prepared.expiresAt, formatVersion: 1 });
    const rowsBeforeActivation = await (await openBrowserDevelopmentDatabase()).getAllFromIndex('credentials', 'by-user-kind', [fixture.userId, 'RECOVERY']);
    expect(rowsBeforeActivation.find((row) => row.credentialId === old.credentialId)?.state).toBe('ACTIVE');
    expect(rowsBeforeActivation.find((row) => row.credentialId === prepared.credentialId)?.state).toBe('PENDING');

    await identity.activateRecoveryCredential(prepared.credentialId);
    const rowsAfterActivation = await (await openBrowserDevelopmentDatabase()).getAllFromIndex('credentials', 'by-user-kind', [fixture.userId, 'RECOVERY']);
    expect(rowsAfterActivation.find((row) => row.credentialId === old.credentialId)?.state).toBe('REPLACED');
    expect(rowsAfterActivation.find((row) => row.credentialId === prepared.credentialId)?.state).toBe('ACTIVE');
    const recovered = new BrowserPlayerIdentityAdapter(fetchPort);
    await expect(recovered.recoverAccount({ credentialPayload: fixture.recoveryQrPayload, credentialPassword: fixture.recoveryQrPassword })).rejects.toMatchObject({ code: 'RECOVERY_CREDENTIAL_REPLACED' });
    await expect(recovered.recoverAccount({ credentialPayload: prepared.qrPayload, credentialPassword: 'new-qr-password-2026' })).resolves.toMatchObject({ outcome: 'RECOVERY_AUTHENTICATED' });
  });

  it('expires an unconfirmed recovery QR without revoking the current one', async () => {
    const fixture = await createDevelopmentTestAccount();
    const fetchPort = await createBrowserApiFetch();
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    await identity.passwordLogin({ identifier: fixture.identifier, password: fixture.password });
    const old = await decryptRecoveryQrPayload(fixture.recoveryQrPayload, fixture.recoveryQrPassword);
    const prepared = await identity.prepareRecoveryCredential({ password: fixture.password, qrPassword: 'new-qr-password-2026' });
    const database = await openBrowserDevelopmentDatabase();
    const pending = await database.get('credentials', prepared.credentialId);
    expect(pending?.state).toBe('PENDING');
    await database.put('credentials', { ...pending!, pendingExpiresAt: new Date(Date.now() - 1_000).toISOString() });

    await expect(identity.activateRecoveryCredential(prepared.credentialId)).rejects.toMatchObject({ code: 'RECOVERY_CREDENTIAL_PENDING_EXPIRED' });
    const rows = await database.getAllFromIndex('credentials', 'by-user-kind', [fixture.userId, 'RECOVERY']);
    expect(rows.find((row) => row.credentialId === old.credentialId)?.state).toBe('ACTIVE');
    expect(rows.filter((row) => row.state === 'ACTIVE')).toHaveLength(1);
    expect(rows.find((row) => row.credentialId === prepared.credentialId)?.state).toBe('EXPIRED');
  });

  it('keeps only the latest recovery QR preparation pending', async () => {
    const fixture = await createDevelopmentTestAccount();
    const fetchPort = await createBrowserApiFetch();
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    await identity.passwordLogin({ identifier: fixture.identifier, password: fixture.password });
    const first = await identity.prepareRecoveryCredential({ password: fixture.password, qrPassword: 'first-qr-password-2026' });
    const second = await identity.prepareRecoveryCredential({ password: fixture.password, qrPassword: 'second-qr-password-2026' });
    const rows = await (await openBrowserDevelopmentDatabase()).getAllFromIndex('credentials', 'by-user-kind', [fixture.userId, 'RECOVERY']);
    expect(rows.find((row) => row.credentialId === first.credentialId)?.state).toBe('EXPIRED');
    expect(rows.find((row) => row.credentialId === second.credentialId)?.state).toBe('PENDING');
    expect(rows.filter((row) => row.state === 'PENDING')).toHaveLength(1);
  });

  it('sets a username and changes the password through authenticated shared DTO endpoints', async () => {
    const fixture = await createDevelopmentTestAccount();
    const fetchPort = await createBrowserApiFetch();
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    await identity.passwordLogin({ identifier: fixture.identifier, password: fixture.password });
    const username = '玩家_2026';

    const updated = await identity.setUsername({ username, password: fixture.password });
    expect(updated.username).toBe(username);
    await expect(identity.setUsername({ username: 'bad!', password: fixture.password })).rejects.toMatchObject({ code: 'USERNAME_INVALID' });

    const secondDevice = new BrowserPlayerIdentityAdapter(fetchPort);
    await secondDevice.passwordLogin({ identifier: username, password: fixture.password });
    const sessionsBeforeChange = await (await openBrowserDevelopmentDatabase()).getAllFromIndex('sessions', 'by-user', fixture.userId);
    expect(sessionsBeforeChange.filter((session) => session.state === 'ACTIVE')).toHaveLength(2);

    expect(await identity.changePassword({ currentPassword: fixture.password, newPassword: 'changed-password-2026' })).toEqual({ changed: true });
    await expect(secondDevice.getIdentitySettings()).rejects.toMatchObject({ code: 'SESSION_REVOKED' });
    const sessionsAfterChange = await (await openBrowserDevelopmentDatabase()).getAllFromIndex('sessions', 'by-user', fixture.userId);
    expect(sessionsAfterChange.filter((session) => session.state === 'ACTIVE')).toHaveLength(1);
    await expect(identity.passwordLogin({ identifier: username, password: fixture.password })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    const nextIdentity = new BrowserPlayerIdentityAdapter(fetchPort);
    await nextIdentity.passwordLogin({ identifier: username, password: 'changed-password-2026' });
    expect(nextIdentity.currentSession?.user.userId).toBe(fixture.userId);
  });

  it('lets a first-device account create its password before username, then log in with both', async () => {
    const fetchPort = await createBrowserApiFetch();
    const registered = await ensureLocalDeviceRegistration(fetchPort, randomToken());
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    identity.acceptSession(registered);

    await expect(identity.getIdentitySettings()).resolves.toMatchObject({ username: null, passwordConfigured: false });
    await expect(identity.changePassword({ newPassword: 'first-device-password-26' })).resolves.toEqual({ changed: true });
    await expect(identity.setUsername({ username: 'first_device_user', password: 'first-device-password-26' })).resolves.toMatchObject({ username: 'first_device_user', passwordConfigured: true });

    const passwordLogin = new BrowserPlayerIdentityAdapter(fetchPort);
    await passwordLogin.passwordLogin({ identifier: 'first_device_user', password: 'first-device-password-26' });
    expect(passwordLogin.currentSession?.user.userId).toBe(registered.user.userId);
  });

  it('verifies and replaces an email through a one-time contact challenge, then releases the old address', async () => {
    const fetchPort = await createBrowserApiFetch();
    const firstFixture = await createDevelopmentTestAccount();
    const firstIdentity = new BrowserPlayerIdentityAdapter(fetchPort);
    await firstIdentity.passwordLogin({ identifier: firstFixture.identifier, password: firstFixture.password });

    const challenge = await firstIdentity.createContactChallenge({ contactType: 'EMAIL', contactValue: 'Player.One@Example.com', password: firstFixture.password });
    expect(challenge).toMatchObject({ challengeId: expect.any(String), expiresAt: expect.any(String) });
    expect(challenge).not.toHaveProperty('code');
    const firstCode = readLocalContactChallengeCode(firstFixture.userId, challenge.challengeId)!;
    expect(firstCode).toMatch(/^[0-9]{6}$/);
    const firstSettings = await firstIdentity.confirmContactChallenge(challenge.challengeId, { code: firstCode });
    expect(firstSettings.email).toEqual({ maskedValue: 'p••••••@example.com', verified: true });

    const replacement = await firstIdentity.createContactChallenge({ contactType: 'EMAIL', contactValue: 'new.address@example.net', password: firstFixture.password });
    const replacementCode = readLocalContactChallengeCode(firstFixture.userId, replacement.challengeId)!;
    const replacedSettings = await firstIdentity.confirmContactChallenge(replacement.challengeId, { code: replacementCode });
    expect(replacedSettings.email).toEqual({ maskedValue: 'n••••••@example.net', verified: true });

    const secondFixture = await createDevelopmentTestAccount();
    const secondIdentity = new BrowserPlayerIdentityAdapter(fetchPort);
    await secondIdentity.passwordLogin({ identifier: secondFixture.identifier, password: secondFixture.password });
    const releasedAddress = await secondIdentity.createContactChallenge({ contactType: 'EMAIL', contactValue: 'player.one@example.com', password: secondFixture.password });
    const releasedCode = readLocalContactChallengeCode(secondFixture.userId, releasedAddress.challengeId)!;
    expect((await secondIdentity.confirmContactChallenge(releasedAddress.challengeId, { code: releasedCode })).email?.verified).toBe(true);
  });

  it('rejects an invalid contact code, foreign challenge access, and duplicate contact ownership', async () => {
    const fetchPort = await createBrowserApiFetch();
    const fixture = await createDevelopmentTestAccount();
    const owner = new BrowserPlayerIdentityAdapter(fetchPort);
    await owner.passwordLogin({ identifier: fixture.identifier, password: fixture.password });
    const challenge = await owner.createContactChallenge({ contactType: 'PHONE', contactValue: '+14155550123', password: fixture.password });
    const validCode = readLocalContactChallengeCode(fixture.userId, challenge.challengeId)!;
    await expect(owner.confirmContactChallenge(challenge.challengeId, { code: validCode === '000000' ? '000001' : '000000' })).rejects.toMatchObject({ code: 'VERIFICATION_CODE_INVALID' });
    await expect(owner.createContactChallenge({ contactType: 'EMAIL', contactValue: 'not-an-email', password: fixture.password })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await owner.confirmContactChallenge(challenge.challengeId, { code: validCode });

    const foreignFixture = await createDevelopmentTestAccount();
    const foreign = new BrowserPlayerIdentityAdapter(fetchPort);
    await foreign.passwordLogin({ identifier: foreignFixture.identifier, password: foreignFixture.password });
    await expect(foreign.confirmContactChallenge(challenge.challengeId, { code: readLocalContactChallengeCode(fixture.userId, challenge.challengeId)! })).rejects.toMatchObject({ code: 'CHALLENGE_NOT_FOUND' });
    await expect(foreign.createContactChallenge({ contactType: 'PHONE', contactValue: '+14155550123', password: foreignFixture.password })).rejects.toMatchObject({ code: 'IDENTIFIER_ALREADY_USED' });
  });

  it('expires a contact challenge after five invalid codes without binding the address', async () => {
    const fixture = await createDevelopmentTestAccount();
    const fetchPort = await createBrowserApiFetch();
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    await identity.passwordLogin({ identifier: fixture.identifier, password: fixture.password });
    const challenge = await identity.createContactChallenge({ contactType: 'EMAIL', contactValue: 'attempts@example.test', password: fixture.password });
    const validCode = readLocalContactChallengeCode(fixture.userId, challenge.challengeId)!;
    const invalidCode = validCode === '000000' ? '000001' : '000000';

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(identity.confirmContactChallenge(challenge.challengeId, { code: invalidCode })).rejects.toMatchObject({ code: 'VERIFICATION_CODE_INVALID' });
    }
    await expect(identity.confirmContactChallenge(challenge.challengeId, { code: invalidCode })).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });
    await expect(identity.confirmContactChallenge(challenge.challengeId, { code: validCode })).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });
    await expect(identity.getIdentitySettings()).resolves.toMatchObject({ email: null });
  });

  it('rejects identity settings requests without a bearer access token', async () => {
    const server = new BrowserApiServer();
    const response = await server.handle(new Request(`http://local${IdentityEndpoint.identitySettings.path}`, { method: 'GET' }));
    const envelope = await response.json() as { code: string };
    expect(response.status).toBe(401);
    expect(envelope.code).toBe('ACCESS_TOKEN_INVALID');
  });

  it('decrypts the local recovery QR before the shared endpoint, creates a session, and leaves the credential reusable', async () => {
    const account = await createDevelopmentTestAccount();
    const fetchPort = await createBrowserApiFetch();
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    const application = createPlayerEntryApplication(identity);
    const command = { credentialPayload: account.recoveryQrPayload, credentialPassword: account.recoveryQrPassword };

    const recovered = await application.recoverAccount(command);
    expect(recovered.ok).toBe(true);
    expect(identity.currentSession?.user.userId).toBe(account.userId);

    const database = await openBrowserDevelopmentDatabase();
    const sessions = await database.getAllFromIndex('sessions', 'by-user', account.userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.state).toBe('ACTIVE');

    const recoveredAgain = await application.recoverAccount(command);
    expect(recoveredAgain.ok).toBe(true);
    const sessionsAfterSecondRecovery = await database.getAllFromIndex('sessions', 'by-user', account.userId);
    expect(sessionsAfterSecondRecovery).toHaveLength(2);
    expect(sessionsAfterSecondRecovery.filter((session) => session.state === 'ACTIVE')).toHaveLength(1);
    expect(sessionsAfterSecondRecovery.filter((session) => session.state === 'REVOKED')).toHaveLength(1);
  });

  it('rejects an incorrect recovery password before sending recovery secrets to the API', async () => {
    const account = await createDevelopmentTestAccount();
    const fetchPort = await createBrowserApiFetch();
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    const application = createPlayerEntryApplication(identity);
    await expect(application.recoverAccount({ credentialPayload: account.recoveryQrPayload, credentialPassword: 'wrong-password' })).rejects.toMatchObject({ code: 'RECOVERY_QR_INVALID' });
    expect(identity.currentSession).toBeUndefined();
  });

  it('does not authenticate unknown accounts or incorrect passwords', async () => {
    const server = new BrowserApiServer();
    const response = await server.handle(new Request(`http://local${IdentityEndpoint.passwordLogin.path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'nobody', password: 'wrong-password' }),
    }));
    const envelope = await response.json() as { code: string; data: unknown };
    expect(response.status).toBe(401);
    expect(envelope.code).toBe('INVALID_CREDENTIALS');
    expect(envelope.data).toBeNull();
  });

  it('registers a first-visit device and persists its local credential cookie', async () => {
    const fetchPort = await createBrowserApiFetch();
    const session = await ensureLocalDeviceRegistration(fetchPort, randomToken());
    expect(session.user.displayName).toMatch(/^游客/);
    const check = await fetchPort(IdentityEndpoint.deviceCredential.path, { method: 'GET', credentials: 'include' });
    const result = await check.json() as { data: { available: boolean } };
    expect(check.status).toBe(200);
    expect(result.data.available).toBe(true);
  });

  it('keeps an explicitly logged-out device signed out after reload until the player chooses device login', async () => {
    localStorage.removeItem('gameing-hall.browser-device-login-suppressed');
    const first = await createBrowserDevelopmentIdentity();
    await first.start();
    expect(first.sessionState.value).toBeDefined();

    const loggedOut = await first.application.logout();
    expect(loggedOut.ok).toBe(true);
    expect(first.sessionState.value).toBeUndefined();

    const afterReload = await createBrowserDevelopmentIdentity();
    await afterReload.start();
    expect(afterReload.sessionState.value).toBeUndefined();
    const deviceLogin = await afterReload.application.checkCurrentDevice();
    expect(deviceLogin.ok).toBe(true);
    expect(afterReload.sessionState.value).toBeDefined();
    expect(localStorage.getItem('gameing-hall.browser-device-login-suppressed')).toBeNull();
  });

  it('reuses the account when a lost registration response is retried with the same device code', async () => {
    const identity = await LocalIdentityApplication.create();
    const deviceCode = randomToken();
    const first = await identity.registerDevice({ deviceCode });
    const retry = await identity.registerDevice({ deviceCode });
    expect(retry.data.user.userId).toBe(first.data.user.userId);
    const database = await openBrowserDevelopmentDatabase();
    expect(await database.count('users')).toBe(1);
  });

  it('completes the visible password-login action through the local HTTP contract', async () => {
    const fixture = await createDevelopmentTestAccount();
    const fetchPort = await createBrowserApiFetch();
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    const application = createPlayerEntryApplication(identity);
    const host = document.createElement('div');
    document.body.append(host);
    let returnedToLobby = false;
    const app = createApp(PlayerEntryPage, { application, emblem: '/logo.svg', onBack: () => { returnedToLobby = true; } });
    app.mount(host);
    host.querySelector<HTMLButtonElement>('#entry-mode-password')!.click();
    await nextTick();
    const [identifier, password] = host.querySelectorAll<HTMLInputElement>('.player-entry-content input');
    identifier!.value = fixture.identifier;
    identifier!.dispatchEvent(new Event('input', { bubbles: true }));
    password!.value = fixture.password;
    password!.dispatchEvent(new Event('input', { bubbles: true }));
    host.querySelector<HTMLButtonElement>('.player-entry-content button[type="submit"]')!.click();
    const deadline = Date.now() + 3_000;
    while (!identity.currentSession && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    await nextTick();
    expect(returnedToLobby).toBe(true);
    expect(identity.currentSession?.user.userId).toBe(fixture.userId);
    app.unmount();
    host.remove();
  });

  it('enables TOTP, keeps its secret encrypted, authenticates a login challenge, and consumes a backup code once', async () => {
    const fixture = await createDevelopmentTestAccount();
    const fetchPort = await createBrowserApiFetch();
    const identity = new BrowserPlayerIdentityAdapter(fetchPort);
    await identity.passwordLogin({ identifier: fixture.identifier, password: fixture.password });

    const setup = await identity.startTotpSetup({ password: fixture.password });
    const setupSecret = new URL(setup.otpauthUri).searchParams.get('secret')!;
    const setupCode = await generateTotp(decodeBase32(setupSecret));
    await expect(identity.confirmTotpSetup({ setupId: setup.setupId, code: setupCode === '000000' ? '000001' : '000000' })).rejects.toMatchObject({ code: 'TOTP_INVALID' });
    const enabled = await identity.confirmTotpSetup({ setupId: setup.setupId, code: setupCode });
    expect(enabled.enabled).toBe(true);
    expect(enabled.recoveryCodes).toHaveLength(10);
    const db = await openBrowserDevelopmentDatabase();
    const records = await db.getAllFromIndex('credentials', 'by-user-kind', [fixture.userId, 'TOTP']);
    expect(records).toHaveLength(1);
    expect(records[0]?.credentialCiphertext).toBeTruthy();
    expect(records[0]?.credentialCiphertext).not.toContain(setupSecret);
    const backupRows = await db.getAllFromIndex('credentials', 'by-user-kind', [fixture.userId, 'TOTP_RECOVERY']);
    expect(backupRows).toHaveLength(10);
    expect(backupRows.some((row) => row.secretHash === enabled.recoveryCodes[0])).toBe(false);

    const secondIdentity = new BrowserPlayerIdentityAdapter(fetchPort);
    const challenge = await secondIdentity.passwordLogin({ identifier: fixture.identifier, password: fixture.password });
    expect(challenge).toMatchObject({ outcome: 'TOTP_CHALLENGE_REQUIRED', challengeId: expect.any(String) });
    const completed = await secondIdentity.passwordLogin({ identifier: fixture.identifier, password: fixture.password, challengeId: challenge.challengeId!, totp: enabled.recoveryCodes[0]! });
    expect(completed.outcome).toBe('PASSWORD_AUTHENTICATED');

    const thirdIdentity = new BrowserPlayerIdentityAdapter(fetchPort);
    const secondChallenge = await thirdIdentity.passwordLogin({ identifier: fixture.identifier, password: fixture.password });
    await expect(thirdIdentity.passwordLogin({ identifier: fixture.identifier, password: fixture.password, challengeId: secondChallenge.challengeId!, totp: enabled.recoveryCodes[0]! })).rejects.toMatchObject({ code: 'TOTP_INVALID' });
    const rotationCode = await generateTotp(decodeBase32(setupSecret));
    await expect(identity.rotateTotpRecoveryCodes({ code: '000000' })).rejects.toMatchObject({ code: 'TOTP_INVALID' });
    const rotated = await identity.rotateTotpRecoveryCodes({ code: rotationCode });
    expect(rotated.recoveryCodes).toHaveLength(10);
    const rotatedRows = await db.getAllFromIndex('credentials', 'by-user-kind', [fixture.userId, 'TOTP_RECOVERY']);
    expect(rotatedRows.filter((row) => row.state === 'ACTIVE')).toHaveLength(10);
    expect(rotatedRows.filter((row) => row.state === 'REVOKED')).toHaveLength(10);
    const oldBackupChallenge = await thirdIdentity.passwordLogin({ identifier: fixture.identifier, password: fixture.password });
    await expect(thirdIdentity.passwordLogin({ identifier: fixture.identifier, password: fixture.password, challengeId: oldBackupChallenge.challengeId!, totp: enabled.recoveryCodes[1]! })).rejects.toMatchObject({ code: 'TOTP_INVALID' });
    const newBackupIdentity = new BrowserPlayerIdentityAdapter(fetchPort);
    const newBackupChallenge = await newBackupIdentity.passwordLogin({ identifier: fixture.identifier, password: fixture.password });
    await expect(newBackupIdentity.passwordLogin({ identifier: fixture.identifier, password: fixture.password, challengeId: newBackupChallenge.challengeId!, totp: rotated.recoveryCodes[0]! })).resolves.toMatchObject({ outcome: 'PASSWORD_AUTHENTICATED' });
    const freshCode = await generateTotp(decodeBase32(setupSecret));
    await expect(identity.disableTotp({ password: fixture.password, code: freshCode })).resolves.toEqual({ enabled: false });
    await expect(identity.getIdentitySettings()).resolves.toMatchObject({ totpEnabled: false });
    expect((await db.getAllFromIndex('credentials', 'by-user-kind', [fixture.userId, 'TOTP_RECOVERY'])).every((row) => row.state === 'REVOKED')).toBe(true);
  });

  it('matches the RFC 6238 SHA-1 test vector and rejects malformed TOTP codes', async () => {
    const secret = new TextEncoder().encode('12345678901234567890');
    expect(await generateTotp(secret, 59_000)).toBe('287082');
    expect(await verifyTotp(secret, '287082', 59_000)).toBe(true);
    expect(await verifyTotp(secret, '12345', 59_000)).toBe(false);
  });
});
