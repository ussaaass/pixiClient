import { Value } from '@sinclair/typebox/value';
import {
  CreatePaymentChannelRequestSchema,
  PaymentChannelChangeDtoSchema,
  PaymentChannelDtoSchema,
  PaymentChannelQuerySchema,
  PaymentChannelSource,
  PaymentChannelStatus,
  PaymentChannelWorkspaceSchema,
  PaymentMethod,
  PaymentProviderType,
  UpdatePaymentChannelRequestSchema,
  type CreatePaymentChannelRequestDto,
  type PaymentChannelChangeDto,
  type PaymentChannelDto,
  type PaymentChannelQueryDto,
  type PaymentChannelWorkspace,
  type UpdatePaymentChannelRequestDto,
} from '@gameing/contracts/payment-channel';

export type PaymentChannelFailure = 'INVALID_REQUEST' | 'CHANNEL_NOT_FOUND' | 'PROVIDER_METHOD_TAKEN' | 'PROVIDER_DETAILS_CONFLICT' | 'PROVIDER_METHOD_TYPE_MISMATCH' | 'REQUEST_KEY_REUSED';
export type PaymentChannelResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: PaymentChannelFailure };

export interface PaymentChannelRepositoryPort {
  listChannels(): Promise<PaymentChannelDto[]>;
  findChannel(channelId: string): Promise<PaymentChannelDto | null>;
  findProviderByCode(providerCode: string): Promise<Pick<PaymentChannelDto, 'providerCode' | 'providerName' | 'providerType'> | null>;
  findByProviderMethod(providerCode: string, paymentMethod: PaymentChannelDto['paymentMethod']): Promise<PaymentChannelDto | null>;
  findChangeByRequestKey(requestKey: string): Promise<PaymentChannelChangeDto | null>;
  listChanges(channelId: string): Promise<PaymentChannelChangeDto[]>;
  commit(channel: PaymentChannelDto, change: PaymentChannelChangeDto): Promise<void>;
  createId(): string;
  createChannelId(): string;
  now(): string;
}

export interface PaymentChannelApplication {
  list(query: PaymentChannelQueryDto): Promise<PaymentChannelResult<PaymentChannelWorkspace>>;
  listChanges(channelId: string): Promise<PaymentChannelResult<PaymentChannelChangeDto[]>>;
  create(request: CreatePaymentChannelRequestDto): Promise<PaymentChannelResult<PaymentChannelDto>>;
  update(request: UpdatePaymentChannelRequestDto): Promise<PaymentChannelResult<PaymentChannelDto>>;
}

const fail = <T>(code: PaymentChannelFailure): PaymentChannelResult<T> => ({ ok: false, code });

function sameChange(request: CreatePaymentChannelRequestDto | UpdatePaymentChannelRequestDto, change: PaymentChannelChangeDto): boolean {
  if ('channelId' in request && request.channelId !== change.channelId) return false;
  if (request.providerName !== change.next.providerName || request.sortOrder !== change.next.sortOrder || request.reason !== change.reason) return false;
  if ('providerCode' in request) {
    return change.previous === null && request.providerCode === change.next.providerCode
      && request.providerType === change.next.providerType && request.paymentMethod === change.next.paymentMethod;
  }
  return change.previous !== null && request.status === change.next.status;
}

