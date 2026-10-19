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
    await firstDatabase.put('users', { ...actor, roleType: 1, status: 'ACTIVE', authVersion: 1, friendCode: 'CHENUSER8101', createdAt: '2025-01-01T00:00:00.000Z' });
    await firstDatabase.put('users', { userId: '8002', displayName: '另一位玩家', roleType: 1, status: 'ACTIVE', authVersion: 1, friendCode: 'OTHERUSER82', createdAt: '2025-01-01T00:00:00.000Z' });
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

  it('persists dislike and author follow actions across application recreation', async () => {
    const actor = { userId: '8101', displayName: '陈先生' };
    const author = { userId: '8102', displayName: '另一位玩家' };
    const database = await openBrowserDevelopmentDatabase();
    await database.put('users', { ...actor, roleType: 1, status: 'ACTIVE', authVersion: 1, friendCode: 'ACTORUSER01', createdAt: '2025-01-01T00:00:00.000Z' });
    await database.put('users', { ...author, roleType: 1, status: 'ACTIVE', authVersion: 1, friendCode: 'AUTHORUSER2', createdAt: '2025-01-01T00:00:00.000Z' });
    const authorApp = createSocialApplication(new IndexedDbSocialRepository(database, () => author));
    const created = await authorApp.createPost({ topicKey: 'SHISANSHUI_STRATEGY', title: '互动状态验收', body: '检查不喜欢与关注作者状态。' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const app = createSocialApplication(new IndexedDbSocialRepository(database, () => actor));
    expect(await app.applyContentAction({ resourceType: 'POST', resourceId: created.value.postId, action: 'DISLIKE' })).toMatchObject({ ok: true, value: { disliked: true } });
    expect(await app.applyContentAction({ resourceType: 'POST', resourceId: created.value.postId, action: 'FOLLOW_AUTHOR' })).toMatchObject({ ok: true, value: { followingAuthor: true } });

    const restored = createSocialApplication(new IndexedDbSocialRepository(await openBrowserDevelopmentDatabase(), () => ({ userId: '8103', displayName: '另一位玩家' })));
    expect(await restored.contentActionState('POST', created.value.postId)).toMatchObject({ ok: true, value: { disliked: false, followingAuthor: false, reported: false } });
    expect(await app.contentActionState('POST', created.value.postId)).toMatchObject({ ok: true, value: { disliked: true, followingAuthor: true } });
  });

  it('loads per-game recent outcomes, lists public posts, and persists user report and block actions', async () => {
    const database = await openBrowserDevelopmentDatabase();
    const author = { userId: '8131', displayName: '陈先生' };
    const viewer = { userId: '8132', displayName: '牌友小林' };
    await database.put('users', { ...author, roleType: 1, status: 'ACTIVE', authVersion: 1, friendCode: 'PROFILE8131', createdAt: '2025-06-10T00:00:00.000Z', bio: '喜欢研究牌型。', isDemoFixture: true });
    await database.put('users', { ...viewer, roleType: 1, status: 'ACTIVE', authVersion: 1, friendCode: 'VIEWER8132', createdAt: '2025-06-10T00:00:00.000Z' });
    const authorApp = createSocialApplication(new IndexedDbSocialRepository(database, () => author));
    const post = await authorApp.createPost({ topicKey: 'SHISANSHUI_STRATEGY', title: '公开主页帖子', body: '主页应展示这条内容。' });
    expect(post.ok).toBe(true);
    if (!post.ok) return;
    expect(post.value.authorProfileKey).toBe('PROFILE8131');

    const viewerApp = createSocialApplication(new IndexedDbSocialRepository(database, () => viewer));
    const profile = await viewerApp.getPublicProfile('PROFILE8131');
    expect(profile).toMatchObject({ ok: true, value: { displayName: '陈先生', publicCode: 'PROFILE8131', joinedMonth: '2025-06', recentWonCoins: expect.stringMatching(/^[1-9][0-9]*$/), recentWinRate: { periodDays: 30 }, favoriteGames: expect.arrayContaining([expect.objectContaining({ recentResults: expect.arrayContaining([expect.objectContaining({ result: 'WIN' })]) })]), completedCoinMarketTradeCount: 7, isSelf: false, followedByMe: false, blockedByMe: false, reportedByMe: false } });
    expect(await viewerApp.setFollowAuthor('PROFILE8131', true)).toEqual({ ok: true, value: true });
    expect(await viewerApp.getPublicProfile('PROFILE8131')).toMatchObject({ ok: true, value: { followedByMe: true } });
    if (!profile.ok) return;
    const posts = await viewerApp.listPublicProfilePosts('PROFILE8131');
    expect(posts).toMatchObject({ ok: true, value: { items: [{ postId: post.value.postId, authorProfileKey: 'PROFILE8131' }], nextCursor: null } });
    expect(await viewerApp.reportAuthor({ publicProfileKey: 'PROFILE8131', reasonCode: 'SPAM', details: '测试举报' })).toMatchObject({ ok: true, value: true });
    expect(await viewerApp.getPublicProfile('PROFILE8131')).toMatchObject({ ok: true, value: { reportedByMe: true } });
    expect(await viewerApp.setBlockAuthor('PROFILE8131', true)).toEqual({ ok: true, value: true });
    expect(await viewerApp.getPublicProfile('PROFILE8131')).toMatchObject({ ok: true, value: { blockedByMe: true } });
    expect(await viewerApp.listPublicProfilePosts('PROFILE8131')).toMatchObject({ ok: true, value: { items: [] } });
    expect(await viewerApp.setBlockAuthor('PROFILE8131', false)).toEqual({ ok: true, value: false });
  });
});
