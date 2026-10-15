import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App as VueApp } from 'vue';
import { GameCatalogIntegrationType } from '@gameing/contracts/game-catalog';
import GameCatalogPage from './GameCatalogPage.vue';
import { createGameCatalogApplication } from '../platform/game-catalog/game-catalog-application';
import { IndexedDbGameCatalogAdapter } from '../platform/game-catalog/indexeddb-game-catalog-adapter';

describe('GameCatalogPage', () => {
  let app: VueApp | undefined;
  let host: HTMLDivElement | undefined;
  let adapter: IndexedDbGameCatalogAdapter | undefined;

  afterEach(async () => {
    app?.unmount();
    app = undefined;
    host?.remove();
    host = undefined;
    document.querySelectorAll('.catalog-dialog-backdrop,.page-help-backdrop').forEach((element) => element.remove());
    await adapter?.close();
    adapter = undefined;
  });

  it('filters, edits, previews history, and creates a non-playable external stub', async () => {
    host = document.createElement('div');
    document.body.append(host);
    adapter = new IndexedDbGameCatalogAdapter(`admin-game-catalog-page-${crypto.randomUUID()}`);
    app = createApp(GameCatalogPage, { application: createGameCatalogApplication(adapter) });
    app.mount(host);
    await settle();
    await vi.waitFor(() => expect(host?.querySelectorAll('.catalog-mobile-card')).toHaveLength(8));

    expect(host.textContent).toContain('LOCAL_DEMO 游戏目录');
    expect(host.querySelectorAll('.catalog-mobile-card')).toHaveLength(8);
    expect(host.querySelector('.catalog-mobile-card img')?.getAttribute('src')).toContain('localhost:10373/assets/game-icons/');

    const search = host.querySelector<HTMLInputElement>('.game-catalog-filters input[type="search"]')!;
    search.value = '十三张';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    host.querySelector<HTMLButtonElement>('.game-catalog-filters button[type="submit"]')!.click();
    await settle();
    expect(host.querySelectorAll('.catalog-mobile-card')).toHaveLength(1);
    expect(host.querySelector('.catalog-mobile-card')?.textContent).toContain('十三张');

    host.querySelector<HTMLButtonElement>('.catalog-mobile-card .catalog-row-actions button')!.click();
    await settle();
    const dialog = document.querySelector<HTMLElement>('.catalog-dialog[aria-labelledby="catalog-edit-title"]')!;
    const textInputs = [...dialog.querySelectorAll<HTMLInputElement>('input')];
    textInputs[0]!.value = '十三张·演练';
    textInputs[0]!.dispatchEvent(new Event('input', { bubbles: true }));
    const reason = dialog.querySelector<HTMLTextAreaElement>('.catalog-reason-field textarea')!;
    reason.value = '验证本机大厅目录修改';
    reason.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    dialog.querySelector<HTMLButtonElement>('.catalog-save-button')!.click();
    await vi.waitFor(() => expect(host?.querySelector('.game-catalog-result')?.textContent ?? '').toContain('十三张·演练'));

    host.querySelector<HTMLButtonElement>('.catalog-mobile-card .catalog-row-actions button:last-child')!.click();
    await vi.waitFor(() => expect(document.querySelector('.catalog-history-list')?.textContent ?? '').toContain('验证本机大厅目录修改'));
    document.querySelector<HTMLButtonElement>('.catalog-history-dialog footer button')!.click();
    await settle();

    host.querySelector<HTMLButtonElement>('.catalog-create-button')!.click();
    await settle();
    const createDialog = document.querySelector<HTMLElement>('.catalog-dialog[aria-labelledby="catalog-create-title"]')!;
    const fields = [...createDialog.querySelectorAll<HTMLInputElement>('input')];
    fields[0]!.value = 'external-table-game';
    fields[0]!.dispatchEvent(new Event('input', { bubbles: true }));
    fields[1]!.value = '外接牌桌';
    fields[1]!.dispatchEvent(new Event('input', { bubbles: true }));
    const createReason = createDialog.querySelector<HTMLTextAreaElement>('.catalog-reason-field textarea')!;
    createReason.value = '验证本机外接 Stub';
    createReason.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    createDialog.querySelector<HTMLButtonElement>('.catalog-save-button')!.click();
    await settle();
    expect(host.textContent).toContain('不会发布到玩家大厅');
    expect(host.textContent).toContain('外接牌桌');
    const stub = await adapter.findGameByCode('external-table-game');
    expect(stub).toMatchObject({ integrationType: GameCatalogIntegrationType.EXTERNAL_STUB, isPlayable: false, clientModuleKey: null });
  });

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await nextTick();
  }
});
