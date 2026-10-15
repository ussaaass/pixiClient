import { Value } from '@sinclair/typebox/value';
import { IdentityEndpoint, ApiSuccessSchema, ApiFailureSchema, IdentityErrorCode, type ApiFailureDto, type ApiSuccessDto, type SessionResponseDto } from '@gameing/contracts/identity';
import { openBrowserDevelopmentDatabase, type BrowserDevelopmentDatabase, type LocalCredential, type LocalUser } from './database';
import { derivePasswordHash, randomToken, sha256 } from './crypto';
import { IdentityUseCaseError, LocalIdentityApplication, localCookieName, type LocalIdentityCookieState } from './identity/local-identity-application';
import { IndexedDbLocalIdentityRepository } from './identity/indexeddb-local-identity-repository';
import { verifyLocalAccessToken } from './local-jwt';
import { localContactChallengeInbox } from './identity/local-contact-challenge-inbox';
import { WalletActivityCursorSchema, WalletEndpoint, WalletErrorCode } from '@gameing/contracts/wallet';
import { IndexedDbWalletRepository } from './wallet/indexeddb-wallet-repository';
import { WalletUseCases } from '../wallet/wallet-application';
import { SupportEndpoint } from '@gameing/contracts/support';
import { SupportUseCases } from '../support/support-application';
import { IndexedDbSupportRepository } from './support/indexeddb-support-repository';
import { SocialEndpoint } from '@gameing/contracts/social';
import { IndexedDbSocialRepository } from './social/indexeddb-social-repository';
import { SocialFriendsUseCases } from '../social/social-friends-use-cases';
import { InviteAgentEndpoint, AgentDomainStatus, type AgentDomainDto, type InviteLinkDto } from '@gameing/contracts/invite-agent';
import type { LocalAgentDomain } from './database';
import { ReferralAttributionApplication } from '../../referral/referral-attribution-application';
import { IndexedDbReferralAttributionRepository } from './referral/indexeddb-referral-attribution-repository';
import { SocialAccessPolicy } from '../social/social-access-policy';
import { RewardType } from '@gameing/contracts/referral';
import { WalletFundingDevelopmentEndpoint, WalletFundingEndpoint, FundingErrorCode } from '@gameing/contracts/wallet-funding';
import { WalletFundingUseCases } from '../../wallet-funding/wallet-funding-application';
import { IndexedDbWalletFundingRepository } from './wallet/indexeddb-wallet-funding-repository';

type IdentityBody = { identifier?: string; password?: string; currentPassword?: string; newPassword?: string; username?: string; fingerprintVersion?: string; deviceCode?: string; deviceSummary?: { platform: string; browser: string }; credentialId?: string; recoverySecret?: string; totp?: string; setupId?: string; challengeId?: string; code?: string };
function json(status: number, body: unknown, cookies?: LocalIdentityCookieState): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  if (cookies) headers.set('x-local-cookie-state', JSON.stringify(cookies));
  return new Response(JSON.stringify(body), { status, headers });
}

function failure(status: number, code: string, message: string, requestId: string, cookies?: LocalIdentityCookieState): Response {
  const data: ApiFailureDto = { requestId, code, message, data: null, serverNow: new Date().toISOString() };
  if (!Value.Check(ApiFailureSchema, data)) throw new Error('INVALID_FAILURE_ENVELOPE');
  return json(status, data, cookies);
}

function success<T>(status: number, data: T, requestId: string, schema: Parameters<typeof ApiSuccessSchema>[0], cookies?: LocalIdentityCookieState): Response {
  const envelope: ApiSuccessDto<T> = { requestId, code: IdentityErrorCode.OK, message: 'OK', data, serverNow: new Date().toISOString() };
  if (!Value.Check(ApiSuccessSchema(schema), envelope)) throw new Error('INVALID_SUCCESS_ENVELOPE');
  return json(status, envelope, cookies);
}

async function nextId(database: BrowserDevelopmentDatabase): Promise<string> {
  const transaction = database.transaction('settings', 'readwrite');
  const current = await transaction.store.get('next-id');
  const id = typeof current?.value === 'string' ? BigInt(current.value) : 1n;
  await transaction.store.put({ key: 'next-id', value: (id + 1n).toString() });
  await transaction.done;
  return id.toString();
}

async function parseBody(request: Request): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD' || request.body === null) return undefined;
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('UNSUPPORTED_MEDIA_TYPE');
  const text = await request.text();
  if (!text.trim()) return undefined;
  if (text.length > 16_384) throw new Error('PAYLOAD_TOO_LARGE');
  try { return JSON.parse(text) as unknown; } catch { throw new Error('INVALID_JSON'); }
}

function cookie(request: Request, name: 'device' | 'refresh'): string | undefined {
  const cookieName = localCookieName(name);
  const header = request.headers.get('x-local-browser-cookie') ?? request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === cookieName) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

async function requireActor(request: Request, database: BrowserDevelopmentDatabase): Promise<{ userId: string; sessionId: string }> {
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const claims = token ? await verifyLocalAccessToken(token) : undefined;
  if (!claims) throw new IdentityUseCaseError(401, IdentityErrorCode.ACCESS_TOKEN_INVALID, 'A valid access token is required.');
  const repository = new IndexedDbLocalIdentityRepository(database);
  const sessions = await repository.listSessions(claims.sub);
  const activeSession = sessions.find((item) => item.sessionId === claims.sid && item.deviceId === claims.did && item.state === 'ACTIVE' && item.expiresAt > new Date().toISOString() && item.authVersion === claims.sessionVersion);
  const user = await repository.findUser(claims.sub);
  if (!activeSession || !user || user.status !== 'ACTIVE' || user.authVersion !== claims.sessionVersion) throw new IdentityUseCaseError(401, IdentityErrorCode.SESSION_REVOKED, 'The session is no longer active.');
  await new ReferralAttributionApplication(new IndexedDbReferralAttributionRepository(database)).bindCurrentCandidate(claims.sub);
  return { userId: claims.sub, sessionId: claims.sid };
}

