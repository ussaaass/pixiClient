import { Value } from '@sinclair/typebox/value';
import { CreateFundingOrderRequestSchema, FundingChannelListResponseSchema, FundingOrderDtoSchema, FundingOrderListResponseSchema, SimulateFundingPaymentRequestSchema, type CreateFundingOrderRequestDto, type FundingChannelDto, type FundingOrderDto, type SimulateFundingPaymentRequestDto } from '@gameing/contracts/wallet-funding';

export interface WalletFundingRepository {
  listChannels(): Promise<FundingChannelDto[]>;
  listOrders(userId: string): Promise<FundingOrderDto[]>;
  createOrder(userId: string, request: CreateFundingOrderRequestDto): Promise<FundingOrderDto>;
  simulatePayment(userId: string, request: SimulateFundingPaymentRequestDto): Promise<FundingOrderDto>;
}

export class WalletFundingUseCases {
  constructor(private readonly repository: WalletFundingRepository) {}
  async listChannels(): Promise<FundingChannelDto[]> {
    const channels = await this.repository.listChannels();
    if (!Value.Check(FundingChannelListResponseSchema, channels)) throw new Error('FUNDING_CHANNELS_INVALID');
    return channels;
  }
  async listOrders(userId: string): Promise<FundingOrderDto[]> {
    const orders = await this.repository.listOrders(userId);
    if (!Value.Check(FundingOrderListResponseSchema, orders)) throw new Error('FUNDING_ORDERS_INVALID');
    return orders;
  }
  async createOrder(userId: string, request: CreateFundingOrderRequestDto): Promise<FundingOrderDto> {
    if (!Value.Check(CreateFundingOrderRequestSchema, request)) throw new Error('INVALID_ORDER_AMOUNT');
    const order = await this.repository.createOrder(userId, request);
    if (!Value.Check(FundingOrderDtoSchema, order)) throw new Error('FUNDING_ORDER_INVALID');
    return order;
  }
  async simulatePayment(userId: string, request: SimulateFundingPaymentRequestDto): Promise<FundingOrderDto> {
    if (!Value.Check(SimulateFundingPaymentRequestSchema, request)) throw new Error('FUNDING_ORDER_NOT_PAYABLE');
    const order = await this.repository.simulatePayment(userId, request);
    if (!Value.Check(FundingOrderDtoSchema, order)) throw new Error('FUNDING_ORDER_INVALID');
    return order;
  }
}

export interface WalletFundingApplication {
  listChannels(): Promise<FundingChannelDto[]>;
  listOrders(): Promise<FundingOrderDto[]>;
  createOrder(request: CreateFundingOrderRequestDto): Promise<FundingOrderDto>;
  simulatePayment(request: SimulateFundingPaymentRequestDto): Promise<FundingOrderDto>;
}

