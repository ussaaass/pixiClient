import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { GameCatalogIntegrationType, GameCatalogSource, GameCatalogStatus } from '@gameing/contracts/game-catalog';
import { createGameCatalogApplication } from './game-catalog-application';
import { IndexedDbGameCatalogAdapter } from './indexeddb-game-catalog-adapter';

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

describe('game catalog application', () => {
  it('seeds shared lobby references and filters using the shared query DTO', async () => {
    const adapter = makeAdapter();
    const application = createGameCatalogApplication(adapter);
    const all = await application.list({});
    if (!all.ok) throw new Error('Expected the demo catalog');
    expect(all.value.source).toBe(GameCatalogSource.LOCAL_DEMO);
    expect(all.value.items[0]?.gameKey).toBe('slot5');
    expect(all.value.items).toHaveLength(8);
    expect((await application.list({ keyword: 'shisanshui' }))).toMatchObject({ ok: true, value: { items: [{ gameCode: 'shisanshui' }] } });
    expect((await application.list({ status: GameCatalogStatus.MAINTENANCE }))).toMatchObject({ ok: true, value: { items: [] } });
    await adapter.close();
  });

  it('commits an edit and append-only snapshot together, with idempotent replay after reopen', async () => {
    const databaseName = uniqueDatabase();
    const adapter = new IndexedDbGameCatalogAdapter(databaseName);
    const application = createGameCatalogApplication(adapter);
    const initial = await application.list({});
    if (!initial.ok) throw new Error('Expected seeded catalog');
    const current = initial.value.items[0]!;
    const command = { requestKey: 'catalog-edit-test-0001', gameId: current.gameId, name: '跳高高测试', category: current.category, description: current.description, coverAssetId: current.coverAssetId, sortOrder: 15, status: GameCatalogStatus.HIDDEN, reason: '验证目录编辑闭环' };
    expect(await application.update(command)).toMatchObject({ ok: true, value: { name: '跳高高测试', status: GameCatalogStatus.HIDDEN } });
    await adapter.close();

    const reopened = new IndexedDbGameCatalogAdapter(databaseName);
    const reopenedApplication = createGameCatalogApplication(reopened);
    expect(await reopenedApplication.update(command)).toMatchObject({ ok: true, value: { name: '跳高高测试', status: GameCatalogStatus.HIDDEN } });
    expect(await reopenedApplication.listChanges(current.gameId)).toMatchObject({ ok: true, value: [{ previous: { name: current.name }, next: { name: '跳高高测试' }, reason: '验证目录编辑闭环' }] });
    expect(await reopenedApplication.update({ ...command, name: '复用 key 的不同操作' })).toEqual({ ok: false, code: 'REQUEST_KEY_REUSED' });
    await reopened.close();
  });

  it('creates non-playable external stubs and rejects duplicate code or unavailable cover', async () => {
    const adapter = makeAdapter();
    const application = createGameCatalogApplication(adapter);
    const covers = await application.listReadyCoverAssets();
    if (!covers.ok) throw new Error('Expected demo covers');
    const command = { requestKey: 'catalog-stub-test-0001', gameCode: 'partner-game', name: '合作游戏', category: '外接游戏', description: '外部模块接入占位', coverAssetId: covers.value[0]!.assetId, sortOrder: 90, reason: '验证外接 Stub 创建' };
    expect(await application.createExternalStub(command)).toMatchObject({ ok: true, value: { integrationType: GameCatalogIntegrationType.EXTERNAL_STUB, isPlayable: false, clientModuleKey: null } });
    expect(await application.createExternalStub({ ...command, requestKey: 'catalog-stub-test-0002' })).toEqual({ ok: false, code: 'GAME_CODE_TAKEN' });
    expect(await application.createExternalStub({ ...command, requestKey: 'catalog-stub-test-0003', gameCode: 'slot5' })).toEqual({ ok: false, code: 'GAME_KEY_TAKEN' });
    expect(await application.createExternalStub({ ...command, requestKey: 'catalog-stub-test-0004', gameCode: 'another-game', coverAssetId: '999999999999999999' })).toEqual({ ok: false, code: 'COVER_ASSET_NOT_READY' });
    await adapter.close();
  });

  it('rejects malformed DTOs before repository writes', async () => {
    const adapter = makeAdapter();
    const application = createGameCatalogApplication(adapter);
    expect(await application.list({ status: 0 as never })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await application.update({ requestKey: 'short', gameId: '0', name: '', category: '', description: '', coverAssetId: '0', sortOrder: -1, status: 0 as never, reason: '' })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    await adapter.close();
  });
});

function uniqueDatabase(): string {
  const name = `admin-game-catalog-${crypto.randomUUID()}`;
  databaseNames.add(name);
  return name;
}

function makeAdapter(): IndexedDbGameCatalogAdapter {
  return new IndexedDbGameCatalogAdapter(uniqueDatabase());
}
