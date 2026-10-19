import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue';
import PlayerPrimaryNavigation from './components/PlayerPrimaryNavigation.vue';
import type { PlayerPrimaryDestination } from './components/PlayerPrimaryNavigation.vue';

describe('primary navigation message badge', () => {
  let app: VueApp | undefined;
  let host: HTMLDivElement;

  afterEach(() => { app?.unmount(); app = undefined; host?.remove(); });

  it('shows a count badge and an accessible pending-action label on the message destination', async () => {
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(PlayerPrimaryNavigation, { active: 'lobby', messageBadgeCount: 4 });
    app.mount(host);
    await nextTick();
    const button = [...host.querySelectorAll<HTMLButtonElement>('.dock-item')].find((item) => item.textContent?.includes('消息'));
    expect(button?.querySelector('.dock-message-badge')?.textContent).toBe('4');
    expect(button?.getAttribute('aria-label')).toBe('消息，有 4 项待处理');
  });

  it('caps a large badge count at 99+', async () => {
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(PlayerPrimaryNavigation, { active: 'lobby', messageBadgeCount: 120 });
    app.mount(host);
    await nextTick();
    const badge = host.querySelector('.dock-message-badge');
    expect(badge?.textContent).toBe('99+');
  });

  it('shows the new-post count on the community destination', async () => {
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(PlayerPrimaryNavigation, { active: 'lobby', socialBadgeCount: 3 });
    app.mount(host);
    await nextTick();
    const button = [...host.querySelectorAll<HTMLButtonElement>('.dock-item')].find((item) => item.textContent?.includes('社区'));
    expect(button?.querySelector('.dock-social-badge')?.textContent).toBe('3');
    expect(button?.getAttribute('aria-label')).toBe('社区，有 3 条新帖子');
  });

  it('keeps the same dock and buttons mounted while the active destination changes', async () => {
    const Root = defineComponent({
      setup() {
        const active = ref<PlayerPrimaryDestination>('lobby');
        return () => h(PlayerPrimaryNavigation, {
          active: active.value,
          onNavigate: (destination: PlayerPrimaryDestination) => { active.value = destination; },
        });
      },
    });
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(Root);
    app.mount(host);
    await nextTick();
    const navBefore = host.querySelector('.player-primary-nav');
    const walletBefore = [...host.querySelectorAll<HTMLButtonElement>('.dock-item')].find((item) => item.textContent?.includes('钱包'));
    walletBefore?.click();
    await nextTick();
    await nextTick();
    expect(host.querySelector('.player-primary-nav')).toBe(navBefore);
    expect([...host.querySelectorAll('.dock-item')].find((item) => item.textContent?.includes('钱包'))).toBe(walletBefore);
    expect(walletBefore?.getAttribute('aria-current')).toBe('page');
  });
});
