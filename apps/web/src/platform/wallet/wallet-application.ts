import { Value } from '@sinclair/typebox/value';
import { CreatePayoutAccountRequestSchema, CreateWithdrawalRequestSchema, WalletExchangeQuoteRequestSchema, WalletExchangeRequestSchema, WalletTransferQuoteRequestSchema, WalletTransferRequestSchema, WithdrawalQuoteRequestSchema, type CreatePayoutAccountRequestDto, type CreateWithdrawalRequestDto, type PayoutAccountDto, type WalletActivityCursorDto, type WalletActivityResponseDto, type WalletExchangeQuoteDto, type WalletExchangeQuoteRequestDto, type WalletExchangeRequestDto, type WalletExchangeResultDto, type WalletSummaryResponseDto, type WalletTransferQuoteDto, type WalletTransferQuoteRequestDto, type WalletTransferRequestDto, type WalletTransferResultDto, type WithdrawalDto, type WithdrawalQuoteDto, type WithdrawalQuoteRequestDto } from '@gameing/contracts/wallet';

export interface WalletRepository {
  grantWelcomeGift(userId: string): Promise<void>;
  getSummary(userId: string): Promise<WalletSummaryResponseDto>;
  getActivity(userId: string, cursor?: WalletActivityCursorDto): Promise<WalletActivityResponseDto>;
  quoteTransfer(userId: string, request: WalletTransferQuoteRequestDto): Promise<WalletTransferQuoteDto>;
  transferCoins(userId: string, request: WalletTransferRequestDto): Promise<WalletTransferResultDto>;
  quoteExchange(userId: string, request: WalletExchangeQuoteRequestDto): Promise<WalletExchangeQuoteDto>;
  exchangeCoins(userId: string, request: WalletExchangeRequestDto): Promise<WalletExchangeResultDto>;
  listPayoutAccounts(userId: string): Promise<PayoutAccountDto[]>;
  createPayoutAccount(userId: string, request: CreatePayoutAccountRequestDto): Promise<PayoutAccountDto>;
  deletePayoutAccount(userId: string, payoutAccountId: string): Promise<{ deleted: boolean }>;
  quoteWithdrawal(userId: string, request: WithdrawalQuoteRequestDto): Promise<WithdrawalQuoteDto>;
  listWithdrawals(userId: string): Promise<WithdrawalDto[]>;
  createWithdrawal(userId: string, request: CreateWithdrawalRequestDto): Promise<WithdrawalDto>;
  cancelWithdrawal(userId: string, withdrawalId: string): Promise<WithdrawalDto>;
}

export class WalletUseCases {
  constructor(private readonly repository: WalletRepository) {}

  grantWelcomeGiftForRegisteredUser(userId: string): Promise<void> {
    return this.repository.grantWelcomeGift(userId);
  }

  getSummary(userId: string): Promise<WalletSummaryResponseDto> {
    return this.repository.getSummary(userId);
  }

  getActivity(userId: string, cursor?: WalletActivityCursorDto): Promise<WalletActivityResponseDto> {
    return this.repository.getActivity(userId, cursor);
  }

  async quoteTransfer(userId: string, request: WalletTransferQuoteRequestDto): Promise<WalletTransferQuoteDto> {
    if (!Value.Check(WalletTransferQuoteRequestSchema, request)) throw new Error('INVALID_TRANSFER_AMOUNT');
    return this.repository.quoteTransfer(userId, request);
  }

  async transferCoins(userId: string, request: WalletTransferRequestDto): Promise<WalletTransferResultDto> {
    if (!Value.Check(WalletTransferRequestSchema, request)) throw new Error('INVALID_TRANSFER_AMOUNT');
    return this.repository.transferCoins(userId, request);
  }

  async quoteExchange(userId: string, request: WalletExchangeQuoteRequestDto): Promise<WalletExchangeQuoteDto> {
    if (!Value.Check(WalletExchangeQuoteRequestSchema, request)) throw new Error('INVALID_EXCHANGE_AMOUNT');
    return this.repository.quoteExchange(userId, request);
  }

  async exchangeCoins(userId: string, request: WalletExchangeRequestDto): Promise<WalletExchangeResultDto> {
    if (!Value.Check(WalletExchangeRequestSchema, request)) throw new Error('INVALID_EXCHANGE_AMOUNT');
    return this.repository.exchangeCoins(userId, request);
  }

