import { describe, expect, test } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { HealthResponseSchema } from './health';
import { WalletAssetSummarySchema, WalletSummaryResponseSchema } from './wallet';
import { MockPaymentOrderDtoSchema, MockPaymentEventDtoSchema } from './mock-payment';
import { NotificationSummaryResponseSchema } from './notifications';
import { IdentitySettingsResponseSchema } from './identity';

/**
 * 契约层回归测试。
 *
 * 契约包是前后端唯一的 DTO 事实源，schema 放宽或收紧都会直接影响服务端校验、
 * 浏览器端请求构造与后台展示，因此这里锁定三类最容易悄悄退化的行为：
 * 1. 时间戳必须严格匹配 ISO UTC 形态（曾出现字符串内 `\.` 退化成「任意字符」的缺陷）；
 * 2. 金额必须以字符串承载并按位精确表达，禁止用 number 承载金额；
 * 3. 对象字段集合固定，新增字段必须显式改契约而不是顺带漂移。
 */

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('契约包时间戳格式', () => {
  test('健康检查的 serverNow 必须是严格 ISO UTC', () => {
    expect(ISO_UTC.test('2026-10-21T09:30:00.000Z')).toBe(true);
    const valid = {
      requestId: 'r-1',
      code: 'OK',
      message: '服务进程正常',
      data: { status: 'live', service: 'gameing-hall-api' },
      serverNow: '2026-10-21T09:30:00.000Z',
    };
    expect(Value.Check(HealthResponseSchema, valid)).toBe(true);
    expect(Value.Check(HealthResponseSchema, { ...valid, serverNow: '2026-10-21T09:30:00X000Z' })).toBe(false);
    expect(Value.Check(HealthResponseSchema, { ...valid, serverNow: '2026-10-21 09:30:00.000Z' })).toBe(false);
  });

  test('支付事件时间戳拒绝非点分隔的毫秒', () => {
    const event = {
      eventId: 'e-1',
      providerEventId: 'p-1',
      orderId: 'LOCAL-MOCK-000001',
      requestKey: 'k-1',
      scenario: 'SUCCESS',
      outcome: 'APPLIED_TO_LOCAL_ORDER',
      receivedAmountCny: '10.00',
      message: 'ok',
      source: 'LOCAL_DEMO',
      createdAt: '2026-10-21T09:30:00.000Z',
    };
    expect(Value.Check(MockPaymentEventDtoSchema, event)).toBe(true);
    expect(Value.Check(MockPaymentEventDtoSchema, { ...event, createdAt: '2026-10-21T09:30:00X000Z' })).toBe(false);
  });
});

describe('契约包金额口径', () => {
  test('模拟支付订单金额必须是两位小数字符串', () => {
    const order = {
      orderId: 'LOCAL-MOCK-000001',
      amountCny: '10.00',
      paymentChannel: {
        channelId: '91001',
        providerCode: 'local-mock',
        providerName: '本机模拟渠道',
        paymentMethod: 1,
      },
      status: 1,
      source: 'LOCAL_DEMO',
      createdAt: '2026-10-21T09:30:00.000Z',
    };
    expect(Value.Check(MockPaymentOrderDtoSchema, order)).toBe(true);
    expect(Value.Check(MockPaymentOrderDtoSchema, { ...order, amountCny: '10X00' })).toBe(false);
    expect(Value.Check(MockPaymentOrderDtoSchema, { ...order, amountCny: 10 })).toBe(false);
    expect(Value.Check(MockPaymentOrderDtoSchema, { ...order, amountCny: '10.000' })).toBe(false);
  });

  test('钱包资产金额保持字符串并区分可用与冻结', () => {
    const asset = {
      assetType: 1,
      currency: 'COIN',
      amount: '12650',
      frozenAmount: '500',
      availableAmount: '12150',
      version: 3,
    };
    expect(Value.Check(WalletAssetSummarySchema, asset)).toBe(true);
    expect(Value.Check(WalletAssetSummarySchema, { ...asset, amount: 12650 })).toBe(false);
    expect(Value.Check(WalletAssetSummarySchema, { ...asset, frozenAmount: '-1' })).toBe(false);
  });

  test('钱包汇总必须同时给出金币与余额两类资产', () => {
    const summary = {
      assets: [
        { assetType: 1, currency: 'COIN', amount: '12650', frozenAmount: '500', availableAmount: '12150', version: 3 },
        { assetType: 2, currency: 'CNY', amount: '2350', frozenAmount: '0', availableAmount: '2350', version: 1 },
      ],
      turnover: { remainingCoins: '0', canTransferOrWithdraw: true },
      welcomeGift: null,
    };
    expect(Value.Check(WalletSummaryResponseSchema, summary)).toBe(true);
    expect(Value.Check(WalletSummaryResponseSchema, { ...summary, assets: [summary.assets[0]] })).toBe(false);
  });
});

describe('契约字段集合固定', () => {
  test('通知汇总结构固定', () => {
    const response = { items: [], unavailableSources: [] };
    expect(Value.Check(NotificationSummaryResponseSchema, response)).toBe(true);
    expect(Value.Check(NotificationSummaryResponseSchema, { ...response, extra: 1 })).toBe(false);
  });

  test('身份设置响应字段固定且类型受约束', () => {
    const settings = {
      username: 'demo_player',
      email: null,
      phone: null,
      passwordConfigured: true,
      totpEnabled: false,
      recoveryCredential: { available: false, expiresAt: null },
    };
    expect(Value.Check(IdentitySettingsResponseSchema, settings)).toBe(true);
    expect(Value.Check(IdentitySettingsResponseSchema, { ...settings, totpEnabled: 'yes' })).toBe(false);
    expect(Value.Check(IdentitySettingsResponseSchema, { ...settings, unknownField: 1 })).toBe(false);
  });
});
