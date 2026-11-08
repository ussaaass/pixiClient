import { describe, expect, test } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { HealthResponseSchema } from './health';
import { WalletAssetSummarySchema, WalletSummaryResponseSchema } from './wallet';
import { MockPaymentOrderDtoSchema, MockPaymentEventDtoSchema } from './mock-payment';
import { NotificationSummaryResponseSchema } from './notifications';
import { IdentitySettingsResponseSchema, RefreshRequestSchema } from './identity';
import {
  RoundSettlementQuerySchema,
  RoundSettlementResponseSchema,
  RoundStartRequestSchema,
  RoundStartResponseSchema,
  RoomCreatedResponseSchema,
  RoundSubmitRequestSchema,
  RoundSubmitResponseSchema,
} from './game-room';
import { CoinMarketTradeStatus, CoinMarketTradeSchema } from './coin-market';

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

describe('刷新请求契约', () => {
  test('requires a bounded opaque operation id and rejects extra data', () => {
    expect(Value.Check(RefreshRequestSchema, { operationId: 'operation_id_123456' })).toBe(true);
    expect(Value.Check(RefreshRequestSchema, { operationId: 'short' })).toBe(false);
    expect(Value.Check(RefreshRequestSchema, { operationId: 'operation_id_123456', extra: true })).toBe(false);
  });
});

describe('room creation response contract', () => {
  test('matches RoomCreateUseCase DTO with explicit replay state', () => {
    const response = { roomId: '12', roomCode: 'ABC234', status: 1, capacity: 4, ownerKey: 'owner:9', replay: false };
    expect(Value.Check(RoomCreatedResponseSchema, response)).toBe(true);
    expect(Value.Check(RoomCreatedResponseSchema, { ...response, replay: 'false' })).toBe(false);
    expect(Value.Check(RoomCreatedResponseSchema, { ...response, createdAt: '2026-11-06T13:00:00.000Z' })).toBe(false);
  });
});

describe('round start response contract', () => {
  test('matches RoundStartUseCase DTO including replay and rejects route-local fields', () => {
    const response = { roundId: '12', roundKey: 'round-key', status: 2, replay: true };
    expect(Value.Check(RoundStartResponseSchema, response)).toBe(true);
    expect(Value.Check(RoundStartResponseSchema, { ...response, roundNo: '3' })).toBe(false);
    expect(Value.Check(RoundStartResponseSchema, { ...response, status: 'ACTIVE' })).toBe(false);
    expect(Value.Check(RoundStartResponseSchema, { ...response, replay: 'true' })).toBe(false);
  });
});

describe('round start request contract', () => {
  test('accepts only client-selected water units and fencing token, never coin amounts', () => {
    const valid = { fencingToken: '12', waterUnits: '1' };
    expect(Value.Check(RoundStartRequestSchema, valid)).toBe(true);
    for (const units of ['0', '01', '-1', '1.5']) {
      expect(Value.Check(RoundStartRequestSchema, { ...valid, waterUnits: units })).toBe(false);
    }
    expect(Value.Check(RoundStartRequestSchema, { ...valid, fencingToken: '0' })).toBe(false);
    expect(Value.Check(RoundStartRequestSchema, { ...valid, wagerCoins: '1', maxLossHoldCoins: '100' })).toBe(false);
    expect(Value.Check(RoundStartRequestSchema, { ...valid, extra: true })).toBe(false);
  });
});

describe('round submit response contract', () => {
  test('matches RoundSubmitUseCase DTO and rejects route-local omissions', () => {
    const response = {
      roundId: '12',
      roundPlayerId: '34',
      submittedAt: '2026-11-06T13:00:00.000Z',
      replay: false,
      allSubmitted: true,
    };
    expect(Value.Check(RoundSubmitResponseSchema, response)).toBe(true);
    expect(Value.Check(RoundSubmitResponseSchema, { ...response, replay: 'false' })).toBe(false);
    expect(Value.Check(RoundSubmitResponseSchema, { ...response, extra: true })).toBe(false);
  });
});

