import { Value } from '@sinclair/typebox/value';
import {
  AccountRecoveryRequestSchema,
  ApiFailureSchema,
  ApiSuccessSchema,
  DeviceCredentialResponseSchema,
  DeviceRegisterRequestSchema,
  IdentityEndpoint,
  LoginChallengeResponseSchema,
  LogoutResponseSchema,
  PasswordLoginRequestSchema,
  SessionResponseSchema,
  type AccountRecoveryRequestDto,
  type ApiFailureDto,
  type ApiSuccessDto,
  type DeviceCredentialResponseDto,
  type DeviceRegisterRequestDto,
  type IdentitySuccessData,
  type IdentitySettingsResponseDto,
  type SetUsernameRequestDto,
  type ChangePasswordRequestDto,
  type SetPhoneContactRequestDto,
  type SetEmailContactRequestDto,
  type PasswordChangedResponseDto,
  type CreateContactChallengeRequestDto,
  type ContactChallengeResponseDto,
  type ConfirmContactChallengeRequestDto,
  type PasswordLoginRequestDto,
  type SessionResponseDto,
  type LoginChallengeResponseDto,
  type TotpConfirmRequestDto,
  type TotpDisableRequestDto,
  type TotpDisabledResponseDto,
  type TotpEnabledResponseDto,
  type TotpSetupRequestDto,
  type TotpSetupResponseDto,
  type RecoveryCredentialPrepareRequestDto,
  type RecoveryCredentialIssueResponseDto,
  type TotpRecoveryCodesRotateRequestDto,
} from '@gameing/contracts/identity';
import { WalletEndpoint, type CreatePayoutAccountRequestDto, type CreateWithdrawalRequestDto, type PayoutAccountDto, type WalletActivityCursorDto, type WalletActivityResponseDto, type WalletExchangeQuoteRequestDto, type WalletExchangeQuoteDto, type WalletExchangeRequestDto, type WalletExchangeResultDto, type WalletSummaryResponseDto, type WalletTransferQuoteRequestDto, type WalletTransferQuoteDto, type WalletTransferRequestDto, type WalletTransferResultDto, type WithdrawalDto, type WithdrawalQuoteDto, type WithdrawalQuoteRequestDto } from '@gameing/contracts/wallet';
import {
  SupportEndpoint,
  type CreateSupportConversationRequestDto,
  type SendSupportMessageRequestDto,
  type SupportConversationDto,
  type SupportMessageDto,
} from '@gameing/contracts/support';
import { SocialEndpoint, type SocialAccessResponseDto, type SocialConversationListResponseDto, type SocialFriendDto, type SocialMessageDto, type FriendLookupResponseDto, type SocialMessageListResponseDto, type SocialOwnProfileResponseDto } from '@gameing/contracts/social';
import { InviteAgentEndpoint, type AgentDomainDto, type InviteLinkDto, type ReferralInviteePageDto, type ReferralRewardPageDto } from '@gameing/contracts/invite-agent';
import { WalletFundingDevelopmentEndpoint, WalletFundingEndpoint, type CreateFundingOrderRequestDto, type FundingChannelDto, type FundingOrderDto, type SimulateFundingPaymentRequestDto } from '@gameing/contracts/wallet-funding';
import { GameCatalogEndpoint } from '@gameing/contracts/game-catalog';
import { GameExperienceEndpoint } from '@gameing/contracts/game-experience';
import { CoinMarketEndpoint, type CoinMarketListingCreateRequestDto, type CoinMarketListingDto, type CoinMarketListingPageDto, type CoinMarketPriceQuoteDto, type CoinMarketPriceQuoteRequestDto, type CoinMarketTradeCreateRequestDto, type CoinMarketTradeDto, type CoinMarketTradeTextRequestDto } from '@gameing/contracts/coin-market';

export type ApiFetchPort = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

type Endpoint<TRequest, TResponse> = {
  method: string;
  path: string;
  request?: import('@sinclair/typebox').TSchema;
  response: import('@sinclair/typebox').TSchema;
  successStatus: number;
  requestValue?: TRequest;
  responseValue?: TResponse;
};