  listPayoutAccounts(userId: string): Promise<PayoutAccountDto[]> { return this.repository.listPayoutAccounts(userId); }
  async createPayoutAccount(userId: string, request: CreatePayoutAccountRequestDto): Promise<PayoutAccountDto> {
    if (!Value.Check(CreatePayoutAccountRequestSchema, request)) throw new Error('INVALID_PAYOUT_ACCOUNT');
    return this.repository.createPayoutAccount(userId, request);
  }
  deletePayoutAccount(userId: string, payoutAccountId: string): Promise<{ deleted: boolean }> { return this.repository.deletePayoutAccount(userId, payoutAccountId); }
  async quoteWithdrawal(userId: string, request: WithdrawalQuoteRequestDto): Promise<WithdrawalQuoteDto> {
    if (!Value.Check(WithdrawalQuoteRequestSchema, request)) throw new Error('INVALID_WITHDRAWAL_AMOUNT');
    return this.repository.quoteWithdrawal(userId, request);
  }
  listWithdrawals(userId: string): Promise<WithdrawalDto[]> { return this.repository.listWithdrawals(userId); }
  async createWithdrawal(userId: string, request: CreateWithdrawalRequestDto): Promise<WithdrawalDto> {
    if (!Value.Check(CreateWithdrawalRequestSchema, request)) throw new Error('INVALID_WITHDRAWAL_AMOUNT');
    return this.repository.createWithdrawal(userId, request);
  }
  cancelWithdrawal(userId: string, withdrawalId: string): Promise<WithdrawalDto> { return this.repository.cancelWithdrawal(userId, withdrawalId); }
}

export interface WalletApplication {
  getSummary(): Promise<WalletSummaryResponseDto>;
  getActivity(cursor?: WalletActivityCursorDto): Promise<WalletActivityResponseDto>;
  quoteTransfer(request: WalletTransferQuoteRequestDto): Promise<WalletTransferQuoteDto>;
  transferCoins(request: WalletTransferRequestDto): Promise<WalletTransferResultDto>;
  quoteExchange(request: WalletExchangeQuoteRequestDto): Promise<WalletExchangeQuoteDto>;
  exchangeCoins(request: WalletExchangeRequestDto): Promise<WalletExchangeResultDto>;
  listPayoutAccounts(): Promise<PayoutAccountDto[]>;
  createPayoutAccount(request: CreatePayoutAccountRequestDto): Promise<PayoutAccountDto>;
  deletePayoutAccount(payoutAccountId: string): Promise<{ deleted: boolean }>;
  quoteWithdrawal(request: WithdrawalQuoteRequestDto): Promise<WithdrawalQuoteDto>;
  listWithdrawals(): Promise<WithdrawalDto[]>;
  createWithdrawal(request: CreateWithdrawalRequestDto): Promise<WithdrawalDto>;
  cancelWithdrawal(withdrawalId: string): Promise<WithdrawalDto>;
}

export function createWalletApplication(
  readSummary: () => Promise<WalletSummaryResponseDto>,
  readActivity: (cursor?: WalletActivityCursorDto) => Promise<WalletActivityResponseDto>,
  quoteTransfer: (request: WalletTransferQuoteRequestDto) => Promise<WalletTransferQuoteDto>,
  transferCoins: (request: WalletTransferRequestDto) => Promise<WalletTransferResultDto>,
  quoteExchange: (request: WalletExchangeQuoteRequestDto) => Promise<WalletExchangeQuoteDto>,
  exchangeCoins: (request: WalletExchangeRequestDto) => Promise<WalletExchangeResultDto>,
  listPayoutAccounts: () => Promise<PayoutAccountDto[]>,
  createPayoutAccount: (request: CreatePayoutAccountRequestDto) => Promise<PayoutAccountDto>,
  deletePayoutAccount: (payoutAccountId: string) => Promise<{ deleted: boolean }>,
  quoteWithdrawal: (request: WithdrawalQuoteRequestDto) => Promise<WithdrawalQuoteDto>,
  listWithdrawals: () => Promise<WithdrawalDto[]>,
  createWithdrawal: (request: CreateWithdrawalRequestDto) => Promise<WithdrawalDto>,
  cancelWithdrawal: (withdrawalId: string) => Promise<WithdrawalDto>,
): WalletApplication {
  return { getSummary: readSummary, getActivity: readActivity, quoteTransfer, transferCoins, quoteExchange, exchangeCoins, listPayoutAccounts, createPayoutAccount, deletePayoutAccount, quoteWithdrawal, listWithdrawals, createWithdrawal, cancelWithdrawal };
}