describe('round submit request contract', () => {
  test('accepts exact 3/5/5 piles and rejects malformed cards, attempts and extra properties', () => {
    const valid = {
      fencingToken: '12',
      arrangement: { front: [0, 1, 2], middle: [3, 4, 5, 6, 7], back: [8, 9, 10, 11, 12] },
      attempt: 1,
    };
    expect(Value.Check(RoundSubmitRequestSchema, valid)).toBe(true);
    expect(Value.Check(RoundSubmitRequestSchema, { ...valid, arrangement: { ...valid.arrangement, front: [0, 1] } })).toBe(false);
    expect(Value.Check(RoundSubmitRequestSchema, { ...valid, arrangement: { ...valid.arrangement, back: [0, 1, 2, 3, 52] } })).toBe(false);
    expect(Value.Check(RoundSubmitRequestSchema, { ...valid, attempt: 0 })).toBe(false);
    expect(Value.Check(RoundSubmitRequestSchema, { ...valid, fencingToken: '0' })).toBe(false);
    expect(Value.Check(RoundSubmitRequestSchema, { ...valid, fencingToken: '00012' })).toBe(false);
    expect(Value.Check(RoundSubmitRequestSchema, { ...valid, fencingToken: '1'.repeat(21) })).toBe(false);
    expect(Value.Check(RoundSubmitRequestSchema, { ...valid, ignored: true })).toBe(false);
  });
});

describe('房间结算契约', () => {
  test('结算轮询可不带 fencing token，触发时只接受正整数字符串', () => {
    expect(Value.Check(RoundSettlementQuerySchema, {})).toBe(true);
    expect(Value.Check(RoundSettlementQuerySchema, { fencingToken: '12' })).toBe(true);
    expect(Value.Check(RoundSettlementQuerySchema, { fencingToken: '' })).toBe(false);
    expect(Value.Check(RoundSettlementQuerySchema, { fencingToken: '0' })).toBe(false);
    expect(Value.Check(RoundSettlementQuerySchema, { fencingToken: 12 })).toBe(false);
    expect(Value.Check(RoundSettlementQuerySchema, { extra: true })).toBe(false);
  });

  test('settlement response matches the use-case DTO and rejects route-local drift', () => {
    const response = {
      roundId: '10',
      settlementId: '20',
      players: [{ userId: '1', water: '-5', foul: false }],
      replay: true,
    };
    expect(Value.Check(RoundSettlementResponseSchema, response)).toBe(true);
    expect(Value.Check(RoundSettlementResponseSchema, { ...response, status: 'SETTLED' })).toBe(false);
    expect(Value.Check(RoundSettlementResponseSchema, { ...response, players: [{ ...response.players[0], water: -5 }] })).toBe(false);
  });
});

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

describe('金币集市交易状态契约', () => {
  test('status 名称与值完全镜像 coin_market_trade 的 DDL 状态机', () => {
    expect(CoinMarketTradeStatus).toEqual({
      PAYMENT_PENDING: 1,
      SELLER_CONFIRMATION_PENDING: 2,
      DISPUTED: 3,
      BUYER_EVIDENCE_PENDING: 4,
      SELLER_EVIDENCE_PENDING: 5,
      PLATFORM_REVIEW: 6,
      RELEASED: 7,
      AUTO_RELEASED: 8,
      PAYMENT_EXPIRED: 9,
      RESOLVED_RETURN: 10,
      CANCELLED: 11,
    });
    expect(Object.values(CoinMarketTradeStatus)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const trade = {
      tradeId: '1',
      listingId: '2',
      actorRole: 'BUYER',
      coins: '1000',
      grossCents: '100',
      paymentMethod: 1,
      paymentInstructions: '',
      paymentDeadlineAt: '2026-10-21T09:30:00.000Z',
      sellerDeadlineAt: null,
      buyerEvidenceDeadlineAt: null,
      sellerEvidenceDeadlineAt: null,
      platformDecisionDeadlineAt: null,
      paymentProof: null,
      appealReason: null,
      buyerEvidence: null,
      sellerEvidence: null,
      createdAt: '2026-10-21T09:30:00.000Z',
      updatedAt: '2026-10-21T09:30:00.000Z',
    };
    for (const status of Object.values(CoinMarketTradeStatus)) {
      expect(Value.Check(CoinMarketTradeSchema, { ...trade, status })).toBe(true);
    }
    expect(Value.Check(CoinMarketTradeSchema, { ...trade, status: 0 })).toBe(false);
    expect(Value.Check(CoinMarketTradeSchema, { ...trade, status: 12 })).toBe(false);
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