export function createPaymentChannelApplication(repository: PaymentChannelRepositoryPort): PaymentChannelApplication {
  return {
    async list(query) {
      if (!Value.Check(PaymentChannelQuerySchema, query)) return fail('INVALID_REQUEST');
      const channels = await repository.listChannels();
      if (!channels.every((channel) => Value.Check(PaymentChannelDtoSchema, channel))) return fail('INVALID_REQUEST');
      const keyword = query.keyword?.trim().toLocaleLowerCase();
      const items = channels.filter((channel) => {
        const matchesKeyword = !keyword || `${channel.providerCode} ${channel.providerName}`.toLocaleLowerCase().includes(keyword);
        return matchesKeyword
          && (query.paymentMethod === undefined || channel.paymentMethod === query.paymentMethod)
          && (query.status === undefined || channel.status === query.status);
      }).sort((left, right) => left.sortOrder - right.sortOrder || left.providerCode.localeCompare(right.providerCode));
      const workspace: PaymentChannelWorkspace = { source: PaymentChannelSource.LOCAL_DEMO, items };
      return Value.Check(PaymentChannelWorkspaceSchema, workspace) ? { ok: true, value: workspace } : fail('INVALID_REQUEST');
    },

    async listChanges(channelId) {
      if (!/^[1-9][0-9]{0,19}$/.test(channelId)) return fail('INVALID_REQUEST');
      const changes = await repository.listChanges(channelId);
      return changes.every((change) => Value.Check(PaymentChannelChangeDtoSchema, change)) ? { ok: true, value: changes } : fail('INVALID_REQUEST');
    },

    async create(request) {
      if (!Value.Check(CreatePaymentChannelRequestSchema, request)) return fail('INVALID_REQUEST');
      const normalized = { ...request, providerCode: request.providerCode.trim().toLocaleLowerCase(), providerName: request.providerName.trim(), reason: request.reason.trim() };
      if (!Value.Check(CreatePaymentChannelRequestSchema, normalized)) return fail('INVALID_REQUEST');
      const isUsdt = normalized.paymentMethod === PaymentMethod.USDT_TRON;
      if (isUsdt !== (normalized.providerType === PaymentProviderType.TRON_SELF_HOSTED)) return fail('PROVIDER_METHOD_TYPE_MISMATCH');
      const replay = await repository.findChangeByRequestKey(normalized.requestKey);
      if (replay) return sameChange(normalized, replay) ? { ok: true, value: replay.next } : fail('REQUEST_KEY_REUSED');
      const existingProvider = await repository.findProviderByCode(normalized.providerCode);
      if (existingProvider && (existingProvider.providerName !== normalized.providerName || existingProvider.providerType !== normalized.providerType)) return fail('PROVIDER_DETAILS_CONFLICT');
      if (await repository.findByProviderMethod(normalized.providerCode, normalized.paymentMethod)) return fail('PROVIDER_METHOD_TAKEN');
      const now = repository.now();
      const channel: PaymentChannelDto = {
        channelId: repository.createChannelId(),
        providerCode: normalized.providerCode,
        providerName: normalized.providerName,
        providerType: normalized.providerType,
        paymentMethod: normalized.paymentMethod,
        sortOrder: normalized.sortOrder,
        status: PaymentChannelStatus.ACTIVE,
        source: PaymentChannelSource.LOCAL_DEMO,
        updatedAt: now,
      };
      const change: PaymentChannelChangeDto = {
        changeId: repository.createId(), requestKey: normalized.requestKey, channelId: channel.channelId,
        previous: null, next: channel, reason: normalized.reason, source: PaymentChannelSource.LOCAL_DEMO, createdAt: now,
      };
      if (!Value.Check(PaymentChannelDtoSchema, channel) || !Value.Check(PaymentChannelChangeDtoSchema, change)) return fail('INVALID_REQUEST');
      try {
        await repository.commit(channel, change);
      } catch (error) {
        const committed = await repository.findChangeByRequestKey(normalized.requestKey);
        if (committed) return sameChange(normalized, committed) ? { ok: true, value: committed.next } : fail('REQUEST_KEY_REUSED');
        const currentProvider = await repository.findProviderByCode(normalized.providerCode);
        if (currentProvider && (currentProvider.providerName !== normalized.providerName || currentProvider.providerType !== normalized.providerType)) return fail('PROVIDER_DETAILS_CONFLICT');
        if (await repository.findByProviderMethod(normalized.providerCode, normalized.paymentMethod)) return fail('PROVIDER_METHOD_TAKEN');
        throw error;
      }
      return { ok: true, value: channel };
    },

    async update(request) {
      if (!Value.Check(UpdatePaymentChannelRequestSchema, request)) return fail('INVALID_REQUEST');
      const normalized = { ...request, providerName: request.providerName.trim(), reason: request.reason.trim() };
      if (!Value.Check(UpdatePaymentChannelRequestSchema, normalized)) return fail('INVALID_REQUEST');
      const replay = await repository.findChangeByRequestKey(normalized.requestKey);
      if (replay) return sameChange(normalized, replay) ? { ok: true, value: replay.next } : fail('REQUEST_KEY_REUSED');
      const previous = await repository.findChannel(normalized.channelId);
      if (!previous) return fail('CHANNEL_NOT_FOUND');
      const changedAt = repository.now();
      const next: PaymentChannelDto = { ...previous, providerName: normalized.providerName, sortOrder: normalized.sortOrder, status: normalized.status, updatedAt: changedAt };
      const change: PaymentChannelChangeDto = {
        changeId: repository.createId(), requestKey: normalized.requestKey, channelId: previous.channelId,
        previous, next, reason: normalized.reason, source: PaymentChannelSource.LOCAL_DEMO, createdAt: changedAt,
      };
      if (!Value.Check(PaymentChannelDtoSchema, next) || !Value.Check(PaymentChannelChangeDtoSchema, change)) return fail('INVALID_REQUEST');
      try {
        await repository.commit(next, change);
      } catch (error) {
        const committed = await repository.findChangeByRequestKey(normalized.requestKey);
        if (committed) return sameChange(normalized, committed) ? { ok: true, value: committed.next } : fail('REQUEST_KEY_REUSED');
        throw error;
      }
      return { ok: true, value: next };
    },
  };
}
