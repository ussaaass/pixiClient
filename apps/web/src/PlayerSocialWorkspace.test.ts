import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick, type App as VueApp } from 'vue';
import PlayerSocialWorkspace from './components/PlayerSocialWorkspace.vue';
import { createSocialApplication } from './platform/social/social-application';
import { OfflineSocialAdapter } from './platform/social/offline-social-adapter';

describe('player community topic drafts', () => {
  let host: HTMLDivElement;
  let app: VueApp | undefined;

  afterEach(() => {
    app?.unmount();
    app = undefined;
    host.remove();
  });

  it('keeps unsent text with its topic and clears only after cancel or successful publication', async () => {
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(PlayerSocialWorkspace, { application: createSocialApplication(new OfflineSocialAdapter()) });
    app.mount(host);
    await waitFor(() => host.querySelectorAll('.social-topic-picker button').length === 3);

    const topicButtons = host.querySelectorAll<HTMLButtonElement>('.social-topic-picker button');
    host.querySelector<HTMLButtonElement>('.social-topic-heading button')!.click();
    await nextTick();
    await setField(host.querySelector<HTMLInputElement>('.social-composer input')!, '第一话题草稿');
    await setField(host.querySelector<HTMLTextAreaElement>('.social-composer textarea')!, '这段内容只能留在第一话题。');

    topicButtons[1]!.click();
    await waitFor(() => host.querySelector('.social-topic-heading strong')?.textContent === '游戏心得');
    expect(host.querySelector('.social-composer')).toBeNull();
    host.querySelector<HTMLButtonElement>('.social-topic-heading button')!.click();
    await nextTick();
    expect(host.querySelector<HTMLInputElement>('.social-composer input')?.value).toBe('');
    expect(host.querySelector<HTMLTextAreaElement>('.social-composer textarea')?.value).toBe('');

    await setField(host.querySelector<HTMLInputElement>('.social-composer input')!, '第二话题帖子');
    await setField(host.querySelector<HTMLTextAreaElement>('.social-composer textarea')!, '成功发布后草稿应清空。');
    host.querySelector<HTMLButtonElement>('.social-composer button[type="submit"]')!.click();
    await waitFor(() => host.querySelector('.social-post-card h3')?.textContent === '第二话题帖子');

    topicButtons[0]!.click();
    await waitFor(() => host.querySelector('.social-topic-heading strong')?.textContent === '十三张牌型讨论');
    host.querySelector<HTMLButtonElement>('.social-topic-heading button')!.click();
    await nextTick();
    expect(host.querySelector<HTMLInputElement>('.social-composer input')?.value).toBe('第一话题草稿');
    expect(host.querySelector<HTMLTextAreaElement>('.social-composer textarea')?.value).toBe('这段内容只能留在第一话题。');
    host.querySelector<HTMLButtonElement>('.social-composer button[type="button"]')!.click();

    topicButtons[1]!.click();
    await waitFor(() => host.querySelector('.social-topic-heading strong')?.textContent === '游戏心得');
    host.querySelector<HTMLButtonElement>('.social-topic-heading button')!.click();
    await nextTick();
    expect(host.querySelector<HTMLInputElement>('.social-composer input')?.value).toBe('');
    expect(host.querySelector<HTMLTextAreaElement>('.social-composer textarea')?.value).toBe('');
  });
});

async function setField(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('UI state did not settle in time');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
