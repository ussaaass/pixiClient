import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { resetBrowserDevelopmentDatabase, openBrowserDevelopmentDatabase } from '../database';
import { IndexedDbSocialRepository } from './indexeddb-social-repository';
import { createSocialApplication } from '../../social/social-application';

describe('IndexedDB community workflow', () => {
  afterEach(async () => { await resetBrowserDevelopmentDatabase(); });

  it('persists a post and reply across application recreation and scopes ownership to the active account', async () => {
    const actor = { userId: '8001', displayName: '陈先生' };
    const firstDatabase = await openBrowserDevelopmentDatabase();
    const firstApp = createSocialApplication(new IndexedDbSocialRepository(firstDatabase, () => actor));
    const postResult = await firstApp.createPost({ topicKey: 'SHISANSHUI_STRATEGY', title: '三道如何取舍', body: '先看尾道和中墩的整体关系。' });
    expect(postResult.ok).toBe(true);
    if (!postResult.ok) return;
    const replyResult = await firstApp.createReply(postResult.value.postId, { body: '我会先锁定底墩。' });
    expect(replyResult.ok).toBe(true);

    const secondActor = { userId: '8002', displayName: '另一位玩家' };
    const secondApp = createSocialApplication(new IndexedDbSocialRepository(await openBrowserDevelopmentDatabase(), () => secondActor));
    const feed = await secondApp.listPosts('SHISANSHUI_STRATEGY');
    expect(feed.ok).toBe(true);
    if (!feed.ok) return;
    expect(feed.value).toHaveLength(1);
    expect(feed.value[0]).toMatchObject({ postId: postResult.value.postId, authorLabel: actor.displayName, isOwnPost: false });

    const replies = await secondApp.listReplies(postResult.value.postId);
    expect(replies.ok).toBe(true);
    if (!replies.ok) return;
    expect(replies.value).toHaveLength(1);
    expect(replies.value[0]).toMatchObject({ body: '我会先锁定底墩。', authorLabel: actor.displayName, isOwnReply: false });
  });

  it('requires an active local session before reading or publishing community content', async () => {
    const app = createSocialApplication(new IndexedDbSocialRepository(await openBrowserDevelopmentDatabase()));
    expect(await app.listPosts('SHISANSHUI_STRATEGY')).toEqual({ ok: false, code: 'AUTHENTICATION_REQUIRED' });
    expect(await app.createPost({ topicKey: 'SHISANSHUI_STRATEGY', title: '标题', body: '内容' })).toEqual({ ok: false, code: 'AUTHENTICATION_REQUIRED' });
  });
});
