import { describe, expect, test } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { AdminUserSummaryDtoSchema, AdminUserQuerySchema, AdminUserStatus, AdminUserRoleType, AdminUserSource } from './admin-users';
import { SystemConfigDraftDtoSchema, SystemConfigEntryDtoSchema, SystemConfigValueKind, SystemConfigDraftStatus } from './system-config';
import { AgentDomainReviewAuditDtoSchema, AgentDomainReviewAuditSource } from './agent-domain-review';

/**
 * 后台契约层回归测试。
 *
 * 与玩家侧契约包同源的问题：schema 的正则、字段集合与枚举一旦悄悄放宽，
 * 后台页面的"看起来正常"就会掩盖服务端校验被绕过。因此锁定三类行为：
 * 1. 时间戳与 ID 形态必须严格（曾出现字符串内 `\.` 退化成「任意字符」的缺陷）；
 * 2. 枚举必须是契约里声明的数值/字面量，不接受"看起来像"的字符串；
 * 3. 对象字段集合固定，新增字段必须显式改契约而不是顺带漂移。
 */

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('后台契约包时间戳与 ID 形态', () => {
  test('用户概览的 createdAt 必须是严格 ISO UTC', () => {
    const summary = {
      userId: '1001',
      username: 'demo_player',
      nickname: '演示玩家',
      roleType: AdminUserRoleType.PLAYER,
      status: AdminUserStatus.ACTIVE,
      parent1UserId: null,
      createdAt: '2026-10-21T09:30:00.000Z',
      source: AdminUserSource.LOCAL_DEMO,
    };
    expect(Value.Check(AdminUserSummaryDtoSchema, summary)).toBe(true);
    expect(Value.Check(AdminUserSummaryDtoSchema, { ...summary, createdAt: '2026-10-21T09:30:00X000Z' })).toBe(false);
    expect(Value.Check(AdminUserSummaryDtoSchema, { ...summary, createdAt: '2026-10-21 09:30:00.000Z' })).toBe(false);
  });

  test('用户 ID 拒绝前导零与零本身', () => {
    const summary = {
      userId: '1001',
      username: null,
      nickname: '演示玩家',
      roleType: AdminUserRoleType.PLAYER_AGENT,
      status: AdminUserStatus.DISABLED,
      parent1UserId: '1002',
      createdAt: '2026-10-21T09:30:00.000Z',
      source: AdminUserSource.SERVER,
    };
    expect(Value.Check(AdminUserSummaryDtoSchema, summary)).toBe(true);
    expect(Value.Check(AdminUserSummaryDtoSchema, { ...summary, userId: '01001' })).toBe(false);
    expect(Value.Check(AdminUserSummaryDtoSchema, { ...summary, userId: '0' })).toBe(false);
    expect(Value.Check(AdminUserSummaryDtoSchema, { ...summary, parent1UserId: '0' })).toBe(false);
  });
});

describe('后台契约包枚举口径', () => {
  test('角色与状态只接受契约声明的数值枚举', () => {
    const summary = {
      userId: '1001',
      username: 'demo_player',
      nickname: '演示玩家',
      roleType: AdminUserRoleType.PLAYER,
      status: AdminUserStatus.ACTIVE,
      parent1UserId: null,
      createdAt: '2026-10-21T09:30:00.000Z',
      source: AdminUserSource.LOCAL_DEMO,
    };
    expect(Value.Check(AdminUserSummaryDtoSchema, { ...summary, roleType: 'PLAYER' })).toBe(false);
    expect(Value.Check(AdminUserSummaryDtoSchema, { ...summary, status: 'ACTIVE' })).toBe(false);
    expect(Value.Check(AdminUserSummaryDtoSchema, { ...summary, source: 'LOCAL_DEMO' })).toBe(false);
  });

  test('查询条件的 pageSize 上限为 100', () => {
    expect(Value.Check(AdminUserQuerySchema, { pageSize: 100 })).toBe(true);
    expect(Value.Check(AdminUserQuerySchema, { pageSize: 101 })).toBe(false);
    expect(Value.Check(AdminUserQuerySchema, { pageSize: 0 })).toBe(false);
    expect(Value.Check(AdminUserQuerySchema, { cursor: '0' })).toBe(false);
  });
});

describe('后台契约字段集合固定', () => {
  test('系统配置条目字段固定且 valueKind 受枚举约束', () => {
    const entry = {
      configKey: 'withdraw_min_amount',
      title: '最小提现金额',
      configType: 'wallet',
      valueKind: SystemConfigValueKind.UNSIGNED_INTEGER,
      referenceValue: '10',
      unit: 'CNY',
      description: '单笔提现的最小金额',
    };
    expect(Value.Check(SystemConfigEntryDtoSchema, entry)).toBe(true);
    // valueKind 是字符串字面量枚举，未声明的值必须被拒绝
    expect(Value.Check(SystemConfigEntryDtoSchema, { ...entry, valueKind: 'RATIO' })).toBe(false);
    expect(Value.Check(SystemConfigEntryDtoSchema, { ...entry, extra: 1 })).toBe(false);
    expect(Value.Check(SystemConfigEntryDtoSchema, { ...entry, configKey: 'Withdraw_Min' })).toBe(false);
  });

  test('系统配置草稿时间戳严格且状态固定为 DRAFT', () => {
    const draft = {
      draftId: 'draft-1',
      requestKey: 'req-1',
      configKey: 'withdraw_min_amount',
      baseValue: '10',
      proposedValue: '20',
      reason: '调整最小提现金额',
      status: SystemConfigDraftStatus.DRAFT,
      createdAt: '2026-10-21T09:30:00.000Z',
    };
    expect(Value.Check(SystemConfigDraftDtoSchema, draft)).toBe(true);
    expect(Value.Check(SystemConfigDraftDtoSchema, { ...draft, createdAt: '2026-10-21T09:30:00X000Z' })).toBe(false);
    expect(Value.Check(SystemConfigDraftDtoSchema, { ...draft, status: 2 })).toBe(false);
    expect(Value.Check(SystemConfigDraftDtoSchema, { ...draft, reason: '短' })).toBe(false);
  });

  test('代理域名审核记录字段固定', () => {
    const audit = {
      auditId: 'audit-1',
      userId: '1001',
      requestKey: 'req-00000001',
      action: 'APPROVE',
      previousStatus: 1,
      nextStatus: 2,
      previousCapabilities: [],
      nextCapabilities: [],
      reason: '资料齐全',
      source: AgentDomainReviewAuditSource.LOCAL_DEMO,
      resultingDomain: {
        userId: '1001',
        status: 2,
        appliedAt: '2026-10-21T09:30:00.000Z',
        capabilities: [],
      },
      createdAt: '2026-10-21T09:30:00.000Z',
    };
    expect(Value.Check(AgentDomainReviewAuditDtoSchema, audit)).toBe(true);
    expect(Value.Check(AgentDomainReviewAuditDtoSchema, { ...audit, createdAt: '2026-10-21T09:30:00X000Z' })).toBe(false);
    expect(Value.Check(AgentDomainReviewAuditDtoSchema, { ...audit, unknownField: 1 })).toBe(false);
    expect(Value.Check(AgentDomainReviewAuditDtoSchema, { ...audit, action: 'UNKNOWN_ACTION' })).toBe(false);
  });
});

describe('后台契约包的正则不得退化为通配', () => {
  test('ISO UTC 正则中的点必须匹配字面量点', () => {
    expect(ISO_UTC.test('2026-10-21T09:30:00.000Z')).toBe(true);
    expect(ISO_UTC.test('2026-10-21T09:30:00X000Z')).toBe(false);
  });
});