export function createApiClient(fetchPort: ApiFetchPort) {
  async function request<T>(endpoint: Endpoint<unknown, T>, body?: unknown, headers?: HeadersInit): Promise<T> {
    if (endpoint.request && !Value.Check(endpoint.request, body)) throw new ApiRequestError(400, 'VALIDATION_FAILED', 'Request does not match the shared schema.');
    const requestId = crypto.randomUUID();
    const requestHeaders = new Headers(headers);
    requestHeaders.set('X-Request-Id', requestId);
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
    const response = await fetchPort(endpoint.path, {
      method: endpoint.method,
      headers: requestHeaders,
      credentials: 'include',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ApiRequestError(response.status, 'INVALID_API_RESPONSE', 'The API response was not valid JSON.', requestId);
    }
    if (!response.ok) {
      if (Value.Check(ApiFailureSchema, payload)) {
        const failure = payload as ApiFailureDto;
        throw new ApiRequestError(response.status, failure.code, failure.message, failure.requestId);
      }
      throw new ApiRequestError(response.status, 'INVALID_API_RESPONSE', 'The API response did not match the error envelope.', requestId);
    }
    const envelopeSchema = ApiSuccessSchema(endpoint.response);
    if (response.status !== endpoint.successStatus || !Value.Check(envelopeSchema, payload)) {
      throw new ApiRequestError(response.status, 'INVALID_API_RESPONSE', 'The API response did not match the shared schema.', requestId);
    }
    return (payload as ApiSuccessDto<T>).data;
  }

  return {
    gameCatalog(): Promise<import('@gameing/contracts/game-catalog').GameCatalogDto[]> {
      return requestTyped(GameCatalogEndpoint.list);
    },
    gameExperiences(): Promise<import('@gameing/contracts/game-experience').GameExperienceDto[]> {
      return requestTyped(GameExperienceEndpoint.list);
    },
    gameExperience(gameKey: string): Promise<import('@gameing/contracts/game-experience').GameExperienceDto> {
      return requestTyped({ ...GameExperienceEndpoint.detail, path: GameExperienceEndpoint.detail.path.replace(':gameKey', encodeURIComponent(gameKey)) });
    },
    gamePreflight(gameKey: string, difficultyKey: string): Promise<import('@gameing/contracts/game-experience').GamePreflightResponseDto> {
      return requestTyped({ ...GameExperienceEndpoint.preflight, path: GameExperienceEndpoint.preflight.path.replace(':gameKey', encodeURIComponent(gameKey)).replace(':difficultyKey', encodeURIComponent(difficultyKey)) });
    },
    coinMarketPriceQuote(body: CoinMarketPriceQuoteRequestDto, accessToken: string): Promise<CoinMarketPriceQuoteDto> {
      return requestTyped(CoinMarketEndpoint.priceQuote, body, { Authorization: `Bearer ${accessToken}` });
    },
    coinMarketMyListings(accessToken: string): Promise<CoinMarketListingDto[]> {
      return requestTyped(CoinMarketEndpoint.myListings, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    coinMarketListings(accessToken: string, cursor?: string): Promise<CoinMarketListingPageDto> {
      const endpoint = { ...CoinMarketEndpoint.listings, path: `${CoinMarketEndpoint.listings.path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}` };
      return requestTyped(endpoint, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    coinMarketMyTrades(accessToken: string): Promise<CoinMarketTradeDto[]> { return requestTyped(CoinMarketEndpoint.myTrades, undefined, { Authorization: `Bearer ${accessToken}` }); },
    coinMarketCreateTrade(listingId: string, body: CoinMarketTradeCreateRequestDto, accessToken: string): Promise<CoinMarketTradeDto> {
      return requestTyped({ ...CoinMarketEndpoint.createTrade, path: CoinMarketEndpoint.createTrade.path.replace(':listingId', encodeURIComponent(listingId)) }, body, { Authorization: `Bearer ${accessToken}` });
    },
    coinMarketTradeCommand(action: 'paymentProof' | 'appeal' | 'buyerEvidence' | 'sellerEvidence' | 'confirmReceipt', tradeId: string, body: CoinMarketTradeTextRequestDto | undefined, accessToken: string): Promise<CoinMarketTradeDto> {
      const endpoint = CoinMarketEndpoint[action];
      return requestTyped({ ...endpoint, path: endpoint.path.replace(':tradeId', encodeURIComponent(tradeId)) }, body, { Authorization: `Bearer ${accessToken}` });
    },
    coinMarketCreateListing(body: CoinMarketListingCreateRequestDto, accessToken: string): Promise<CoinMarketListingDto> {
      return requestTyped(CoinMarketEndpoint.createListing, body, { Authorization: `Bearer ${accessToken}` });
    },
    coinMarketCancelListing(listingId: string, accessToken: string): Promise<CoinMarketListingDto> {
      const endpoint = { ...CoinMarketEndpoint.updateListing, path: CoinMarketEndpoint.updateListing.path.replace(':listingId', encodeURIComponent(listingId)) };
      return requestTyped(endpoint, { action: 'CANCEL' }, { Authorization: `Bearer ${accessToken}` });
    },
    socialAccess(accessToken: string): Promise<SocialAccessResponseDto> {
      return requestTyped(SocialEndpoint.access, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    deviceRegister(request: DeviceRegisterRequestDto, idempotencyKey: string): Promise<SessionResponseDto> {
      return requestTyped(IdentityEndpoint.deviceRegister, request, { 'Idempotency-Key': idempotencyKey });
    },
    deviceLogin(): Promise<SessionResponseDto> {
      return requestTyped(IdentityEndpoint.deviceLogin, {});
    },
    async deviceCredential(): Promise<DeviceCredentialResponseDto> {
      return requestTyped(IdentityEndpoint.deviceCredential);
    },
    async passwordLogin(body: PasswordLoginRequestDto): Promise<SessionResponseDto | LoginChallengeResponseDto> {
      const response = await request(IdentityEndpoint.passwordLogin, body) as IdentitySuccessData;
      if (Value.Check(LoginChallengeResponseSchema, response)) return response;
      if (!Value.Check(SessionResponseSchema, response)) throw new ApiRequestError(502, 'INVALID_API_RESPONSE', 'The identity response is invalid.');
      return response;
    },
    recovery(body: AccountRecoveryRequestDto): Promise<SessionResponseDto> {
      return requestTyped(IdentityEndpoint.recovery, body);
    },
    refresh(): Promise<SessionResponseDto> {
      return requestTyped(IdentityEndpoint.refresh, {});
    },
    logout(): Promise<{ loggedOut: boolean }> {
      return requestTyped(IdentityEndpoint.logout, {});
    },
    identitySettings(accessToken: string): Promise<IdentitySettingsResponseDto> {
      return requestTyped(IdentityEndpoint.identitySettings, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    setUsername(body: SetUsernameRequestDto, accessToken: string): Promise<IdentitySettingsResponseDto> {
      return requestTyped(IdentityEndpoint.setUsername, body, { Authorization: `Bearer ${accessToken}` });
    },
    changePassword(body: ChangePasswordRequestDto, accessToken: string): Promise<PasswordChangedResponseDto> {
      return requestTyped(IdentityEndpoint.changePassword, body, { Authorization: `Bearer ${accessToken}` });
    },
    createContactChallenge(body: CreateContactChallengeRequestDto, accessToken: string): Promise<ContactChallengeResponseDto> {
      return requestTyped(IdentityEndpoint.createContactChallenge, body, { Authorization: `Bearer ${accessToken}` });
    },
    confirmContactChallenge(challengeId: string, body: ConfirmContactChallengeRequestDto, accessToken: string): Promise<IdentitySettingsResponseDto> {
      const endpoint = { ...IdentityEndpoint.confirmContactChallenge, path: IdentityEndpoint.confirmContactChallenge.path.replace(':challengeId', encodeURIComponent(challengeId)) };
      return requestTyped(endpoint, body, { Authorization: `Bearer ${accessToken}` });
    },
    setPhoneContact(body: SetPhoneContactRequestDto, accessToken: string): Promise<IdentitySettingsResponseDto> {
      return requestTyped(IdentityEndpoint.setPhoneContact, body, { Authorization: `Bearer ${accessToken}` });
    },
    setEmailContact(body: SetEmailContactRequestDto, accessToken: string): Promise<IdentitySettingsResponseDto> {
      return requestTyped(IdentityEndpoint.setEmailContact, body, { Authorization: `Bearer ${accessToken}` });
    },
    startTotpSetup(body: TotpSetupRequestDto, accessToken: string): Promise<TotpSetupResponseDto> {
      return requestTyped(IdentityEndpoint.totpSetup, body, { Authorization: `Bearer ${accessToken}` });
    },
    confirmTotpSetup(body: TotpConfirmRequestDto, accessToken: string): Promise<TotpEnabledResponseDto> {
      return requestTyped(IdentityEndpoint.totpConfirm, body, { Authorization: `Bearer ${accessToken}` });
    },
    disableTotp(body: TotpDisableRequestDto, accessToken: string): Promise<TotpDisabledResponseDto> {
      return requestTyped(IdentityEndpoint.totpDisable, body, { Authorization: `Bearer ${accessToken}` });
    },
    rotateTotpRecoveryCodes(body: TotpRecoveryCodesRotateRequestDto, accessToken: string): Promise<TotpEnabledResponseDto> {
      return requestTyped(IdentityEndpoint.totpRecoveryCodesRotate, body, { Authorization: `Bearer ${accessToken}` });
    },
    prepareRecoveryCredential(body: RecoveryCredentialPrepareRequestDto, accessToken: string): Promise<RecoveryCredentialIssueResponseDto> {
      return requestTyped(IdentityEndpoint.recoveryCredentialPrepare, body, { Authorization: `Bearer ${accessToken}` });
    },
    activateRecoveryCredential(credentialId: string, accessToken: string): Promise<IdentitySettingsResponseDto> {
      const endpoint = { ...IdentityEndpoint.recoveryCredentialActivate, path: IdentityEndpoint.recoveryCredentialActivate.path.replace(':credentialId', encodeURIComponent(credentialId)) };
      return requestTyped(endpoint, {}, { Authorization: `Bearer ${accessToken}` });
    },
    walletSummary(accessToken: string): Promise<WalletSummaryResponseDto> {
      return requestTyped(WalletEndpoint.summary, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    fundingChannels(accessToken: string): Promise<FundingChannelDto[]> {
      return requestTyped(WalletFundingEndpoint.channels, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    fundingOrders(accessToken: string): Promise<FundingOrderDto[]> {
      return requestTyped(WalletFundingEndpoint.orders, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    createFundingOrder(body: CreateFundingOrderRequestDto, accessToken: string): Promise<FundingOrderDto> {
      return requestTyped(WalletFundingEndpoint.createOrder, body, { Authorization: `Bearer ${accessToken}` });
    },
    simulateFundingPayment(body: SimulateFundingPaymentRequestDto, accessToken: string): Promise<FundingOrderDto> {
      return requestTyped(WalletFundingDevelopmentEndpoint.simulatePayment, body, { Authorization: `Bearer ${accessToken}` });
    },
    walletActivity(accessToken: string, cursor?: WalletActivityCursorDto): Promise<WalletActivityResponseDto> {
      const path = cursor ? `${WalletEndpoint.activity.path}?cursor=${encodeURIComponent(cursor)}` : WalletEndpoint.activity.path;
      return requestTyped({ ...WalletEndpoint.activity, path }, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    walletTransferQuote(body: WalletTransferQuoteRequestDto, accessToken: string): Promise<WalletTransferQuoteDto> {
      return requestTyped(WalletEndpoint.transferQuote, body, { Authorization: `Bearer ${accessToken}` });
    },
    walletTransfer(body: WalletTransferRequestDto, accessToken: string): Promise<WalletTransferResultDto> {
      return requestTyped(WalletEndpoint.transfer, body, { Authorization: `Bearer ${accessToken}` });
    },
    walletExchangeQuote(body: WalletExchangeQuoteRequestDto, accessToken: string): Promise<WalletExchangeQuoteDto> {
      return requestTyped(WalletEndpoint.exchangeQuote, body, { Authorization: `Bearer ${accessToken}` });
    },
    walletExchange(body: WalletExchangeRequestDto, accessToken: string): Promise<WalletExchangeResultDto> {
      return requestTyped(WalletEndpoint.exchange, body, { Authorization: `Bearer ${accessToken}` });
    },
    walletPayoutAccounts(accessToken: string): Promise<PayoutAccountDto[]> {
      return requestTyped(WalletEndpoint.payoutAccounts, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    walletCreatePayoutAccount(body: CreatePayoutAccountRequestDto, accessToken: string): Promise<PayoutAccountDto> {
      return requestTyped(WalletEndpoint.createPayoutAccount, body, { Authorization: `Bearer ${accessToken}` });
    },
    walletDeletePayoutAccount(payoutAccountId: string, accessToken: string): Promise<{ deleted: boolean }> {
      const endpoint = { ...WalletEndpoint.deletePayoutAccount, path: WalletEndpoint.deletePayoutAccount.path.replace(':payoutAccountId', encodeURIComponent(payoutAccountId)) };
      return requestTyped(endpoint, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    walletWithdrawalQuote(body: WithdrawalQuoteRequestDto, accessToken: string): Promise<WithdrawalQuoteDto> {
      return requestTyped(WalletEndpoint.withdrawalQuote, body, { Authorization: `Bearer ${accessToken}` });
    },
    walletWithdrawals(accessToken: string): Promise<WithdrawalDto[]> {
      return requestTyped(WalletEndpoint.withdrawals, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    walletCreateWithdrawal(body: CreateWithdrawalRequestDto, accessToken: string): Promise<WithdrawalDto> {
      return requestTyped(WalletEndpoint.createWithdrawal, body, { Authorization: `Bearer ${accessToken}` });
    },
    walletCancelWithdrawal(withdrawalId: string, accessToken: string): Promise<WithdrawalDto> {
      const endpoint = { ...WalletEndpoint.cancelWithdrawal, path: WalletEndpoint.cancelWithdrawal.path.replace(':withdrawalId', encodeURIComponent(withdrawalId)) };
      return requestTyped(endpoint, {}, { Authorization: `Bearer ${accessToken}` });
    },
    listSupportConversations(accessToken: string): Promise<SupportConversationDto[]> {
      return requestTyped(SupportEndpoint.listConversations, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    createSupportConversation(body: CreateSupportConversationRequestDto, accessToken: string): Promise<{ conversation: SupportConversationDto; firstMessage: SupportMessageDto }> {
      return requestTyped(SupportEndpoint.createConversation, body, { Authorization: `Bearer ${accessToken}` });
    },
    listSupportMessages(conversationId: string, accessToken: string): Promise<{ conversation: SupportConversationDto; messages: SupportMessageDto[] }> {
      const endpoint = { ...SupportEndpoint.listMessages, path: SupportEndpoint.listMessages.path.replace(':conversationId', encodeURIComponent(conversationId)) };
      return requestTyped(endpoint, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    sendSupportMessage(conversationId: string, body: SendSupportMessageRequestDto, accessToken: string): Promise<SupportMessageDto> {
      const endpoint = { ...SupportEndpoint.sendMessage, path: SupportEndpoint.sendMessage.path.replace(':conversationId', encodeURIComponent(conversationId)) };
      return requestTyped(endpoint, body, { Authorization: `Bearer ${accessToken}` });
    },
    closeSupportConversation(conversationId: string, accessToken: string): Promise<{ conversation: SupportConversationDto }> {
      const endpoint = { ...SupportEndpoint.closeConversation, path: SupportEndpoint.closeConversation.path.replace(':conversationId', encodeURIComponent(conversationId)) };
      return requestTyped(endpoint, {}, { Authorization: `Bearer ${accessToken}` });
    },
    lookupSocialFriends(value: string, accessToken: string): Promise<FriendLookupResponseDto> {
      return requestTyped(SocialEndpoint.lookup, { value }, { Authorization: `Bearer ${accessToken}` });
    },
    socialProfile(accessToken: string): Promise<SocialOwnProfileResponseDto> {
      return requestTyped(SocialEndpoint.profile, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    listSocialFriends(accessToken: string): Promise<SocialFriendDto[]> {
      return requestTyped(SocialEndpoint.friends, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    requestSocialFriend(userId: string, accessToken: string): Promise<{ accepted: boolean }> {
      return requestTyped(SocialEndpoint.request, { userId }, { Authorization: `Bearer ${accessToken}` });
    },
    acceptSocialFriend(userId: string, accessToken: string): Promise<{ accepted: boolean }> {
      const endpoint = { ...SocialEndpoint.accept, path: SocialEndpoint.accept.path.replace(':userId', encodeURIComponent(userId)) };
      return requestTyped(endpoint, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    rejectSocialFriend(userId: string, accessToken: string): Promise<{ accepted: boolean }> {
      const endpoint = { ...SocialEndpoint.reject, path: SocialEndpoint.reject.path.replace(':userId', encodeURIComponent(userId)) };
      return requestTyped(endpoint, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    removeSocialFriend(userId: string, accessToken: string): Promise<{ accepted: boolean }> {
      const endpoint = { ...SocialEndpoint.removeFriend, path: SocialEndpoint.removeFriend.path.replace(':userId', encodeURIComponent(userId)) };
      return requestTyped(endpoint, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    listSocialConversations(accessToken: string): Promise<SocialConversationListResponseDto> {
      return requestTyped(SocialEndpoint.conversations, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    openSocialConversation(userId: string, accessToken: string): Promise<{ conversationId: string }> {
      return requestTyped(SocialEndpoint.conversation, { userId }, { Authorization: `Bearer ${accessToken}` });
    },
    listSocialMessages(conversationId: string, accessToken: string): Promise<SocialMessageListResponseDto> {
      const endpoint = { ...SocialEndpoint.messages, path: SocialEndpoint.messages.path.replace(':conversationId', encodeURIComponent(conversationId)) };
      return requestTyped(endpoint, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    sendSocialMessage(conversationId: string, body: { clientMessageId: string; body: string; attachments?: import('@gameing/contracts/social').SocialMessageAttachmentDto[] }, accessToken: string): Promise<SocialMessageDto> {
      const endpoint = { ...SocialEndpoint.sendMessage, path: SocialEndpoint.sendMessage.path.replace(':conversationId', encodeURIComponent(conversationId)) };
      return requestTyped(endpoint, body, { Authorization: `Bearer ${accessToken}` });
    },
    getInviteLink(accessToken: string): Promise<InviteLinkDto | null> {
      return requestTyped(InviteAgentEndpoint.inviteLink, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    issueInviteLink(accessToken: string): Promise<InviteLinkDto> {
      return requestTyped(InviteAgentEndpoint.issueInviteLink, {}, { Authorization: `Bearer ${accessToken}` });
    },
    listReferralInvitees(accessToken: string, cursor?: string): Promise<ReferralInviteePageDto> {
      const endpoint = { ...InviteAgentEndpoint.invitees, path: `${InviteAgentEndpoint.invitees.path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}` };
      return requestTyped(endpoint, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    listReferralRewards(accessToken: string, cursor?: string): Promise<ReferralRewardPageDto> {
      const endpoint = { ...InviteAgentEndpoint.rewards, path: `${InviteAgentEndpoint.rewards.path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}` };
      return requestTyped(endpoint, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    getAgentDomain(accessToken: string): Promise<AgentDomainDto | null> {
      return requestTyped(InviteAgentEndpoint.agentDomain, undefined, { Authorization: `Bearer ${accessToken}` });
    },
    applyAgentDomain(accessToken: string): Promise<AgentDomainDto> {
      return requestTyped(InviteAgentEndpoint.applyAgentDomain, { acknowledged: true }, { Authorization: `Bearer ${accessToken}` });
    },
    withdrawAgentDomain(accessToken: string): Promise<{ withdrawn: boolean }> {
      return requestTyped(InviteAgentEndpoint.withdrawAgentDomain, undefined, { Authorization: `Bearer ${accessToken}` });
    },
  };

  function requestTyped<TRequest, TResponse>(endpoint: Endpoint<TRequest, TResponse>, body?: TRequest, headers?: HeadersInit): Promise<TResponse> {
    return request(endpoint, body, headers);
  }
}
