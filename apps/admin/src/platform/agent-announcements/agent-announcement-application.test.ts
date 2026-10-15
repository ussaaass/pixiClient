import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentAnnouncementStatus } from '@gameing/contracts/agent-announcements';
import { AgentCapabilityCode } from '@gameing/contracts/invite-agent';
import { createAgentAnnouncementApplication } from './agent-announcement-application';
import { IndexedDbAgentAnnouncementAdapter } from './indexeddb-agent-announcement-adapter';
import { openAdminDevelopmentDatabase } from '../browser-development-database';

const epoch = new Date('2026-10-15T12:00:00.000Z');
const sampleKey = () => crypto.randomUUID();
let testDatabaseName = '';

beforeEach(() => { testDatabaseName = `agent-announcement-test-${crypto.randomUUID()}`; });

afterEach(async () => {
  const db = await openAdminDevelopmentDatabase(testDatabaseName);
  db.close();
  indexedDB.deleteDatabase(testDatabaseName);
});

describe('Agent announcement offline workflow', () => {
  it('creates a draft, schedules publication, expires, retracts and records immutable operation audit', async () => {
    const adapter = new IndexedDbAgentAnnouncementAdapter(undefined, testDatabaseName);
    const app = createAgentAnnouncementApplication(adapter, localScope(), () => new Date(epoch));
    const createRequest = { title: '本域游戏规则提醒', body: '请在进入游戏前查看本档位规则说明。', reason: '补充大厅规则入口提示', requestKey: sampleKey() };
    const created = await app.create(createRequest);
    expect(created).toMatchObject({ ok: true, value: { status: AgentAnnouncementStatus.DRAFT, agentDomainId: '92001', source: 'LOCAL_DEMO' } });
    if (!created.ok) return;

    const start = new Date(epoch.getTime() + 60 * 60 * 1000).toISOString();
    const end = new Date(epoch.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const publishRequest = { announcementId: created.value.announcementId, startsAt: start, expiresAt: end, reason: '按运营排期发布', requestKey: sampleKey() };
    expect(await app.publish(publishRequest)).toMatchObject({ ok: true, value: { status: AgentAnnouncementStatus.SCHEDULED } });
    expect(await app.publish(publishRequest)).toMatchObject({ ok: true, value: { status: AgentAnnouncementStatus.SCHEDULED } });
    expect(await app.publish({ ...publishRequest, reason: '复用键但改命令' })).toEqual({ ok: false, code: 'REQUEST_KEY_REUSED' });
    expect((await app.list({})).ok && (await app.list({})).ok).toBe(true);

    const wrongDomain = createAgentAnnouncementApplication(adapter, localScope('92002'), () => new Date(epoch));
    expect(await wrongDomain.retract({ announcementId: created.value.announcementId, reason: '越域测试', requestKey: sampleKey() })).toEqual({ ok: false, code: 'NOT_FOUND' });

    const database = await openAdminDevelopmentDatabase(testDatabaseName);
    const audits = await database.getAll('agent_audit_events');
    expect(audits.filter((audit) => audit.resourceKey === created.value.announcementId).map((audit) => audit.actionCode)).toEqual(['ANNOUNCEMENT_CREATE', 'ANNOUNCEMENT_PUBLISH']);
    database.close();

    const expiredApp = createAgentAnnouncementApplication(adapter, localScope(), () => new Date('2026-10-15T15:00:00.000Z'));
    expect(await expiredApp.list({ status: AgentAnnouncementStatus.EXPIRED })).toMatchObject({ ok: true, value: { items: [{ status: AgentAnnouncementStatus.EXPIRED }] } });
    expect(await expiredApp.retract({ announcementId: created.value.announcementId, reason: '不能撤回已结束公告', requestKey: sampleKey() })).toEqual({ ok: false, code: 'INVALID_STATE' });
    adapter.close();
  });

  it('rejects deceptive copy, unsafe markup, invalid schedule and missing capability', async () => {
    const adapter = new IndexedDbAgentAnnouncementAdapter(undefined, testDatabaseName);
    const app = createAgentAnnouncementApplication(adapter, localScope(), () => new Date(epoch));
    expect(await app.create({ title: '概率提高', body: '赔率大幅增加，快来参与', reason: '运营通知', requestKey: sampleKey() })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await app.create({ title: '欢迎', body: '<b>点这里</b> https://example.com', reason: '运营通知', requestKey: sampleKey() })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    const created = await app.create({ title: '本域公告', body: '请查看游戏规则。', reason: '运营通知', requestKey: sampleKey() });
    if (!created.ok) throw new Error('expected a local draft');
    expect(await app.publish({ announcementId: created.value.announcementId, startsAt: new Date(epoch.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(), expiresAt: new Date(epoch.getTime() + 1).toISOString(), reason: '超出排期范围', requestKey: sampleKey() })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await createAgentAnnouncementApplication(adapter, localScope('92001', 'no-capability')).list({})).toEqual({ ok: false, code: 'SCOPE_UNAVAILABLE' });
    adapter.close();
  });
});

function localScope(domain = '92001', capability: string = AgentCapabilityCode.ANNOUNCEMENT_MANAGE) {
  return { resolve(requested: string) { return requested === AgentCapabilityCode.ANNOUNCEMENT_MANAGE && capability === AgentCapabilityCode.ANNOUNCEMENT_MANAGE ? { agentDomainId: domain, agentUserId: '92000' } : null; } };
}