async function socialAccessEnabled(database: BrowserDevelopmentDatabase, userId: string): Promise<boolean> {
  return new SocialAccessPolicy(new IndexedDbSocialRepository(database)).canUse(userId);
}

async function requireSocialActor(request: Request, database: BrowserDevelopmentDatabase): Promise<{ userId: string; sessionId: string }> {
  const actor = await requireActor(request, database);
  if (!await socialAccessEnabled(database, actor.userId)) throw new IdentityUseCaseError(403, 'SOCIAL_ACCESS_DISABLED', 'This social feature is unavailable.');
  return actor;
}

async function assertWithdrawalIdentityEligibility(database: BrowserDevelopmentDatabase, userId: string): Promise<void> {
  const [identifiers, passwords] = await Promise.all([
    database.getAllFromIndex('credentials', 'by-user-kind', [userId, 'IDENTIFIER']),
    database.getAllFromIndex('credentials', 'by-user-kind', [userId, 'PASSWORD']),
  ]);
  const hasVerifiedContact = identifiers.some((item) => item.state === 'ACTIVE' && (item.identifierType === 'EMAIL' || item.identifierType === 'PHONE'));
  const hasUsernameAndPassword = identifiers.some((item) => item.state === 'ACTIVE' && item.identifierType === 'USERNAME') && passwords.some((item) => item.state === 'ACTIVE');
  if (!hasVerifiedContact && !hasUsernameAndPassword) throw new IdentityUseCaseError(403, 'WITHDRAWAL_IDENTITY_REQUIRED', '绑定并验证邮箱或手机，或设置用户名和密码后才能申请提现。');
}

