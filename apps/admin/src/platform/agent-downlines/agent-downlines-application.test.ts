import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import 'fake-indexeddb/auto';
import { AgentDownlineDetailReadRequestSchema, AgentDownlineDetailSchema, AgentDownlineStatus } from '@gameing/contracts/agent-downlines';
import { createAgentAuditReadApplication } from './agent-audit-application';
import { createAgentDownlineReadApplication } from './agent-downlines-application';
import { OfflineAgentDownlineAdapter } from './offline-agent-downline-adapter';
import { openAdminDevelopmentDatabase } from '../browser-development-database';

describe('Agent downline read application', () => {
  it('runtime-validates query, filters and advances stable cursor pages without duplication', async () => {
    const app = createAgentDownlineReadApplication(new OfflineAgentDownlineAdapter());
    const invalid = await app.list({ status: 0 as never });
    expect(invalid).toEqual({ ok: false, code: 'INVALID_QUERY' });

    const first = await app.list({ pageSize: 2 });
    expect(first.ok && first.value.items.map((item) => item.userId)).toEqual(['91001', '91002']);
    expect(first.ok && first.value.nextCursor).toBe('3');
    const cursor = first.ok ? first.value.nextCursor : null;
    expect(cursor).toBe('3');
    const second = await app.list({ pageSize: 2, ...(cursor ? { cursor } : {}) });
    expect(second.ok && second.value.items.map((item) => item.userId)).toEqual(['91003']);
    expect(second.ok && second.value.nextCursor).toBeNull();

    const filtered = await app.list({ status: AgentDownlineStatus.SUSPENDED });
    expect(filtered.ok && filtered.value.items.map((item) => item.userId)).toEqual(['91003']);
    const byName = await app.list({ keyword: '晚风' });
    expect(byName.ok && byName.value.items.map((item) => item.userId)).toEqual(['91002']);
  });

  it('returns a detail snapshot without credential fields and rejects malformed IDs', async () => {
    const databaseName = `agent-downline-test-${crypto.randomUUID()}`;
    const adapter = new OfflineAgentDownlineAdapter(databaseName);
    const app = createAgentDownlineReadApplication(adapter);
    const request = { purposeCode: 'ASSET_EXCEPTION_FOLLOWUP' as const, requestKey: 'a1111111-1111-4111-8111-111111111111' };
    expect(Value.Check(AgentDownlineDetailReadRequestSchema, request)).toBe(true);
    expect(await app.detail('91001', { ...request, purposeCode: 'SUPPORT_CASE' })).toEqual({ ok: false, code: 'INVALID_QUERY' });
    const result = await app.detail('91001', request);
    expect(result.ok && result.value.downline.userId).toBe('91001');
    if (result.ok) {
      expect(Value.Check(AgentDownlineDetailSchema, result.value)).toBe(true);
      expect(Value.Check(AgentDownlineDetailSchema, { ...result.value, downline: { ...result.value.downline, cnyAvailableFen: '-1' } })).toBe(false);
    }
    expect(JSON.stringify(result)).not.toMatch(/password|totp|recoverySecret/i);
    const replay = await app.detail('91001', request);
    expect(replay.ok && replay.value.downline.userId).toBe('91001');
    expect(await app.detail('0', request)).toEqual({ ok: false, code: 'NOT_FOUND' });
    const unknown = await app.detail('91999', { ...request, requestKey: 'a2222222-2222-4222-8222-222222222222' });
    expect(unknown).toEqual({ ok: false, code: 'NOT_FOUND' });
    const database = await openAdminDevelopmentDatabase(databaseName);
    const audits = await database.getAll('agent_audit_events');
    expect(audits.find((audit) => audit.requestKey === request.requestKey)?.resultType).toBe(1);
    expect(audits.filter((audit) => audit.requestKey === request.requestKey)).toHaveLength(1);
    expect(audits.find((audit) => audit.requestKey === 'a2222222-2222-4222-8222-222222222222')?.resultType).toBe(2);
    await database.close();
    const auditRead = await createAgentAuditReadApplication(adapter).list({ keyword: '资产异常' });
    expect(auditRead.ok && auditRead.value.total).toBe(2);
    expect(auditRead.ok && auditRead.value.items.some((event) => event.resourceKey === '91001' && event.resultType === 1)).toBe(true);
  });

  it('maps repository failures to a retryable application result', async () => {
    const failing = createAgentDownlineReadApplication({
      async list() { throw new Error('offline'); },
      async readDetail() { throw new Error('offline'); },
    });
    expect(await failing.list({})).toEqual({ ok: false, code: 'READ_FAILED' });
    expect(await failing.detail('91001', { purposeCode: 'ROUTINE_OPERATIONS_REVIEW', requestKey: 'a3333333-3333-4333-8333-333333333333' })).toEqual({ ok: false, code: 'READ_FAILED' });
  });
});
