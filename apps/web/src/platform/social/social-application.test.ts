import { describe, expect, it } from 'vitest';
import { createSocialApplication } from './social-application';
import { OfflineSocialAdapter } from './offline-social-adapter';

describe('social application local demo flow', () => {
  it('loads topic DTOs, creates an authored post, and adds a same-post reply', async () => {
    const app = createSocialApplication(new OfflineSocialAdapter());
    const topics = await app.listTopics();
    expect(topics.ok).toBe(true);
    if (!topics.ok) return;

    const created = await app.createPost({
      topicKey: topics.value[0]!.topicKey,
      title: '  摆牌想法  ',
      body: '  先保证尾道强度，再安排前道。  ',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.title).toBe('摆牌想法');
    expect(created.value.body).toBe('先保证尾道强度，再安排前道。');
    expect(created.value.isOwnPost).toBe(true);
    expect(created.value.assetIds).toEqual([]);

    const reply = await app.createReply(created.value.postId, { body: '  收到，谢谢分享。  ' });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.value.body).toBe('收到，谢谢分享。');
    const replies = await app.listReplies(created.value.postId);
    expect(replies.ok).toBe(true);
    if (!replies.ok) return;
    expect(replies.value).toHaveLength(1);
  });

  it('keeps invalid content recoverable and rejects unknown topics or post IDs', async () => {
    const app = createSocialApplication(new OfflineSocialAdapter());
    expect(await app.createPost({ topicKey: 'UNKNOWN_TOPIC', title: 'title', body: 'body' })).toEqual({ ok: false, code: 'TOPIC_NOT_FOUND' });
    expect(await app.createPost({ topicKey: 'SHISANSHUI_STRATEGY', title: '   ', body: 'body' })).toEqual({ ok: false, code: 'TITLE_REQUIRED' });
    expect(await app.createPost({ topicKey: 'SHISANSHUI_STRATEGY', title: 'title', body: '   ' })).toEqual({ ok: false, code: 'BODY_REQUIRED' });
    expect(await app.createPost({ topicKey: 'SHISANSHUI_STRATEGY', title: 'x'.repeat(81), body: 'body' })).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await app.createReply('9999999999999999999', { body: 'reply' })).toEqual({ ok: false, code: 'POST_NOT_FOUND' });
  });

  it('allows one reply level and rejects a reply to a reply', async () => {
    const app = createSocialApplication(new OfflineSocialAdapter());
    const post = await app.createPost({ topicKey: 'SHISANSHUI_STRATEGY', title: '牌型', body: '尝试讨论。' });
    expect(post.ok).toBe(true);
    if (!post.ok) return;
    const root = await app.createReply(post.value.postId, { body: '第一层回复' });
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    const child = await app.createReply(post.value.postId, { body: '引用第一层', parentReplyId: root.value.replyId });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(await app.createReply(post.value.postId, { body: '不能再嵌套', parentReplyId: child.value.replyId })).toEqual({ ok: false, code: 'REPLY_DEPTH_EXCEEDED' });
  });
});