export class BrowserApiServer {
  async handle(request: Request): Promise<Response> {
    const requestId = request.headers.get('x-request-id')?.slice(0, 64) || crypto.randomUUID();
    const url = new URL(request.url);
    const routes = [...Object.values(IdentityEndpoint), WalletEndpoint.summary, WalletEndpoint.activity, WalletEndpoint.transferQuote, WalletEndpoint.transfer, WalletEndpoint.exchangeQuote, WalletEndpoint.exchange, WalletEndpoint.payoutAccounts, WalletEndpoint.createPayoutAccount, WalletEndpoint.withdrawalQuote, WalletEndpoint.withdrawals, WalletEndpoint.createWithdrawal, ...Object.values(WalletFundingEndpoint), WalletFundingDevelopmentEndpoint.simulatePayment, SupportEndpoint.listConversations, SupportEndpoint.createConversation, SocialEndpoint.access, SocialEndpoint.profile, SocialEndpoint.lookup, SocialEndpoint.friends, SocialEndpoint.request, SocialEndpoint.conversation, ...Object.values(InviteAgentEndpoint)];
    const contactConfirmMatch = /^\/api\/v1\/me\/identity\/contact-challenges\/([A-Za-z0-9-]{1,128})\/confirm$/.exec(url.pathname);
    const recoveryActivateMatch = /^\/api\/v1\/me\/security\/recovery-credentials\/([1-9][0-9]{0,19})\/activate$/.exec(url.pathname);
    const supportMessagesMatch = /^\/api\/v1\/me\/support\/conversations\/([1-9][0-9]{0,19})\/messages$/.exec(url.pathname);
    const supportCloseMatch = /^\/api\/v1\/me\/support\/conversations\/([1-9][0-9]{0,19})\/close$/.exec(url.pathname);
    const socialAcceptMatch = /^\/api\/v1\/me\/social\/friend-requests\/([1-9][0-9]{0,19})\/accept$/.exec(url.pathname);
    const socialRejectMatch = /^\/api\/v1\/me\/social\/friend-requests\/([1-9][0-9]{0,19})\/reject$/.exec(url.pathname);
    const socialRemoveMatch = /^\/api\/v1\/me\/social\/friends\/([1-9][0-9]{0,19})\/remove$/.exec(url.pathname);
    const socialMessagesMatch = /^\/api\/v1\/me\/social\/conversations\/([1-9][0-9]{0,19})\/messages$/.exec(url.pathname);
    const payoutAccountDeleteMatch = /^\/api\/v1\/me\/wallet\/payout-accounts\/([1-9][0-9]{0,19})$/.exec(url.pathname);
    const withdrawalCancelMatch = /^\/api\/v1\/me\/wallet\/withdrawals\/([1-9][0-9]{0,19})\/cancel$/.exec(url.pathname);
    const endpoint = routes.find((item) => item.path === url.pathname && item.method === request.method)
      ?? (contactConfirmMatch && request.method === IdentityEndpoint.confirmContactChallenge.method ? IdentityEndpoint.confirmContactChallenge : undefined);
    const dynamicEndpoint = supportMessagesMatch
      ? request.method === 'GET' ? SupportEndpoint.listMessages : request.method === 'POST' ? SupportEndpoint.sendMessage : undefined
      : supportCloseMatch && request.method === 'POST' ? SupportEndpoint.closeConversation : undefined;
    const walletDynamicEndpoint = payoutAccountDeleteMatch && request.method === 'DELETE' ? WalletEndpoint.deletePayoutAccount
      : withdrawalCancelMatch && request.method === 'POST' ? WalletEndpoint.cancelWithdrawal : undefined;
    const socialDynamicEndpoint = socialAcceptMatch && request.method === 'POST' ? SocialEndpoint.accept
      : socialRejectMatch && request.method === 'POST' ? SocialEndpoint.reject
        : socialRemoveMatch && request.method === 'POST' ? SocialEndpoint.removeFriend
      : socialMessagesMatch ? request.method === 'GET' ? SocialEndpoint.messages : request.method === 'POST' ? SocialEndpoint.sendMessage : undefined
        : undefined;
    const matchedEndpoint = endpoint
      ?? (recoveryActivateMatch && request.method === IdentityEndpoint.recoveryCredentialActivate.method ? IdentityEndpoint.recoveryCredentialActivate : undefined)
      ?? dynamicEndpoint ?? socialDynamicEndpoint ?? walletDynamicEndpoint;
    if (!matchedEndpoint) return failure(404, 'NOT_FOUND', 'The requested endpoint was not found.', requestId);
    const walletActivityCursor = url.pathname === WalletEndpoint.activity.path ? url.searchParams.get('cursor') ?? undefined : undefined;
    if (url.pathname === WalletEndpoint.activity.path && ([...url.searchParams.keys()].some((key) => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1 || (walletActivityCursor !== undefined && !Value.Check(WalletActivityCursorSchema, walletActivityCursor)))) {
      return failure(400, 'VALIDATION_FAILED', 'The wallet activity cursor is invalid.', requestId);
    }

    let body: unknown;
    try { body = await parseBody(request); }
    catch (error) {
      const code = error instanceof Error ? error.message : 'INVALID_JSON';
      const status = code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
      return failure(status, code, 'Request body is invalid.', requestId);
    }
    if ('request' in matchedEndpoint && !Value.Check(matchedEndpoint.request, body)) return failure(400, 'VALIDATION_FAILED', 'Request does not match the shared schema.', requestId);

    try {
      const database = await openBrowserDevelopmentDatabase();
      const identity = new LocalIdentityApplication(new IndexedDbLocalIdentityRepository(database), localContactChallengeInbox);
      if (url.pathname === InviteAgentEndpoint.captureAttribution.path && request.method === 'POST') {
        const inviteCode = (body as { inviteCode: string }).inviteCode;
        const result = await new ReferralAttributionApplication(new IndexedDbReferralAttributionRepository(database)).capture(inviteCode);
        return success(matchedEndpoint.successStatus, result, requestId, matchedEndpoint.response);
      }
      if (url.pathname === IdentityEndpoint.deviceRegister.path) {
        const input = body as IdentityBody;
        const existingCredential = await new IndexedDbLocalIdentityRepository(database).findCredentialBySecretHash(await sha256(input.deviceCode!));
        const result = await identity.registerDevice({ deviceCode: input.deviceCode! });
        if (!existingCredential) await new ReferralAttributionApplication(new IndexedDbReferralAttributionRepository(database)).bindCurrentCandidate(result.data.user.userId);
        await new WalletUseCases(new IndexedDbWalletRepository(database)).grantWelcomeGiftForRegisteredUser(result.data.user.userId);
        return success(matchedEndpoint.successStatus, result.data, requestId, matchedEndpoint.response, result.cookies);
      }

      if (url.pathname === WalletEndpoint.summary.path) {
        const actor = await requireActor(request, database);
        const summary = await new WalletUseCases(new IndexedDbWalletRepository(database)).getSummary(actor.userId);
        return success(matchedEndpoint.successStatus, summary, requestId, matchedEndpoint.response);
      }

      if (url.pathname === WalletFundingEndpoint.channels.path && request.method === 'GET') {
        await requireActor(request, database);
        return success(matchedEndpoint.successStatus, await new WalletFundingUseCases(new IndexedDbWalletFundingRepository(database)).listChannels(), requestId, matchedEndpoint.response);
      }
      if (url.pathname === WalletFundingEndpoint.orders.path && request.method === 'GET') {
        const actor = await requireActor(request, database);
        return success(matchedEndpoint.successStatus, await new WalletFundingUseCases(new IndexedDbWalletFundingRepository(database)).listOrders(actor.userId), requestId, matchedEndpoint.response);
      }
      if (url.pathname === WalletFundingEndpoint.createOrder.path && request.method === 'POST') {
        const actor = await requireActor(request, database);
        return success(matchedEndpoint.successStatus, await new WalletFundingUseCases(new IndexedDbWalletFundingRepository(database)).createOrder(actor.userId, body as import('@gameing/contracts/wallet-funding').CreateFundingOrderRequestDto), requestId, matchedEndpoint.response);
      }
      if (url.pathname === WalletFundingDevelopmentEndpoint.simulatePayment.path && request.method === 'POST') {
        const actor = await requireActor(request, database);
        return success(matchedEndpoint.successStatus, await new WalletFundingUseCases(new IndexedDbWalletFundingRepository(database)).simulatePayment(actor.userId, body as import('@gameing/contracts/wallet-funding').SimulateFundingPaymentRequestDto), requestId, matchedEndpoint.response);
      }

      if (url.pathname === WalletEndpoint.activity.path) {
        const actor = await requireActor(request, database);
        const activity = await new WalletUseCases(new IndexedDbWalletRepository(database)).getActivity(actor.userId, walletActivityCursor);
        return success(matchedEndpoint.successStatus, activity, requestId, matchedEndpoint.response);
      }
      if (url.pathname === WalletEndpoint.transferQuote.path) {
        const actor = await requireActor(request, database);
        const quote = await new WalletUseCases(new IndexedDbWalletRepository(database)).quoteTransfer(actor.userId, body as import('@gameing/contracts/wallet').WalletTransferQuoteRequestDto);
        return success(matchedEndpoint.successStatus, quote, requestId, matchedEndpoint.response);
      }
      if (url.pathname === WalletEndpoint.transfer.path) {
        const actor = await requireActor(request, database);
        const result = await new WalletUseCases(new IndexedDbWalletRepository(database)).transferCoins(actor.userId, body as import('@gameing/contracts/wallet').WalletTransferRequestDto);
        return success(matchedEndpoint.successStatus, result, requestId, matchedEndpoint.response);
      }
      if (url.pathname === WalletEndpoint.exchangeQuote.path) {
        const actor = await requireActor(request, database);
        const quote = await new WalletUseCases(new IndexedDbWalletRepository(database)).quoteExchange(actor.userId, body as import('@gameing/contracts/wallet').WalletExchangeQuoteRequestDto);
        return success(matchedEndpoint.successStatus, quote, requestId, matchedEndpoint.response);
      }
      if (url.pathname === WalletEndpoint.exchange.path) {
        const actor = await requireActor(request, database);
        const result = await new WalletUseCases(new IndexedDbWalletRepository(database)).exchangeCoins(actor.userId, body as import('@gameing/contracts/wallet').WalletExchangeRequestDto);
        return success(matchedEndpoint.successStatus, result, requestId, matchedEndpoint.response);
      }

      if (url.pathname === WalletEndpoint.payoutAccounts.path && request.method === 'GET') {
        const actor = await requireActor(request, database);
        return success(matchedEndpoint.successStatus, await new WalletUseCases(new IndexedDbWalletRepository(database)).listPayoutAccounts(actor.userId), requestId, matchedEndpoint.response);
      }
      if (url.pathname === WalletEndpoint.payoutAccounts.path && request.method === 'POST') {
        const actor = await requireActor(request, database);
        const input = body as import('@gameing/contracts/wallet').CreatePayoutAccountRequestDto;
        return success(matchedEndpoint.successStatus, await new WalletUseCases(new IndexedDbWalletRepository(database)).createPayoutAccount(actor.userId, input), requestId, matchedEndpoint.response);
      }
      if (payoutAccountDeleteMatch && request.method === 'DELETE') {
        const actor = await requireActor(request, database);
        return success(matchedEndpoint.successStatus, await new WalletUseCases(new IndexedDbWalletRepository(database)).deletePayoutAccount(actor.userId, payoutAccountDeleteMatch[1]!), requestId, matchedEndpoint.response);
      }
      if (url.pathname === WalletEndpoint.withdrawalQuote.path && request.method === 'POST') {
        const actor = await requireActor(request, database);
        await assertWithdrawalIdentityEligibility(database, actor.userId);
        return success(matchedEndpoint.successStatus, await new WalletUseCases(new IndexedDbWalletRepository(database)).quoteWithdrawal(actor.userId, body as import('@gameing/contracts/wallet').WithdrawalQuoteRequestDto), requestId, matchedEndpoint.response);
      }
      if (url.pathname === WalletEndpoint.withdrawals.path && request.method === 'GET') {
        const actor = await requireActor(request, database);
        return success(matchedEndpoint.successStatus, await new WalletUseCases(new IndexedDbWalletRepository(database)).listWithdrawals(actor.userId), requestId, matchedEndpoint.response);
      }
      if (url.pathname === WalletEndpoint.withdrawals.path && request.method === 'POST') {
        const actor = await requireActor(request, database);
        await assertWithdrawalIdentityEligibility(database, actor.userId);
        return success(matchedEndpoint.successStatus, await new WalletUseCases(new IndexedDbWalletRepository(database)).createWithdrawal(actor.userId, body as import('@gameing/contracts/wallet').CreateWithdrawalRequestDto), requestId, matchedEndpoint.response);
      }
      if (withdrawalCancelMatch && request.method === 'POST') {
        const actor = await requireActor(request, database);
        return success(matchedEndpoint.successStatus, await new WalletUseCases(new IndexedDbWalletRepository(database)).cancelWithdrawal(actor.userId, withdrawalCancelMatch[1]!), requestId, matchedEndpoint.response);
      }

      if (url.pathname === InviteAgentEndpoint.inviteLink.path || url.pathname === InviteAgentEndpoint.issueInviteLink.path) {
        const actor = await requireActor(request, database);
        const user = await database.get('users', actor.userId);
        if (!user) throw new IdentityUseCaseError(404, 'USER_NOT_FOUND', 'The account was not found.');
        let inviteCode = user.inviteCode;
        let expiresAt = user.inviteCodeExpiresAt;
        if (request.method === 'POST' && (!inviteCode || !expiresAt || expiresAt <= new Date().toISOString())) {
          const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
          const bytes = crypto.getRandomValues(new Uint8Array(10));
          inviteCode = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
          const expiration = new Date();
          expiration.setUTCFullYear(expiration.getUTCFullYear() + 2);
          expiresAt = expiration.toISOString();
          await database.put('users', { ...user, inviteCode, inviteCodeExpiresAt: expiresAt });
        }
        const link: InviteLinkDto | null = inviteCode && expiresAt && expiresAt > new Date().toISOString()
          ? { inviteCode, url: `${url.origin}/?inviteCode=${encodeURIComponent(inviteCode)}`, expiresAt }
          : null;
        return success(matchedEndpoint.successStatus, link, requestId, matchedEndpoint.response);
      }

      if (url.pathname === InviteAgentEndpoint.agentDomain.path) {
        const actor = await requireActor(request, database);
        const domain = await database.get('agent_domains', actor.userId);
        return success(matchedEndpoint.successStatus, domain ? toAgentDomainDto(domain) : null, requestId, matchedEndpoint.response);
      }
      if (url.pathname === InviteAgentEndpoint.applyAgentDomain.path && request.method === 'POST') {
        const actor = await requireActor(request, database);
        const previous = await database.get('agent_domains', actor.userId);
        if (previous && previous.status !== AgentDomainStatus.WITHDRAWN) return failure(409, 'AGENT_APPLICATION_EXISTS', '已有代理申请或代理域记录。', requestId);
        const appliedAt = new Date().toISOString();
        const domain: LocalAgentDomain = { userId: actor.userId, status: AgentDomainStatus.PENDING_REVIEW, appliedAt, capabilities: [], updatedAt: appliedAt };
        await database.put('agent_domains', domain);
        return success(matchedEndpoint.successStatus, toAgentDomainDto(domain), requestId, matchedEndpoint.response);
      }
      if (url.pathname === InviteAgentEndpoint.withdrawAgentDomain.path && request.method === 'DELETE') {
        const actor = await requireActor(request, database);
        const domain = await database.get('agent_domains', actor.userId);
        if (!domain || domain.status !== AgentDomainStatus.PENDING_REVIEW) return failure(409, 'AGENT_APPLICATION_NOT_WITHDRAWABLE', '当前状态不能撤回申请。', requestId);
        await database.put('agent_domains', { ...domain, status: AgentDomainStatus.WITHDRAWN, updatedAt: new Date().toISOString() });
        return success(matchedEndpoint.successStatus, { withdrawn: true }, requestId, matchedEndpoint.response);
      }

      const support = new SupportUseCases(new IndexedDbSupportRepository(database));
      const social = new SocialFriendsUseCases(new IndexedDbSocialRepository(database));
      if (url.pathname === SocialEndpoint.access.path) {
        const actor = await requireActor(request, database);
        return success(matchedEndpoint.successStatus, { enabled: await socialAccessEnabled(database, actor.userId) }, requestId, matchedEndpoint.response);
      }
      if (url.pathname === SocialEndpoint.profile.path) {
        const actor = await requireSocialActor(request, database);
        return success(matchedEndpoint.successStatus, await social.ownProfile(actor.userId), requestId, matchedEndpoint.response);
      }
      if (url.pathname === SocialEndpoint.lookup.path) {
        const actor = await requireSocialActor(request, database);
        const result = await social.lookup(actor.userId, (body as { value: string }).value);
        return success(matchedEndpoint.successStatus, result, requestId, matchedEndpoint.response);
      }
      if (url.pathname === SocialEndpoint.friends.path) {
        const actor = await requireSocialActor(request, database);
        return success(matchedEndpoint.successStatus, await social.listFriends(actor.userId), requestId, matchedEndpoint.response);
      }
      if (url.pathname === SocialEndpoint.request.path) {
        const actor = await requireSocialActor(request, database);
        return success(matchedEndpoint.successStatus, await social.requestFriend(actor.userId, (body as { userId: string }).userId), requestId, matchedEndpoint.response);
      }
      if (socialAcceptMatch && request.method === 'POST') {
        const actor = await requireSocialActor(request, database);
        return success(matchedEndpoint.successStatus, await social.acceptFriend(actor.userId, socialAcceptMatch[1]!), requestId, matchedEndpoint.response);
      }
      if (socialRejectMatch && request.method === 'POST') {
        const actor = await requireSocialActor(request, database);
        return success(matchedEndpoint.successStatus, await social.rejectFriend(actor.userId, socialRejectMatch[1]!), requestId, matchedEndpoint.response);
      }
      if (socialRemoveMatch && request.method === 'POST') {
        const actor = await requireSocialActor(request, database);
        return success(matchedEndpoint.successStatus, await social.removeFriend(actor.userId, socialRemoveMatch[1]!), requestId, matchedEndpoint.response);
      }
      if (url.pathname === SocialEndpoint.conversation.path) {
        const actor = await requireSocialActor(request, database);
        return success(matchedEndpoint.successStatus, await social.openConversation(actor.userId, (body as { userId: string }).userId), requestId, matchedEndpoint.response);
      }
      if (socialMessagesMatch && request.method === 'GET') {
        const actor = await requireSocialActor(request, database);
        return success(matchedEndpoint.successStatus, await social.listMessages(actor.userId, socialMessagesMatch[1]!), requestId, matchedEndpoint.response);
      }
      if (socialMessagesMatch && request.method === 'POST') {
        const actor = await requireActor(request, database);
        const input = body as { clientMessageId: string; body: string };
        return success(matchedEndpoint.successStatus, await social.sendMessage(actor.userId, socialMessagesMatch[1]!, input.clientMessageId, input.body), requestId, matchedEndpoint.response);
      }
      if (url.pathname === SupportEndpoint.listConversations.path && request.method === 'GET') {
        const actor = await requireActor(request, database);
        const result = await support.listConversations(actor.userId);
        if (!result.ok) throw new IdentityUseCaseError(500, result.code, 'Support conversations could not be read.');
        return success(matchedEndpoint.successStatus, result.value, requestId, matchedEndpoint.response);
      }

      if (url.pathname === SupportEndpoint.createConversation.path) {
        const actor = await requireActor(request, database);
        const result = await support.createConversation(actor.userId, body as import('@gameing/contracts/support').CreateSupportConversationRequestDto);
        if (!result.ok) throw new IdentityUseCaseError(result.code === 'INVALID_REQUEST' ? 400 : result.code === 'IDEMPOTENCY_KEY_REUSED' ? 409 : 500, result.code, 'The support request could not be created.');
        return success(matchedEndpoint.successStatus, result.value, requestId, matchedEndpoint.response);
      }

      if (supportMessagesMatch && request.method === 'GET') {
        const actor = await requireActor(request, database);
        const result = await support.listMessages(actor.userId, supportMessagesMatch[1]!);
        if (!result.ok) throw new IdentityUseCaseError(result.code === 'CONVERSATION_NOT_FOUND' ? 404 : 500, result.code, 'The support conversation is unavailable.');
        return success(matchedEndpoint.successStatus, result.value, requestId, matchedEndpoint.response);
      }

      if (supportMessagesMatch && request.method === 'POST') {
        const actor = await requireActor(request, database);
        const result = await support.sendMessage(actor.userId, supportMessagesMatch[1]!, body as import('@gameing/contracts/support').SendSupportMessageRequestDto);
        if (!result.ok) throw new IdentityUseCaseError(result.code === 'CONVERSATION_NOT_FOUND' ? 404 : result.code === 'CONVERSATION_CLOSED' || result.code === 'IDEMPOTENCY_KEY_REUSED' ? 409 : 400, result.code, 'The support message could not be sent.');
        return success(matchedEndpoint.successStatus, result.value, requestId, matchedEndpoint.response);
      }

      if (supportCloseMatch && request.method === 'POST') {
        const actor = await requireActor(request, database);
        const result = await support.closeConversation(actor.userId, supportCloseMatch[1]!);
        if (!result.ok) throw new IdentityUseCaseError(404, result.code, 'The support conversation is unavailable.');
        return success(matchedEndpoint.successStatus, { conversation: result.value }, requestId, matchedEndpoint.response);
      }

      if (url.pathname === IdentityEndpoint.deviceCredential.path) {
        const data = await identity.hasActiveDevice(cookie(request, 'device'));
        return success(matchedEndpoint.successStatus, data, requestId, matchedEndpoint.response);
      }

      if (url.pathname === IdentityEndpoint.deviceLogin.path) {
        const result = await identity.loginWithDevice(cookie(request, 'device'));
        return success(matchedEndpoint.successStatus, result.data, requestId, matchedEndpoint.response, result.cookies);
      }

      if (url.pathname === IdentityEndpoint.passwordLogin.path) {
        const input = body as IdentityBody;
        const result = await identity.loginWithPassword({ identifier: input.identifier!, password: input.password!, ...(input.challengeId ? { challengeId: input.challengeId } : {}), ...(input.totp ? { totp: input.totp } : {}) }, cookie(request, 'device'));
        return success(matchedEndpoint.successStatus, result.data, requestId, matchedEndpoint.response, result.cookies);
      }

      if (url.pathname === IdentityEndpoint.recovery.path) {
        const input = body as IdentityBody;
        const result = await identity.recoverAccount({ credentialId: input.credentialId!, recoverySecret: input.recoverySecret!, ...(input.totp ? { totp: input.totp } : {}) });
        return success(matchedEndpoint.successStatus, result.data, requestId, matchedEndpoint.response, result.cookies);
      }

      if (url.pathname === IdentityEndpoint.refresh.path) {
        const result = await identity.refresh(cookie(request, 'refresh'));
        return success(matchedEndpoint.successStatus, result.data, requestId, matchedEndpoint.response, result.cookies);
      }

      if (url.pathname === IdentityEndpoint.logout.path) {
        const result = await identity.logout(cookie(request, 'refresh'));
        return success(matchedEndpoint.successStatus, result.data, requestId, matchedEndpoint.response, result.cookies);
      }

      if (url.pathname === IdentityEndpoint.identitySettings.path) {
        const actor = await requireActor(request, database);
        return success(matchedEndpoint.successStatus, await identity.getIdentitySettings(actor.userId), requestId, matchedEndpoint.response);
      }

      if (url.pathname === IdentityEndpoint.setUsername.path) {
        const actor = await requireActor(request, database);
        const input = body as IdentityBody;
        return success(matchedEndpoint.successStatus, await identity.setUsername(actor.userId, { username: input.username!, password: input.password!, ...(input.totp ? { totp: input.totp } : {}) }), requestId, matchedEndpoint.response);
      }

      if (url.pathname === IdentityEndpoint.changePassword.path) {
        const actor = await requireActor(request, database);
        const input = body as IdentityBody;
        return success(matchedEndpoint.successStatus, await identity.changePassword(actor.userId, actor.sessionId, { ...(input.currentPassword ? { currentPassword: input.currentPassword } : {}), newPassword: input.newPassword!, ...(input.totp ? { totp: input.totp } : {}) }), requestId, matchedEndpoint.response);
      }

      if (url.pathname === IdentityEndpoint.totpSetup.path) {
        const actor = await requireActor(request, database);
        const input = body as IdentityBody;
        return success(matchedEndpoint.successStatus, await identity.startTotpSetup(actor.userId, { password: input.password!, ...(input.totp ? { totp: input.totp } : {}) }), requestId, matchedEndpoint.response);
      }

      if (url.pathname === IdentityEndpoint.totpConfirm.path) {
        const actor = await requireActor(request, database);
        const input = body as IdentityBody;
        return success(matchedEndpoint.successStatus, await identity.confirmTotpSetup(actor.userId, input.setupId!, input.code!), requestId, matchedEndpoint.response);
      }

      if (url.pathname === IdentityEndpoint.totpDisable.path) {
        const actor = await requireActor(request, database);
        const input = body as IdentityBody;
        return success(matchedEndpoint.successStatus, await identity.disableTotp(actor.userId, { password: input.password!, code: input.code! }), requestId, matchedEndpoint.response);
      }

      if (url.pathname === IdentityEndpoint.totpRecoveryCodesRotate.path) {
        const actor = await requireActor(request, database);
        const input = body as { code: string };
        return success(matchedEndpoint.successStatus, await identity.rotateTotpRecoveryCodes(actor.userId, input.code), requestId, matchedEndpoint.response);
      }

      if (url.pathname === IdentityEndpoint.recoveryCredentialPrepare.path) {
        const actor = await requireActor(request, database);
        const input = body as { password: string; recoverySecret: string; totp?: string };
        return success(matchedEndpoint.successStatus, await identity.prepareRecoveryCredential(actor.userId, input), requestId, matchedEndpoint.response);
      }

      if (recoveryActivateMatch && request.method === IdentityEndpoint.recoveryCredentialActivate.method) {
        const actor = await requireActor(request, database);
        return success(matchedEndpoint.successStatus, await identity.activateRecoveryCredential(actor.userId, recoveryActivateMatch[1]!), requestId, matchedEndpoint.response);
      }

      if (url.pathname === IdentityEndpoint.createContactChallenge.path) {
        const actor = await requireActor(request, database);
        const input = body as { contactType: 'EMAIL' | 'PHONE'; contactValue: string; password: string; totp?: string };
        return success(matchedEndpoint.successStatus, await identity.createContactChallenge(actor.userId, input), requestId, matchedEndpoint.response);
      }

      if (contactConfirmMatch && request.method === IdentityEndpoint.confirmContactChallenge.method) {
        const actor = await requireActor(request, database);
        const input = body as { code: string };
        return success(matchedEndpoint.successStatus, await identity.confirmContactChallenge(actor.userId, contactConfirmMatch[1]!, input.code), requestId, matchedEndpoint.response);
      }

      return failure(404, 'NOT_FOUND', 'The requested endpoint was not found.', requestId);
    } catch (error) {
      if (error instanceof IdentityUseCaseError) return failure(error.status, error.code, error.message, requestId, error.code === 'REFRESH_INVALID' ? { refresh: null } : undefined);
      if (error instanceof Error && Object.values(FundingErrorCode).includes(error.message as typeof FundingErrorCode[keyof typeof FundingErrorCode])) {
        const notFound = error.message === FundingErrorCode.FUNDING_ORDER_NOT_FOUND;
        const conflict = error.message === FundingErrorCode.FUNDING_ORDER_NOT_PAYABLE || error.message === FundingErrorCode.FUNDING_ORDER_EXPIRED || error.message === FundingErrorCode.FUNDING_ORDER_AMOUNT_MISMATCH || error.message === FundingErrorCode.FUNDING_IDEMPOTENCY_KEY_REUSED || error.message === FundingErrorCode.USDT_INVOICE_CAPACITY_REACHED;
        return failure(notFound ? 404 : conflict ? 409 : 400, error.message, fundingErrorMessage(error.message), requestId);
      }
      if (error instanceof Error && Object.values(WalletErrorCode).includes(error.message as typeof WalletErrorCode[keyof typeof WalletErrorCode])) {
        const status = error.message === WalletErrorCode.RECIPIENT_NOT_FOUND || error.message === WalletErrorCode.PAYOUT_ACCOUNT_NOT_FOUND || error.message === WalletErrorCode.WITHDRAWAL_NOT_FOUND ? 404
          : error.message === WalletErrorCode.INSUFFICIENT_AVAILABLE_BALANCE || error.message === WalletErrorCode.INSUFFICIENT_EXCHANGE_BALANCE || error.message === WalletErrorCode.TURNOVER_INCOMPLETE || error.message === WalletErrorCode.TRANSFER_QUOTE_EXPIRED || error.message === WalletErrorCode.TRANSFER_QUOTE_CHANGED || error.message === WalletErrorCode.EXCHANGE_QUOTE_EXPIRED || error.message === WalletErrorCode.EXCHANGE_QUOTE_CHANGED || error.message === WalletErrorCode.EXCHANGE_NOT_AVAILABLE || error.message === WalletErrorCode.IDEMPOTENCY_KEY_REUSED || error.message === WalletErrorCode.SELF_TRANSFER || error.message === WalletErrorCode.PAYOUT_ACCOUNT_IN_USE || error.message === WalletErrorCode.WITHDRAWAL_QUOTE_EXPIRED || error.message === WalletErrorCode.WITHDRAWAL_QUOTE_CHANGED || error.message === WalletErrorCode.WITHDRAWAL_NOT_CANCELLABLE ? 409
            : error.message === WalletErrorCode.WALLET_STORAGE_UNAVAILABLE || error.message === WalletErrorCode.WITHDRAWAL_CONFIG_INVALID ? 503 : 400;
        return failure(status, error.message, walletErrorMessage(error.message), requestId);
      }
      if (error instanceof Error && ['SELF_FRIEND_REQUEST', 'SOCIAL_MESSAGE_INVALID'].includes(error.message)) return failure(400, error.message, 'The social request is invalid.', requestId);
      if (error instanceof Error && ['SOCIAL_USER_NOT_FOUND', 'FRIEND_REQUEST_NOT_FOUND', 'SOCIAL_CONVERSATION_NOT_FOUND'].includes(error.message)) return failure(404, error.message, 'The social item is unavailable.', requestId);
      if (error instanceof Error && ['SOCIAL_FRIENDSHIP_REQUIRED', 'IDEMPOTENCY_KEY_REUSED'].includes(error.message)) return failure(409, error.message, 'The social action conflicts with the current state.', requestId);
      console.error('Browser API request failed', { requestId, code: error instanceof Error ? error.message : 'INTERNAL_ERROR' });
      return failure(500, 'INTERNAL_ERROR', 'The local development service could not complete the request.', requestId);
    }
  }
}

function fundingErrorMessage(code: string): string {
  switch (code) {
    case FundingErrorCode.INVALID_ORDER_AMOUNT: return '金额不能按当前兑换比例换算为整数金币，请调整金额。';
    case FundingErrorCode.FUNDING_CHANNEL_UNAVAILABLE: return '此支付方式暂不可用，请选择其他方式。';
    case FundingErrorCode.FUNDING_ORDER_NOT_FOUND: return '充值订单不存在或不属于当前账号。';
    case FundingErrorCode.FUNDING_ORDER_NOT_PAYABLE: return '订单已结束或无法继续支付，请刷新订单列表。';
    case FundingErrorCode.FUNDING_ORDER_EXPIRED: return 'USDT 订单已超时，请新建订单并按新金额转账。';
    case FundingErrorCode.FUNDING_ORDER_AMOUNT_MISMATCH: return '支付金额与订单金额不一致，金币未入账。';
    case FundingErrorCode.FUNDING_IDEMPOTENCY_KEY_REUSED: return '请求标识已用于不同订单，请重新提交。';
    case FundingErrorCode.USDT_INVOICE_CAPACITY_REACHED: return '当前金额的订单暂时已满，请稍后重试或调整充值金额。';
    default: return '充值操作暂时失败，请重试。';
  }
}

function walletErrorMessage(code: string): string {
  switch (code) {
    case WalletErrorCode.RECIPIENT_NOT_FOUND: return '收款账号不存在或不可用。';
    case WalletErrorCode.SELF_TRANSFER: return '不能向自己的账号转账。';
    case WalletErrorCode.INVALID_TRANSFER_AMOUNT: return '请输入有效的金币数量。';
    case WalletErrorCode.TURNOVER_INCOMPLETE: return '完成赠币流水后才能转出金币。';
    case WalletErrorCode.INSUFFICIENT_AVAILABLE_BALANCE: return '可用金币不足以支付本金和手续费。';
    case WalletErrorCode.TRANSFER_QUOTE_EXPIRED: return '转账预览已过期，请重新确认金额。';
    case WalletErrorCode.TRANSFER_QUOTE_CHANGED: return '手续费规则或收款信息已变化，请重新确认。';
    case WalletErrorCode.IDEMPOTENCY_KEY_REUSED: return '该请求标识已用于不同的转账内容。';
    case WalletErrorCode.EXCHANGE_NOT_AVAILABLE: return '当前账户或系统余额暂不支持金币兑换。';
    case WalletErrorCode.EXCHANGE_QUOTE_EXPIRED: return '兑换预览已过期，请重新确认金额。';
    case WalletErrorCode.EXCHANGE_QUOTE_CHANGED: return '兑换比例已变化，请重新预览。';
    case WalletErrorCode.INVALID_EXCHANGE_AMOUNT: return '请输入有效的金币兑换数量。';
    case WalletErrorCode.INSUFFICIENT_EXCHANGE_BALANCE: return '可用金币不足以完成兑换。';
    case WalletErrorCode.INVALID_PAYOUT_ACCOUNT: return '收款方式信息无效；本机演练只接受虚构标识。';
    case WalletErrorCode.PAYOUT_ACCOUNT_NOT_FOUND: return '收款方式不存在或不可用。';
    case WalletErrorCode.PAYOUT_ACCOUNT_IN_USE: return '该收款方式仍关联未完成申请，暂时不能删除。';
    case WalletErrorCode.WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID: return '提现净到账额必须达到最低金额，且为最低金额的整数倍。';
    case WalletErrorCode.WITHDRAWAL_CONFIG_INVALID: return '当前提现金额配置无法精确换算到人民币分，请联系运营处理。';
    case WalletErrorCode.WITHDRAWAL_QUOTE_EXPIRED: return '提现报价已过期，请重新计算。';
    case WalletErrorCode.WITHDRAWAL_QUOTE_CHANGED: return '提现费率、最低金额或收款方式已变化，请重新计算。';
    case WalletErrorCode.WITHDRAWAL_NOT_FOUND: return '提现申请不存在。';
    case WalletErrorCode.WITHDRAWAL_NOT_CANCELLABLE: return '申请已进入审核或出款阶段，不能在此取消。';
    default: return '钱包服务暂时不可用，请稍后重试。';
  }
}

function toAgentDomainDto(domain: LocalAgentDomain): AgentDomainDto {
  return { userId: domain.userId, status: domain.status, appliedAt: domain.appliedAt, capabilities: domain.capabilities };
}

export async function createBrowserApiFetch(server = new BrowserApiServer()): Promise<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>> {
  const { LocalCookieJar } = await import('./local-cookie-jar');
  const jar = new LocalCookieJar();
  return async (input, init) => {
    const request = new Request(input, init);
    const cookies = await jar.requestCookieHeader();
    // Browsers forbid scripts from setting Cookie on a Request. This private header exists only
    // between the dev fetch adapter and BrowserApiServer; production transports use real cookies.
    if (cookies) request.headers.set('X-Local-Browser-Cookie', cookies);
    const response = await server.handle(request);
    await jar.applyLocalSetCookie(response.headers.get('x-local-cookie-state'));
    return response;
  };
}

export async function createDevelopmentTestAccount(): Promise<{ userId: string; displayName: string; identifier: string; password: string; recoveryQrPayload: string; recoveryQrPassword: string; recoveryExpiresAt: string }> {
  const identifier = `test-${randomToken(9)}`;
  const password = randomToken(24);
  const database = await openBrowserDevelopmentDatabase();
  const lookupKey = identifier.toLowerCase();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const secretHash = await derivePasswordHash(password, salt);
  const userId = await nextId(database);
  const deviceId = await nextId(database);
  const user: LocalUser = { userId, displayName: `测试用户${userId.slice(-4)}`, roleType: 1, rewardType: RewardType.RECHARGE_REBATE, status: 'ACTIVE', authVersion: 1 };
  const usernameCredential: LocalCredential = { credentialId: await nextId(database), userId, kind: 'IDENTIFIER', identifierType: 'USERNAME', lookupKey, displayValue: identifier, state: 'ACTIVE' };
  const passwordCredential: LocalCredential = { credentialId: await nextId(database), userId, kind: 'PASSWORD', secretHash, salt: btoa(String.fromCharCode(...salt)), state: 'ACTIVE' };
  const deviceCode = randomToken();
  const deviceCredential: LocalCredential = { credentialId: await nextId(database), userId, deviceId, kind: 'DEVICE', secretHash: await sha256(deviceCode), lookupKey: await sha256(deviceCode), state: 'ACTIVE' };
  const write = database.transaction(['users', 'credentials'], 'readwrite');
  await write.objectStore('users').put(user);
  await write.objectStore('credentials').put(passwordCredential);
  await write.objectStore('credentials').put(usernameCredential);
  await write.objectStore('credentials').put(deviceCredential);
  await write.done;
  const recovery = await new LocalIdentityApplication(new IndexedDbLocalIdentityRepository(database)).createDevelopmentRecoveryFixture(userId);
  return { userId, displayName: user.displayName, identifier, password, recoveryQrPayload: recovery.qrPayload, recoveryQrPassword: recovery.qrPassword, recoveryExpiresAt: recovery.expiresAt };
}

export async function ensureLocalDeviceRegistration(fetchPort: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, deviceCode: string): Promise<SessionResponseDto> {
  const requestId = crypto.randomUUID();
  const database = await openBrowserDevelopmentDatabase();
  const pendingKey = 'pending-device-registration';
  const read = database.transaction('settings', 'readonly');
  const pendingSetting = await read.store.get(pendingKey);
  await read.done;
  const pending = pendingSetting?.value as { deviceCode?: string; idempotencyKey?: string; body?: object } | undefined;
  const body = pending?.body ?? { fingerprintVersion: '1', deviceCode: pending?.deviceCode ?? deviceCode, deviceSummary: { platform: navigator.platform.slice(0, 32) || 'browser', browser: 'browser' } };
  const idempotencyKey = pending?.idempotencyKey ?? randomToken(18);
  if (!pending?.body) {
    const write = database.transaction('settings', 'readwrite');
    await write.store.put({ key: pendingKey, value: { deviceCode: (body as { deviceCode: string }).deviceCode, idempotencyKey, body } });
    await write.done;
  }
  const response = await fetchPort(IdentityEndpoint.deviceRegister.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body), credentials: 'include' });
  const envelope = await response.json() as { data?: SessionResponseDto };
  if (!response.ok || !envelope.data) throw new Error('DEVICE_REGISTRATION_FAILED');
  const clear = database.transaction('settings', 'readwrite');
  await clear.store.delete(pendingKey);
  await clear.done;
  return envelope.data;
}

