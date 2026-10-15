import { describe, expect, it } from 'vitest';
import { createSystemConfigApplication } from './system-config-application';
import { OfflineSystemConfigAdapter } from './offline-system-config-adapter';

function setup() {
  const adapter = new OfflineSystemConfigAdapter();
  return { adapter, application: createSystemConfigApplication(adapter) };
}

describe('system config local draft use cases', () => {
  it('lists typed requirement references and applies optional filters', async () => {
    const { application } = setup();
    const all = await application.listEntries({});
    const filtered = await application.listEntries({ keyword: 'withdrawal', configType: 'INTEGER' });
    expect(all.ok && all.value).toHaveLength(9);
    expect(filtered.ok && filtered.value.map(({ configKey }) => configKey)).toEqual(['minimum_withdrawal_coins']);
  });

  it('previews without persistence and saves only a local draft after validation', async () => {
    const { adapter, application } = setup();
    const request = { requestKey: 'request-001', configKey: 'new_user_gift_coins', proposedValue: '1200', reason: '调整活动赠币' };
    const preview = await application.previewDraft(request);
    expect(preview.ok).toBe(true);
    expect(await adapter.listDrafts()).toEqual([]);
    const saved = await application.createDraft(request);
    expect(saved.ok && saved.value.proposedValue).toBe('1200');
    expect((await adapter.findEntry('new_user_gift_coins'))?.referenceValue).toBe('1000');
  });

  it('rejects malformed values, missing reasons, unchanged values, and unknown keys', async () => {
    const { application } = setup();
    const base = { requestKey: 'request-002', configKey: 'withdrawal_fee_rate_percent', proposedValue: '5', reason: '更新费率' };
    expect(await application.previewDraft({ ...base, proposedValue: '101' })).toMatchObject({ ok: false, code: 'INVALID_VALUE' });
    expect(await application.previewDraft({ ...base, proposedValue: '6', reason: '   ' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(await application.previewDraft(base)).toMatchObject({ ok: false, code: 'VALUE_UNCHANGED' });
    expect(await application.previewDraft({ ...base, configKey: 'unknown_config' })).toMatchObject({ ok: false, code: 'CONFIG_NOT_FOUND' });
    expect(await application.previewDraft({ ...base, configKey: 'cny_to_coin_ratio', proposedValue: '1:0' })).toMatchObject({ ok: false, code: 'INVALID_VALUE' });
  });

  it('replays identical request keys idempotently and rejects reuse with different content', async () => {
    const { application } = setup();
    const request = { requestKey: 'request-003', configKey: 'new_user_gift_coins', proposedValue: '1500', reason: '阶段活动赠币' };
    const first = await application.createDraft(request);
    const replay = await application.createDraft(request);
    const conflict = await application.createDraft({ ...request, proposedValue: '1600' });
    expect(replay).toEqual(first);
    expect(conflict).toMatchObject({ ok: false, code: 'REQUEST_KEY_REUSED' });
  });

  it('discards a draft and its idempotency record', async () => {
    const { application } = setup();
    const request = { requestKey: 'request-004', configKey: 'new_user_gift_coins', proposedValue: '1300', reason: '节日赠币调整' };
    await application.createDraft(request);
    expect(await application.discardDraft(request.configKey)).toMatchObject({ ok: true });
    const drafts = await application.listDrafts();
    expect(drafts).toEqual({ ok: true, value: [] });
    expect(await application.createDraft({ ...request, proposedValue: '1400' })).toMatchObject({ ok: true });
  });
});
