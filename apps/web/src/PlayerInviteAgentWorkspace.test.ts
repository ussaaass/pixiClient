import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App as VueApp } from 'vue';
import { AgentDomainStatus, type AgentDomainDto, type InviteLinkDto } from '@gameing/contracts/invite-agent';
import PlayerInviteAgentWorkspace from './components/PlayerInviteAgentWorkspace.vue';
import type { InviteAgentApplication } from './platform/invite-agent/invite-agent-application';

describe('player invitation and agent application workspace', () => {
  let host: HTMLDivElement;
  let app: VueApp | undefined;

  afterEach(() => {
    app?.unmount();
    app = undefined;
    host.remove();
    vi.restoreAllMocks();
  });

  it('guides signed-out players to account entry without loading private data', async () => {
    host = document.createElement('div');
    document.body.append(host);
    const application = {
      getInviteLink: vi.fn(),
      issueInviteLink: vi.fn(),
      getAgentDomain: vi.fn(),
      applyAgentDomain: vi.fn(),
      withdrawAgentDomain: vi.fn(),
    } as unknown as InviteAgentApplication;
    app = createApp(PlayerInviteAgentWorkspace, { application, authenticated: false });
    app.mount(host);
    await nextTick();

    expect(host.textContent).toContain('登录后管理邀请与代理申请');
    expect(application.getInviteLink).not.toHaveBeenCalled();
    expect(application.getAgentDomain).not.toHaveBeenCalled();
  });

  it('issues a two-year link and completes pending application, withdrawal, and resubmission', async () => {
    host = document.createElement('div');
    document.body.append(host);
    const link: InviteLinkDto = {
      inviteCode: 'ABCD2345EF',
      url: 'http://localhost:10373/?inviteCode=ABCD2345EF',
      expiresAt: new Date(Date.now() + 730 * 24 * 60 * 60 * 1000).toISOString(),
    };
    let domain: AgentDomainDto | null = null;
    const applyAgentDomain = vi.fn(async () => {
      domain = { userId: '7001', status: AgentDomainStatus.PENDING_REVIEW, appliedAt: new Date().toISOString(), capabilities: [] };
      return domain;
    });
    const application: InviteAgentApplication = {
      getInviteLink: vi.fn(async () => null),
      issueInviteLink: vi.fn(async () => link),
      getAgentDomain: vi.fn(async () => domain),
      applyAgentDomain,
      withdrawAgentDomain: vi.fn(async () => {
        if (domain) domain = { ...domain, status: AgentDomainStatus.WITHDRAWN };
        return { withdrawn: true };
      }),
    };
    app = createApp(PlayerInviteAgentWorkspace, { application, authenticated: true });
    app.mount(host);
    await waitFor(() => [...host.querySelectorAll<HTMLButtonElement>('.player-invite-card button')].some((button) => button.textContent === '生成链接' && !button.disabled));

    [...host.querySelectorAll<HTMLButtonElement>('.player-invite-card button')].find((button) => button.textContent === '生成链接')!.click();
    await waitFor(() => host.querySelector('.player-invite-url input') !== null);
    expect(host.querySelector<HTMLInputElement>('.player-invite-url input')?.value).toBe(link.url);
    expect(application.issueInviteLink).toHaveBeenCalledTimes(1);

    const applyButton = [...host.querySelectorAll<HTMLButtonElement>('.player-invite-card button')].find((button) => button.textContent === '提交申请')!;
    applyButton.click();
    await waitFor(() => host.textContent?.includes('审核中') === true);
    expect(host.textContent).toContain('申请已提交，平台审核完成前账号仍保持普通玩家权限。');

    [...host.querySelectorAll<HTMLButtonElement>('.player-invite-card button')].find((button) => button.textContent === '撤回申请')!.click();
    await waitFor(() => host.textContent?.includes('已撤回，可重新申请') === true);
    expect(host.querySelectorAll('.player-invite-card button').length).toBeGreaterThan(1);
    [...host.querySelectorAll<HTMLButtonElement>('.player-invite-card button')].find((button) => button.textContent === '再次申请')!.click();
    await waitFor(() => applyAgentDomain.mock.calls.length === 2 && host.textContent?.includes('审核中') === true);
    expect(host.textContent).toContain('平台审核完成前账号仍保持普通玩家权限。');
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Invitation workspace did not settle in time');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
