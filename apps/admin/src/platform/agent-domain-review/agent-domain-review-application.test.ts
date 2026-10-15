import { afterEach, describe, expect, it } from 'vitest';
import { AgentCapabilityCode, AgentDomainAdminAction, AgentDomainStatus, type AgentDomainAdminActionRequestDto } from '@gameing/contracts/invite-agent';
import { AgentDomainReviewAuditSource } from '@gameing/admin-contracts/agent-domain-review';
import { createAgentDomainReviewApplication, createLocalAgentDomainDemoApplication } from './agent-domain-review-application';
import { IndexedDbAgentDomainReviewAdapter } from './indexeddb-agent-domain-review-adapter';

const databaseNames = new Set<string>();
const adapters: IndexedDbAgentDomainReviewAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all([...databaseNames].map((databaseName) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Database deletion is blocked: ${databaseName}`));
  })));
  databaseNames.clear();
});

function setup() {
  const databaseName = `admin-agent-review-${crypto.randomUUID()}`;
  databaseNames.add(databaseName);
  const adapter = new IndexedDbAgentDomainReviewAdapter(databaseName);
  adapters.push(adapter);
  return { adapter, application: { ...createAgentDomainReviewApplication(adapter), ...createLocalAgentDomainDemoApplication(adapter) }, databaseName };
}

describe('agent domain review application', () => {
  it('approves with registered capabilities, commits an audit, and replays idempotently after reload', async () => {
    const { adapter, application, databaseName } = setup();
    const pending = await application.createLocalDemoApplication();
    expect(pending.ok && pending.value.status).toBe(AgentDomainStatus.PENDING_REVIEW);
    if (!pending.ok) return;
    const request: AgentDomainAdminActionRequestDto = {
      requestKey: 'approve-domain-0001',
      userId: pending.value.userId,
      action: AgentDomainAdminAction.APPROVE,
      capabilities: [AgentCapabilityCode.DASHBOARD_READ, AgentCapabilityCode.SOCIAL_READ_PRIVATE_MESSAGES],
      reason: '批准本机演练并限定必要权限',
    };

    const approved = await application.execute(request);
    expect(approved).toMatchObject({ ok: true, value: { agentDomain: { status: AgentDomainStatus.ACTIVE, capabilities: request.capabilities } } });
    const audit = await application.listAudits(pending.value.userId);
    expect(audit).toMatchObject({ ok: true, value: [{ previousStatus: AgentDomainStatus.PENDING_REVIEW, nextStatus: AgentDomainStatus.ACTIVE, source: AgentDomainReviewAuditSource.LOCAL_DEMO, reason: request.reason }] });
    await adapter.close();

    const reopened = new IndexedDbAgentDomainReviewAdapter(databaseName);
    adapters.push(reopened);
    const reopenedApplication = createAgentDomainReviewApplication(reopened);
    expect(await reopenedApplication.listDomains()).toMatchObject({ ok: true, value: [{ userId: pending.value.userId, status: AgentDomainStatus.ACTIVE }] });
    expect(await reopenedApplication.execute(request)).toEqual(approved);
    expect(await reopenedApplication.execute({ ...request, reason: '重用请求键但更改内容' })).toMatchObject({ ok: false, code: 'REQUEST_KEY_REUSED' });
  });

  it('rejects invalid grants and reasons, then preserves a rejected application and its audit', async () => {
    const { application } = setup();
    const pending = await application.createLocalDemoApplication();
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    const base: AgentDomainAdminActionRequestDto = {
      requestKey: 'reject-domain-0001',
      userId: pending.value.userId,
      action: AgentDomainAdminAction.REJECT,
      capabilities: [],
      reason: '材料不符合演练规则',
    };
    expect(await application.execute({ ...base, reason: '  ' })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(await application.execute({ ...base, capabilities: [AgentCapabilityCode.DOWNLINE_READ] })).toMatchObject({ ok: false, code: 'REJECT_CANNOT_GRANT_CAPABILITIES' });
    expect(await application.execute(base)).toMatchObject({ ok: true, value: { agentDomain: { status: AgentDomainStatus.REVOKED, capabilities: [] } } });
    expect(await application.listAudits(pending.value.userId)).toMatchObject({ ok: true, value: [{ action: AgentDomainAdminAction.REJECT, nextStatus: AgentDomainStatus.REVOKED }] });
  });

  it('supports capability changes, pause, restore, and revocation as audited state transitions', async () => {
    const { application } = setup();
    const pending = await application.createLocalDemoApplication();
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    const issue = async (action: AgentDomainAdminActionRequestDto['action'], requestKey: string, capabilities: AgentDomainAdminActionRequestDto['capabilities'] = []) => application.execute({
      requestKey, userId: pending.value.userId, action, capabilities, reason: `本机演练操作 ${action}`,
    });

    expect(await issue(AgentDomainAdminAction.APPROVE, 'lifecycle-approve-01', [AgentCapabilityCode.DASHBOARD_READ, AgentCapabilityCode.DOWNLINE_READ])).toMatchObject({ ok: true, value: { agentDomain: { status: AgentDomainStatus.ACTIVE } } });
    expect(await issue(AgentDomainAdminAction.UPDATE_CAPABILITIES, 'lifecycle-capability-01', [AgentCapabilityCode.DASHBOARD_READ])).toMatchObject({ ok: true, value: { agentDomain: { status: AgentDomainStatus.ACTIVE, capabilities: [AgentCapabilityCode.DASHBOARD_READ] } } });
    expect(await issue(AgentDomainAdminAction.SUSPEND, 'lifecycle-suspend-01')).toMatchObject({ ok: true, value: { agentDomain: { status: AgentDomainStatus.SUSPENDED, capabilities: [AgentCapabilityCode.DASHBOARD_READ] } } });
    expect(await issue(AgentDomainAdminAction.RESTORE, 'lifecycle-restore-01')).toMatchObject({ ok: true, value: { agentDomain: { status: AgentDomainStatus.ACTIVE, capabilities: [AgentCapabilityCode.DASHBOARD_READ] } } });
    expect(await issue(AgentDomainAdminAction.REVOKE, 'lifecycle-revoke-01')).toMatchObject({ ok: true, value: { agentDomain: { status: AgentDomainStatus.REVOKED, capabilities: [] } } });
    const history = await application.listAudits(pending.value.userId);
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.value.map((audit) => audit.action)).toEqual(expect.arrayContaining([
      AgentDomainAdminAction.APPROVE, AgentDomainAdminAction.UPDATE_CAPABILITIES, AgentDomainAdminAction.SUSPEND,
      AgentDomainAdminAction.RESTORE, AgentDomainAdminAction.REVOKE,
    ]));
    expect(await issue(AgentDomainAdminAction.RESTORE, 'lifecycle-invalid-01')).toMatchObject({ ok: false, code: 'DOMAIN_STATE_CONFLICT' });
  });

  it('replays concurrent commands with the same idempotency key without duplicate audits', async () => {
    const { application } = setup();
    const pending = await application.createLocalDemoApplication();
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    const request: AgentDomainAdminActionRequestDto = {
      requestKey: 'concurrent-review-0001', userId: pending.value.userId, action: AgentDomainAdminAction.APPROVE,
      capabilities: [AgentCapabilityCode.DASHBOARD_READ], reason: '并发请求幂等演练',
    };
    const results = await Promise.all([application.execute(request), application.execute(request)]);
    expect(results[0]).toEqual(results[1]);
    expect(await application.listAudits(pending.value.userId)).toMatchObject({ ok: true, value: [{ requestKey: request.requestKey }] });
  });
});
