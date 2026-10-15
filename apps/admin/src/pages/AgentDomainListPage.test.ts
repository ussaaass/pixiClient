import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App as VueApp } from 'vue';
import { AgentCapabilityCode, AgentDomainStatus } from '@gameing/contracts/invite-agent';
import AgentDomainListPage from './AgentDomainListPage.vue';
import { createAgentDomainReviewApplication, createLocalAgentDomainDemoApplication } from '../platform/agent-domain-review/agent-domain-review-application';
import { IndexedDbAgentDomainReviewAdapter } from '../platform/agent-domain-review/indexeddb-agent-domain-review-adapter';

describe('AgentDomainListPage', () => {
  let app: VueApp | undefined;
  let host: HTMLDivElement | undefined;
  let adapter: IndexedDbAgentDomainReviewAdapter | undefined;

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await nextTick();
  }

  afterEach(async () => {
    app?.unmount();
    app = undefined;
    host?.remove();
    host = undefined;
    document.querySelector('.page-help-backdrop')?.remove();
    if (adapter) {
      await adapter.close();
      adapter = undefined;
    }
  });

  it('completes local application review, capability grant, status update, and audit viewing', async () => {
    const databaseName = `admin-agent-page-${crypto.randomUUID()}`;
    adapter = new IndexedDbAgentDomainReviewAdapter(databaseName);
    const application = {
      ...createAgentDomainReviewApplication(adapter),
      ...createLocalAgentDomainDemoApplication(adapter),
    };
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(AgentDomainListPage, { application });
    app.mount(host);
    await settle();
    await vi.waitFor(() => expect(host?.querySelector('.agent-domain-empty')?.textContent).toContain('暂无本机演练记录'));

    expect(host.querySelector('.agent-domain-empty')?.textContent).toContain('暂无本机演练记录');
    host.querySelector<HTMLButtonElement>('.agent-domain-demo-button')!.click();
    await settle();
    expect(host.querySelectorAll('.agent-domain-record')).toHaveLength(1);
    expect(host.textContent).toContain('待审核');

    host.querySelector<HTMLButtonElement>('.agent-domain-approve')!.click();
    await settle();
    const permission = document.querySelector<HTMLInputElement>(`.agent-domain-capability-picker input[value="${AgentCapabilityCode.DASHBOARD_READ}"]`)!;
    permission.click();
    const reason = document.querySelector<HTMLTextAreaElement>('.agent-domain-review-reason textarea')!;
    reason.value = '批准本机演练申请';
    reason.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    document.querySelector<HTMLButtonElement>('.agent-domain-review-dialog footer .agent-domain-approve')!.click();
    await settle();

    expect(host.textContent).toContain('本机演练申请已批准');
    await vi.waitFor(() => expect(host?.textContent).toContain('1 项 capability'));
    expect(host.textContent).toContain('运营中');
    expect(host.textContent).toContain('1 项 capability');
    expect(host.querySelector('.agent-domain-audit-list')?.textContent).toContain('批准');
    expect((await application.listDomains())).toMatchObject({ ok: true, value: [{ status: AgentDomainStatus.ACTIVE, capabilities: [AgentCapabilityCode.DASHBOARD_READ] }] });

    const clickAction = async (label: string) => {
      await vi.waitFor(() => expect([...host!.querySelectorAll<HTMLButtonElement>('.agent-domain-record-actions button')].some((button) => button.textContent?.trim() === label)).toBe(true));
      [...host!.querySelectorAll<HTMLButtonElement>('.agent-domain-record-actions button')].find((button) => button.textContent?.trim() === label)!.click();
    };
    const submitAction = async (label: string, reasonText: string, expectedMessage: string) => {
      await clickAction(label);
      await settle();
      const textarea = document.querySelector<HTMLTextAreaElement>('.agent-domain-review-reason textarea')!;
      textarea.value = reasonText;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await nextTick();
      document.querySelector<HTMLButtonElement>('.agent-domain-review-dialog footer .agent-domain-approve')!.click();
      await settle();
      await vi.waitFor(() => expect(host?.textContent).toContain(expectedMessage));
    };
    await submitAction('暂停', '演练暂停代理域', '本机演练代理域已暂停');
    expect(host.textContent).toContain('本机演练代理域已暂停');
    expect(host.textContent).toContain('已暂停');
    await submitAction('恢复', '演练恢复代理域', '本机演练代理域已恢复');
    expect(host.textContent).toContain('本机演练代理域已恢复');
    await submitAction('撤销权限', '演练撤销代理权限', '本机演练代理权限已撤销');
    expect(host.textContent).toContain('本机演练代理权限已撤销');
    expect((await application.listDomains())).toMatchObject({ ok: true, value: [{ status: AgentDomainStatus.REVOKED, capabilities: [] }] });
  });
});
