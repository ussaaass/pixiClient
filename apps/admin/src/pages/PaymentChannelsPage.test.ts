import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App as VueApp } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { PaymentChannelSource, PaymentChannelStatus, PaymentMethod, PaymentProviderType } from '@gameing/contracts/payment-channel';
import PaymentChannelsPage from './PaymentChannelsPage.vue';
import { createPaymentChannelApplication } from '../platform/payment-channels/payment-channel-application';
import { IndexedDbPaymentChannelAdapter } from '../platform/payment-channels/indexeddb-payment-channel-adapter';
import { adminSelectLabel, chooseAdminOption } from '../test-utils/select-option';

describe('PaymentChannelsPage', () => {
  let app: VueApp | undefined;
  let host: HTMLDivElement | undefined;
  let adapter: IndexedDbPaymentChannelAdapter | undefined;
  let databaseName = '';

  afterEach(async () => {
    app?.unmount();
    app = undefined;
    host?.remove();
    host = undefined;
    document.querySelectorAll('.payment-channel-dialog-backdrop,.page-help-backdrop').forEach((node) => node.remove());
    await adapter?.close();
    adapter = undefined;
    if (databaseName) {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error(`Database deletion is blocked: ${databaseName}`));
      });
      databaseName = '';
    }
  });

  it('adds a channel, filters it, changes status/order, and reads the append-only history', async () => {
    databaseName = `admin-payment-channel-page-${crypto.randomUUID()}`;
    adapter = new IndexedDbPaymentChannelAdapter(databaseName);
    const application = createPaymentChannelApplication(adapter);
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/', redirect: '/admin/payments/channels' },
      { path: '/admin/payments/channels', component: PaymentChannelsPage, props: { application } },
      { path: '/admin/payments/mock', component: { template: '<div>Mock console</div>' } },
    ] });
    app = createApp({ template: '<RouterView />' });
    app.use(router);
    host = document.createElement('div');
    document.body.append(host);
    await router.push('/admin/payments/channels');
    app.mount(host);
    await settle();
    await vi.waitFor(() => expect(host?.textContent ?? '').toContain('暂无本机渠道'));

    expect(host.textContent).toContain('LOCAL_DEMO / 仅当前浏览器');
    expect(host.textContent).toContain('暂无本机渠道');
    host.querySelector<HTMLButtonElement>('.payment-channel-empty button')!.click();
    await settle();
    const createDialog = document.querySelector<HTMLElement>('.payment-channel-dialog[aria-labelledby="payment-create-title"]')!;
    setInput(createDialog.querySelector<HTMLInputElement>('.payment-channel-form-grid label:nth-child(1) input')!, 'test-aggregator');
    setInput(createDialog.querySelector<HTMLInputElement>('.payment-channel-form-grid label:nth-child(2) input')!, '演练支付公司');
    setInput(createDialog.querySelector<HTMLInputElement>('.payment-channel-form-grid label:nth-child(5) input')!, '12');
    setInput(createDialog.querySelector<HTMLTextAreaElement>('.payment-channel-reason textarea')!, '本机验证渠道创建流程');
    await chooseAdminOption(createDialog, '.payment-channel-form-grid label:nth-child(3) .el-select', '微信');
    await chooseAdminOption(createDialog, '.payment-channel-form-grid label:nth-child(4) .el-select', '支付代理公司');
    expect(adminSelectLabel(createDialog, '.payment-channel-form-grid label:nth-child(3) .el-select')).toBe('微信');
    await settle();
    createDialog.querySelector<HTMLButtonElement>('.payment-channel-primary')!.click();
    await settle();
    expect(host.textContent).toContain('演练支付公司');
    expect(host.textContent).toContain('微信');
    expect(await adapter.findByProviderMethod('test-aggregator', PaymentMethod.WECHAT)).toMatchObject({ status: PaymentChannelStatus.ACTIVE, source: PaymentChannelSource.LOCAL_DEMO });

    host.querySelector<HTMLButtonElement>('.payment-channel-mobile-card .catalog-row-actions button')!.click();
    await settle();
    const editDialog = document.querySelector<HTMLElement>('.payment-channel-dialog[aria-labelledby="payment-edit-title"]')!;
    await chooseAdminOption(editDialog, '.payment-channel-form-grid label:nth-child(3) .el-select', '已停用');
    setInput(editDialog.querySelector<HTMLInputElement>('.payment-channel-form-grid label:nth-child(2) input')!, '1');
    setInput(editDialog.querySelector<HTMLTextAreaElement>('.payment-channel-reason textarea')!, '暂停渠道并调整本机排序');
    await settle();
    editDialog.querySelector<HTMLButtonElement>('.payment-channel-primary')!.click();
    await settle();
    expect(host.textContent).toContain('已停用');
    host.querySelector<HTMLButtonElement>('.payment-channel-mobile-card .catalog-row-actions button:nth-child(2)')!.click();
    await vi.waitFor(() => expect(document.querySelector('.payment-channel-history-list')?.textContent ?? '').toContain('暂停渠道并调整本机排序'));
  });

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await nextTick();
  }
});

function setInput(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
