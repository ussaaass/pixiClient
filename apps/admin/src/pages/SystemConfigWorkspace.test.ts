import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick, type App as VueApp } from 'vue';
import SystemConfigWorkspace from './SystemConfigWorkspace.vue';
import { createSystemConfigApplication } from '../platform/system-config/system-config-application';
import { OfflineSystemConfigAdapter } from '../platform/system-config/offline-system-config-adapter';

describe('SystemConfigWorkspace', () => {
  let app: VueApp | undefined;
  let host: HTMLDivElement;

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }

  afterEach(() => {
    app?.unmount();
    app = undefined;
    host?.remove();
    document.querySelector('.page-help-backdrop')?.remove();
  });

  it('edits, previews, saves, filters, and discards an explicitly local draft', async () => {
    host = document.createElement('div');
    document.body.append(host);
    const adapter = new OfflineSystemConfigAdapter();
    const application = createSystemConfigApplication(adapter);
    app = createApp(SystemConfigWorkspace, { application });
    app.mount(host);
    await settle();

    expect(host.querySelectorAll('.system-config-row')).toHaveLength(9);
    expect(host.textContent).toContain('本机持久化草稿');
    const targetRow = [...host.querySelectorAll<HTMLElement>('.system-config-row')].find((row) => row.textContent?.includes('新用户赠币'))!;
    targetRow.querySelector<HTMLButtonElement>('.system-config-row-actions button')!.click();
    await settle();
    const value = document.querySelector<HTMLInputElement>('.system-config-editor-form input')!;
    const reason = document.querySelector<HTMLTextAreaElement>('#config-reason')!;
    value.value = '1200';
    value.dispatchEvent(new Event('input', { bubbles: true }));
    reason.value = '调整活动赠币';
    reason.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    document.querySelector<HTMLButtonElement>('.system-config-primary[type="submit"]')!.click();
    await settle();
    expect(document.querySelector('.system-config-confirmation')?.textContent).toContain('1200');
    document.querySelector<HTMLButtonElement>('.system-config-confirmation .system-config-primary')!.click();
    await settle();

    expect(host.querySelector('.system-config-result')?.textContent).toContain('本机持久化草稿已保存');
    const savedRow = [...host.querySelectorAll<HTMLElement>('.system-config-row')].find((row) => row.textContent?.includes('新用户赠币'))!;
    expect(savedRow.textContent).toContain('1000');
    expect(savedRow.textContent).toContain('1200');
    expect((await adapter.listDrafts())).toHaveLength(1);

    const keyword = host.querySelector<HTMLInputElement>('.system-config-filters input')!;
    keyword.value = 'does_not_exist';
    keyword.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(host.querySelectorAll('.system-config-row')).toHaveLength(0);
    expect(host.querySelector('.system-config-empty')?.textContent).toContain('没有匹配的配置项');
    host.querySelector<HTMLButtonElement>('.system-config-empty button')!.click();
    await settle();
    expect(host.querySelectorAll('.system-config-row')).toHaveLength(9);

    const updatedRow = [...host.querySelectorAll<HTMLElement>('.system-config-row')].find((row) => row.textContent?.includes('新用户赠币'))!;
    updatedRow.querySelector<HTMLButtonElement>('.system-config-discard')!.click();
    await settle();
    expect(await adapter.listDrafts()).toEqual([]);
  });

  it('shows validation feedback and leaves the reference unchanged for invalid input', async () => {
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(SystemConfigWorkspace, { application: createSystemConfigApplication(new OfflineSystemConfigAdapter()) });
    app.mount(host);
    await settle();
    const row = [...host.querySelectorAll<HTMLElement>('.system-config-row')].find((item) => item.textContent?.includes('提现手续费率'))!;
    row.querySelector<HTMLButtonElement>('.system-config-row-actions button')!.click();
    await settle();
    const value = document.querySelector<HTMLInputElement>('.system-config-editor-form input')!;
    const reason = document.querySelector<HTMLTextAreaElement>('#config-reason')!;
    value.value = '101';
    value.dispatchEvent(new Event('input', { bubbles: true }));
    reason.value = '测试无效费率';
    reason.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    document.querySelector<HTMLButtonElement>('.system-config-primary[type="submit"]')!.click();
    await settle();
    expect(document.querySelector('.system-config-editor-form [role="alert"]')?.textContent).toContain('数值格式');
    expect(await (createSystemConfigApplication(new OfflineSystemConfigAdapter())).listDrafts()).toMatchObject({ ok: true, value: [] });
  });
});
