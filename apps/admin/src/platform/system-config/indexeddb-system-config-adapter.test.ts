import { afterEach, describe, expect, it } from 'vitest';
import { createSystemConfigApplication } from './system-config-application';
import { IndexedDbSystemConfigAdapter } from './indexeddb-system-config-adapter';

const databaseNames = new Set<string>();

afterEach(async () => {
  await Promise.all([...databaseNames].map((databaseName) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Database deletion is blocked: ${databaseName}`));
  })));
  databaseNames.clear();
});

describe('IndexedDbSystemConfigAdapter', () => {
  it('retains validated drafts across adapter recreation and allows later discard', async () => {
    const databaseName = `admin-system-config-${crypto.randomUUID()}`;
    databaseNames.add(databaseName);
    const firstAdapter = new IndexedDbSystemConfigAdapter(databaseName);
    const firstApplication = createSystemConfigApplication(firstAdapter);
    const request = {
      requestKey: 'config-request-reload-check',
      configKey: 'new_user_gift_coins',
      proposedValue: '1200',
      reason: '离线草稿刷新恢复验证',
    };

    const saved = await firstApplication.createDraft(request);
    expect(saved).toMatchObject({ ok: true, value: { proposedValue: '1200' } });
    await firstAdapter.close();

    const reopenedAdapter = new IndexedDbSystemConfigAdapter(databaseName);
    const reopenedApplication = createSystemConfigApplication(reopenedAdapter);
    expect(await reopenedApplication.listDrafts()).toMatchObject({ ok: true, value: [{ proposedValue: '1200', configKey: 'new_user_gift_coins' }] });
    expect(await reopenedAdapter.findDraftByRequestKey(request.requestKey)).toMatchObject({ proposedValue: '1200' });
    expect(await reopenedAdapter.findEntry('new_user_gift_coins')).toMatchObject({ referenceValue: '1000' });

    expect(await reopenedApplication.discardDraft(request.configKey)).toMatchObject({ ok: true });
    expect(await reopenedApplication.listDrafts()).toEqual({ ok: true, value: [] });
    await reopenedAdapter.close();
  });
});
