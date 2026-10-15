import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { PaymentChannelSource, PaymentChannelStatus, PaymentMethod, PaymentProviderType } from '@gameing/contracts/payment-channel';
import { createPaymentChannelApplication } from './payment-channel-application';
import { IndexedDbPaymentChannelAdapter } from './indexeddb-payment-channel-adapter';

const adapters: IndexedDbPaymentChannelAdapter[] = [];
const databaseNames = new Set<string>();

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    await adapter.close();
  }
  await Promise.all([...databaseNames].map((databaseName) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Database deletion is blocked: ${databaseName}`));
  })));
  databaseNames.clear();
});

describe('payment channel application', () => {
  it('creates, filters, updates, and audits a local channel with idempotent replay', async () => {
    const adapter = makeAdapter();
    const application = createPaymentChannelApplication(adapter);
    expect(await application.list({})).toMatchObject({ ok: true, value: { items: [] } });
    const request = { requestKey: 'payment-channel-create-0001', providerCode: 'mock-aggregator', providerName: '本机聚合通道', providerType: PaymentProviderType.AGGREGATOR, paymentMethod: PaymentMethod.ALIPAY, sortOrder: 20, reason: '演练支付宝渠道配置' };
    const created = await application.create(request);
    expect(created).toMatchObject({ ok: true, value: { source: PaymentChannelSource.LOCAL_DEMO, status: PaymentChannelStatus.ACTIVE, providerName: '本机聚合通道' } });
    if (!created.ok) throw new Error('Expected a local payment channel');
    const update = { requestKey: 'payment-channel-update-0001', channelId: created.value.channelId, providerName: created.value.providerName, sortOrder: 5, status: PaymentChannelStatus.DISABLED, reason: '暂停本机通道验证状态迁移' };
    expect(await application.update(update)).toMatchObject({ ok: true, value: { status: PaymentChannelStatus.DISABLED, sortOrder: 5 } });
    expect(await application.update(update)).toMatchObject({ ok: true, value: { status: PaymentChannelStatus.DISABLED } });
    expect(await application.list({ status: PaymentChannelStatus.DISABLED })).toMatchObject({ ok: true, value: { items: [{ channelId: created.value.channelId }] } });
    expect(await application.listChanges(created.value.channelId)).toMatchObject({ ok: true, value: [{ previous: { status: PaymentChannelStatus.ACTIVE }, next: { status: PaymentChannelStatus.DISABLED } }, { previous: null, next: { providerCode: 'mock-aggregator' } }] });
    expect(await application.update({ ...update, providerName: '改用同一 key 的冲突值' })).toEqual({ ok: false, code: 'REQUEST_KEY_REUSED' });
  });

  it('rejects duplicate provider/method pairs and malformed values before writing', async () => {
    const adapter = makeAdapter();
    const application = createPaymentChannelApplication(adapter);
    const request = { requestKey: 'payment-channel-create-0002', providerCode: 'mock-pay', providerName: '本机支付服务商', providerType: PaymentProviderType.AGGREGATOR, paymentMethod: PaymentMethod.WECHAT, sortOrder: 1, reason: '创建本机测试通道' };
    expect(await application.create(request)).toMatchObject({ ok: true });
    expect(await application.create({ ...request, requestKey: 'payment-channel-create-0003', paymentMethod: PaymentMethod.ALIPAY })).toMatchObject({ ok: true });
    expect(await application.create({ ...request, requestKey: 'payment-channel-create-0004' })).toEqual({ ok: false, code: 'PROVIDER_METHOD_TAKEN' });
    expect(await application.create({ ...request, requestKey: 'payment-channel-create-0005', providerName: '另一个名字', paymentMethod: PaymentMethod.ALIPAY })).toEqual({ ok: false, code: 'PROVIDER_DETAILS_CONFLICT' });
    expect(await application.create({ ...request, requestKey: 'payment-channel-create-0006', providerCode: 'wrong-tron-type', paymentMethod: PaymentMethod.USDT_TRON })).toEqual({ ok: false, code: 'PROVIDER_METHOD_TYPE_MISMATCH' });
    expect(await application.list({ status: 0 as never })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
  });
});

function makeAdapter(): IndexedDbPaymentChannelAdapter {
  const databaseName = `admin-payment-channel-${crypto.randomUUID()}`;
  databaseNames.add(databaseName);
  const adapter = new IndexedDbPaymentChannelAdapter(databaseName);
  adapters.push(adapter);
  return adapter;
}
