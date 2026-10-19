import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';
import type { InviteAgentApplication } from '../platform/invite-agent/invite-agent-application';
import PlayerInviteAgentWorkspace from './PlayerInviteAgentWorkspace.vue';

describe('PlayerInviteAgentWorkspace', () => {
  let app: ReturnType<typeof createApp> | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    app?.unmount();
    host?.remove();
    app = undefined;
    host = undefined;
  });

  it('shows confirmed invitees and switches to reward history', async () => {
    host = document.createElement('div');
    document.body.append(host);
    const application = {
      getInviteLink: async () => null,
      issueInviteLink: async () => ({ inviteCode: 'ABCD2345', url: 'https://example.test/?inviteCode=ABCD2345', expiresAt: '2028-10-16T00:00:00.000Z' }),
      listInvitees: async () => ({ items: [{ userLabel: '玩家 1234', boundAt: '2026-10-15T12:00:00.000Z', rewardCnyFen: '0' }], totalCount: '1', nextCursor: null }),
      listRewards: async () => ({ items: [{ rewardId: '25', sourceUserLabel: '玩家 1234', paidAt: '2026-10-15T12:00:00.000Z', paidAmountCnyFen: '10000', rateBps: 1000, rewardCnyFen: '1000', state: 'FROZEN' as const, releaseAt: '2026-10-17T12:00:00.000Z' }], rewardType: 1 as const, totalRewardCnyFen: '1000', frozenRewardCnyFen: '1000', availableRewardCnyFen: '0', nextCursor: null }),
      getAgentDomain: async () => null,
      applyAgentDomain: async () => { throw new Error('unused'); },
      withdrawAgentDomain: async () => ({ withdrawn: true }),
    } satisfies InviteAgentApplication;
    app = createApp(PlayerInviteAgentWorkspace, { application, authenticated: true });
    app.mount(host);
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).toContain('玩家 1234');
    expect(host.textContent).toContain('直属邀请');
    host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="false"]')!.click();
    await nextTick();
    expect(host.textContent).toContain('冻结至');
    expect(host.textContent).toContain('+¥10.00');
  });
});
