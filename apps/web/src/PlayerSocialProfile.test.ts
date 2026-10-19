import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App as VueApp } from 'vue';
import type { SocialFriendsApplication } from './platform/social/friends-application';
import PlayerPublicSocialProfile from './components/PlayerPublicSocialProfile.vue';
import { createSocialApplication } from './platform/social/social-application';
import { openBrowserDevelopmentDatabase, resetBrowserDevelopmentDatabase } from './platform/browser-api/database';
import { IndexedDbSocialRepository } from './platform/browser-api/social/indexeddb-social-repository';

describe('public community profile', () => {
  let app: VueApp | undefined;
  let host: HTMLDivElement;

  afterEach(async () => {
    app?.unmount();
    app = undefined;
    host?.remove();
    await resetBrowserDevelopmentDatabase();
  });

  it('renders per-game recent outcomes and operates profile actions through the application API', async () => {
    const database = await openBrowserDevelopmentDatabase();
    await database.put('users', { userId: '8231', displayName: '陈先生', roleType: 1, status: 'ACTIVE', authVersion: 1, friendCode: 'PROFILE8231', createdAt: '2025-06-10T00:00:00.000Z', bio: '喜欢研究牌型。', isDemoFixture: true });
    await database.put('users', { userId: '8232', displayName: '牌友小林', roleType: 1, status: 'ACTIVE', authVersion: 1, friendCode: 'VIEWER8232', createdAt: '2025-06-10T00:00:00.000Z' });
    const social = createSocialApplication(new IndexedDbSocialRepository(database, () => ({ userId: '8232', displayName: '牌友小林' })));
    const friends = { lookup: vi.fn(async () => [{ userId: '8231', displayName: '陈先生', friendCode: 'PROFILE8231' }]), requestFriend: vi.fn(), acceptFriend: vi.fn(), openConversation: vi.fn() } as unknown as SocialFriendsApplication;
    const onOpenMessages = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(PlayerPublicSocialProfile, { publicProfileKey: 'PROFILE8231', application: social, friendsApplication: friends, onOpenMessages });
    app.mount(host);

    await waitFor(() => host.querySelector('.public-profile-name h1')?.textContent === '陈先生');
    expect(host.textContent).toContain('近 30 天胜率');
    expect(host.textContent).toContain('近 30 天赢取金币');
    expect(host.textContent).toContain('关注');
    expect(host.textContent).toContain('私信');
    expect(host.textContent).toContain('常玩游戏');
    expect(host.textContent).toContain('最近输赢');
    expect(host.textContent).toContain('PROFILE8231');
    expect(host.querySelector('.public-profile-results')).toBeNull();
    expect(host.querySelectorAll('.favorite-recent-results span').length).toBeGreaterThan(0);

    host.querySelector<HTMLButtonElement>('.public-profile-actions button')!.click();
    await waitFor(async () => (await social.getPublicProfile('PROFILE8231')).ok && ((await social.getPublicProfile('PROFILE8231')) as { ok: true; value: { followedByMe: boolean } }).value.followedByMe);
    expect(host.querySelector('.public-profile-actions button')?.textContent).toContain('已关注');
    host.querySelector<HTMLButtonElement>('.public-profile-actions .public-profile-primary')!.click();
    await waitFor(() => onOpenMessages.mock.calls.length === 1);
    expect(friends.openConversation).toHaveBeenCalledWith('8231');
    expect(onOpenMessages).toHaveBeenCalledWith({ userId: '8231', displayName: '陈先生', friendCode: 'PROFILE8231' });

    const copy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    host.querySelector<HTMLButtonElement>('.profile-public-code-copy')!.click();
    await waitFor(() => copy.mock.calls.length === 1);
    expect(copy).toHaveBeenCalledWith('PROFILE8231');
    host.querySelector<HTMLButtonElement>('.profile-qr-trigger')!.click();
    await waitFor(() => Boolean(host.querySelector('.public-profile-qr-dialog img')));
    expect(host.querySelector('.public-profile-qr-dialog img')?.getAttribute('src')).toContain('data:image/svg+xml');
    host.querySelector<HTMLButtonElement>('.public-profile-qr-dialog header button')!.click();
    host.querySelector<HTMLButtonElement>('#profile-posts-tab')!.click();
    await nextTick();
    expect(host.querySelector('#profile-posts-panel')).not.toBeNull();
    expect(host.querySelector('#profile-games-panel')).toBeNull();

    host.querySelector<HTMLButtonElement>('.public-profile-share-trigger')!.click();
    await nextTick();
    expect(host.querySelector('.public-profile-menu')?.textContent).toContain('加好友');
    expect(host.querySelector('.public-profile-menu')?.textContent).not.toContain('私信');
    expect(host.querySelector('.public-profile-menu')?.textContent).toContain('分享');
    expect(host.querySelector('.public-profile-menu')?.textContent).toContain('举报');
    expect(host.querySelector('.public-profile-menu')?.textContent).toContain('拉黑');
    [...host.querySelectorAll<HTMLButtonElement>('.public-profile-menu > button')].find((button) => button.textContent?.trim() === '举报')!.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('.public-profile-report button[type="submit"]')!.click();
    await waitFor(async () => (await social.getPublicProfile('PROFILE8231')).ok && ((await social.getPublicProfile('PROFILE8231')) as { ok: true; value: { reportedByMe: boolean } }).value.reportedByMe);
    expect(host.textContent).toContain('举报已提交');
    host.querySelector<HTMLButtonElement>('.public-profile-share-trigger')!.click();
    await nextTick();
    [...host.querySelectorAll<HTMLButtonElement>('.public-profile-menu > button')].find((button) => button.textContent?.trim() === '拉黑')!.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>('.public-profile-confirm button.danger')!.click();
    await waitFor(async () => (await social.getPublicProfile('PROFILE8231')).ok && ((await social.getPublicProfile('PROFILE8231')) as { ok: true; value: { blockedByMe: boolean } }).value.blockedByMe);
    expect(host.textContent).toContain('你已拉黑该用户');
    await nextTick();
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('UI state did not settle in time');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
