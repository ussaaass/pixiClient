import type { SocialPostDto, SocialPostReplyDto } from '@gameing/contracts/social';
import type { BrowserDevelopmentDatabase, LocalCredential, LocalSocialContent, LocalSocialConversation, LocalSocialFriendship, LocalSocialMessage, LocalUser } from '../database';

export const LOCAL_DEMO_SOCIAL_USERS = [
  { userId: '980000000000000001', displayName: '牌友阿岚', friendCode: 'LAN8Q2M4KC', username: 'demo-lan', bio: '喜欢研究十三张的摆牌思路。' },
  { userId: '980000000000000002', displayName: '山茶同学', friendCode: 'SC7P3W9N2B', username: 'demo-shancha', bio: '记录每次练习的心得，欢迎交流。' },
  { userId: '980000000000000003', displayName: '海风棋友', friendCode: 'HF4K8R6T3D', username: 'demo-haifeng', bio: '喜欢和牌友讨论不同游戏的策略。' },
  { userId: '980000000000000004', displayName: '小满', friendCode: 'XM5C9J2V7A', username: 'demo-xiaoman', bio: '慢慢练习，开心玩游戏。' },
  { userId: '980000000000000005', displayName: '云雀', friendCode: 'YQ3D7L8P5F', username: 'demo-yunque', bio: '欢迎来社区一起聊聊。' },
  { userId: '980000000000000006', displayName: '转账练习号', friendCode: 'ZQ8M4K2D9P', username: 'demo-transfer', bio: '本机金币转账收款样例，不代表真实用户。' },
] as const;

const demoOutcomes = [
  ['shisanshui', '十三张', 240], ['slot-high', '跳高高', 1200], ['shisanshui', '十三张', -80], ['fishing', '捕鱼', 90],
  ['shisanshui', '十三张', 150], ['mahjong-hule', '麻将胡了', -120], ['shisanshui', '十三张', 300], ['slot-high', '跳高高', -200],
  ['shisanshui', '十三张', 180], ['fishing', '捕鱼', -30], ['mahjong-hule', '麻将胡了', 220], ['shisanshui', '十三张', -100],
] as const;

export function localDemoProfileOutcomes(userId: string, now: number): { gameKey: string; gameName: string; netCoins: number; settledAt: string }[] {
  const userOffset = Number(userId.slice(-1)) % demoOutcomes.length;
  return demoOutcomes.map((_, index) => {
    const [gameKey, gameName, netCoins] = demoOutcomes[(index + userOffset) % demoOutcomes.length]!;
    return { gameKey, gameName, netCoins, settledAt: new Date(now - (index + 1) * 21 * 60 * 60 * 1000).toISOString() };
  });
}

const SEED_KEY = 'local-demo-social:seed:v4';
const POST_TYPE = 1 as const;
const REPLY_TYPE = 2 as const;

export async function ensureLocalDemoSocialUsers(database: BrowserDevelopmentDatabase): Promise<void> {
  if (import.meta.env.MODE === 'test') return;
  if (await database.get('settings', SEED_KEY)) return;
  const transaction = database.transaction(['users', 'credentials', 'settings'], 'readwrite');
  const users = transaction.objectStore('users');
  const credentials = transaction.objectStore('credentials');
  const settings = transaction.objectStore('settings');
  for (const demo of LOCAL_DEMO_SOCIAL_USERS) {
    const current = await users.get(demo.userId);
    if (!current) {
      const user: LocalUser = { userId: demo.userId, displayName: demo.displayName, createdAt: '2025-06-15T00:00:00.000Z', bio: demo.bio, roleType: 1, status: 'ACTIVE', authVersion: 1, friendCode: demo.friendCode, isDemoFixture: true };
      await users.add(user);
    } else if (!current.createdAt || !current.bio) {
      await users.put({ ...current, createdAt: current.createdAt ?? '2025-06-15T00:00:00.000Z', bio: current.bio ?? demo.bio });
    }
    const lookupKey = demo.username.toLowerCase();
    if (!await credentials.index('by-lookup').get(lookupKey)) {
      const credential: LocalCredential = { credentialId: demo.userId, userId: demo.userId, kind: 'IDENTIFIER', identifierType: 'USERNAME', lookupKey, displayValue: demo.username, state: 'ACTIVE' };
      await credentials.add(credential);
    }
  }
  await settings.put({ key: SEED_KEY, value: true });
  await transaction.done;
}

export async function ensureLocalDemoCommunity(database: BrowserDevelopmentDatabase, actorUserId: string, actorLabel: string): Promise<void> {
  if (import.meta.env.MODE === 'test') return;
  await ensureLocalDemoSocialUsers(database);
  const seedKey = `${SEED_KEY}:${actorUserId}`;
  if (await database.get('settings', seedKey)) return;
  const now = Date.now();
  const iso = (offsetMs: number): string => new Date(now - offsetMs).toISOString();
  const [lan, shancha, haifeng, xiaoman, yunque] = LOCAL_DEMO_SOCIAL_USERS;
  const demoAuthor = actorLabel || '本机玩家';
  const demoPosts: SocialPostDto[] = [
    { postId: '970000000000000001', topicId: '7101', topicKey: 'SHISANSHUI_STRATEGY', title: '中墩留葫芦，底道还要保顺子吗？', body: '刚练习时遇到中墩葫芦和底道顺子的取舍。大家通常会先看对手可能的牌型，还是优先保证三道不倒？', authorLabel: lan.displayName, authorProfileKey: lan.friendCode, isOwnPost: false, assetIds: [], status: 'PUBLISHED', createdAt: iso(1000 * 60 * 28) },
    { postId: '970000000000000002', topicId: '7102', topicKey: 'GAME_EXPERIENCE', title: '新手练牌记录', body: '今天开始记录每局摆牌后的复盘，发现先找出最强的五张牌，再看头墩和中墩会不会倒道，思路清楚不少。', authorLabel: shancha.displayName, authorProfileKey: shancha.friendCode, isOwnPost: false, assetIds: [], status: 'PUBLISHED', createdAt: iso(1000 * 60 * 60 * 3) },
    { postId: '970000000000000003', topicId: '7103', topicKey: 'HALL_CHAT', title: '希望大厅多一些牌友交流', body: '第一次来逛社区。平时更喜欢看大家分享复盘，也想认识一些同样玩十三张的牌友。', authorLabel: haifeng.displayName, authorProfileKey: haifeng.friendCode, isOwnPost: false, assetIds: [], status: 'PUBLISHED', createdAt: iso(1000 * 60 * 60 * 8) },
    { postId: '970000000000000004', topicId: '7101', topicKey: 'SHISANSHUI_STRATEGY', title: '三张头墩怎么判断取舍？', body: '头墩只有三张时，我会先比较三条和高对子。遇到两对拆牌时，有没有简单的判断方法？', authorLabel: xiaoman.displayName, authorProfileKey: xiaoman.friendCode, isOwnPost: false, assetIds: [], status: 'PUBLISHED', createdAt: iso(1000 * 60 * 60 * 18) },
    { postId: '970000000000000005', topicId: '7102', topicKey: 'GAME_EXPERIENCE', title: '欢迎来社区交流', body: `${demoAuthor}，欢迎使用本地社区演示。帖子、回复和好友操作保存在当前浏览器中。`, authorLabel: yunque.displayName, authorProfileKey: yunque.friendCode, isOwnPost: false, assetIds: [], status: 'PUBLISHED', createdAt: iso(1000 * 60 * 60 * 24) },
  ];
  const demoReplies: SocialPostReplyDto[] = [
    { replyId: '970000000000000101', postId: demoPosts[0]!.postId, body: '我会先检查底墩是否能稳住，再回头看中墩强度，避免为了中墩把底墩拆散。', authorLabel: shancha.displayName, authorProfileKey: shancha.friendCode, isOwnReply: false, assetIds: [], status: 'PUBLISHED', createdAt: iso(1000 * 60 * 18) },
    { replyId: '970000000000000102', postId: demoPosts[0]!.postId, body: '还要记得最后统一核对头≤中≤底。', authorLabel: lan.displayName, authorProfileKey: lan.friendCode, isOwnReply: false, assetIds: [], status: 'PUBLISHED', createdAt: iso(1000 * 60 * 11) },
    { replyId: '970000000000000103', postId: demoPosts[1]!.postId, body: '复盘很有用，记一下自己为什么这么摆，过一阵再看更容易找到习惯问题。', authorLabel: haifeng.displayName, authorProfileKey: haifeng.friendCode, isOwnReply: false, assetIds: [], status: 'PUBLISHED', createdAt: iso(1000 * 60 * 60 * 2) },
  ];
  const content: LocalSocialContent[] = [
    ...demoPosts.map((post) => ({ contentId: post.postId, contentType: POST_TYPE, topicKey: post.topicKey, postId: post.postId, ownerUserId: LOCAL_DEMO_SOCIAL_USERS.find((user) => user.displayName === post.authorLabel)?.userId ?? actorUserId, createdAt: post.createdAt, post })),
    ...demoReplies.map((reply) => ({ contentId: reply.replyId, contentType: REPLY_TYPE, topicKey: demoPosts.find((post) => post.postId === reply.postId)!.topicKey, postId: reply.postId, ownerUserId: reply.authorLabel === lan.displayName ? lan.userId : reply.authorLabel === shancha.displayName ? shancha.userId : haifeng.userId, createdAt: reply.createdAt, reply })),
  ];
  const pair = (left: string, right: string) => ({ lowUserId: BigInt(left) < BigInt(right) ? left : right, highUserId: BigInt(left) < BigInt(right) ? right : left });
  const friendship = (otherId: string, requesterUserId: string, state: LocalSocialFriendship['state']): LocalSocialFriendship => {
    const users = pair(actorUserId, otherId);
    return { ...users, pairKey: `${users.lowUserId}:${users.highUserId}`, requesterUserId, state, updatedAt: iso(1000 * 60 * 60 * 2) };
  };
  const friendships = [
    friendship(lan.userId, actorUserId, 'ACCEPTED'),
    friendship(shancha.userId, shancha.userId, 'PENDING'),
    friendship(haifeng.userId, actorUserId, 'PENDING'),
  ];
  const conversationPair = pair(actorUserId, lan.userId);
  const conversation: LocalSocialConversation = { conversationId: '960000000000000001', pairKey: `${conversationPair.lowUserId}:${conversationPair.highUserId}`, ...conversationPair, updatedAt: iso(1000 * 60 * 12) };
  const strangerPair = pair(actorUserId, xiaoman.userId);
  const strangerConversation: LocalSocialConversation = { conversationId: '960000000000000002', pairKey: `${strangerPair.lowUserId}:${strangerPair.highUserId}`, ...strangerPair, pendingFirstMessageUserId: xiaoman.userId, updatedAt: iso(1000 * 60 * 40) };
  const messages: LocalSocialMessage[] = [
    { messageId: '960000000000000101', conversationId: conversation.conversationId, clientMessageId: '97000000-0000-4000-8000-000000000101', senderUserId: lan.userId, body: '你好，我也在练十三张，欢迎一起交流复盘。', createdAt: iso(1000 * 60 * 45) },
    { messageId: '960000000000000102', conversationId: conversation.conversationId, clientMessageId: '97000000-0000-4000-8000-000000000102', senderUserId: actorUserId, body: '好呀，我最近也在练习头中底的取舍。', createdAt: iso(1000 * 60 * 36) },
    { messageId: '960000000000000103', conversationId: conversation.conversationId, clientMessageId: '97000000-0000-4000-8000-000000000103', senderUserId: lan.userId, body: '可以先从避免倒道开始复盘。', createdAt: iso(1000 * 60 * 12) },
    { messageId: '960000000000000104', conversationId: strangerConversation.conversationId, clientMessageId: '97000000-0000-4000-8000-000000000104', senderUserId: xiaoman.userId, body: '你好，看到你在讨论十三张，想问问你通常怎么判断中墩。', createdAt: iso(1000 * 60 * 40) },
  ];
  const transaction = database.transaction(['social_friendships', 'social_conversations', 'social_messages', 'social_content', 'settings'], 'readwrite');
  const friendshipStore = transaction.objectStore('social_friendships');
  const conversationStore = transaction.objectStore('social_conversations');
  const messageStore = transaction.objectStore('social_messages');
  const contentStore = transaction.objectStore('social_content');
  for (const row of friendships) if (!await friendshipStore.get(row.pairKey)) await friendshipStore.add(row);
  for (const row of [conversation, strangerConversation]) {
    const existing = await conversationStore.get(row.conversationId);
    if (!existing) await conversationStore.add(row);
    else if (row.conversationId === strangerConversation.conversationId && !existing.pendingFirstMessageUserId && !existing.openMessagingDay) {
      const seededIncoming = (await messageStore.getAll()).filter((message) => message.conversationId === row.conversationId);
      if (seededIncoming.length === 1 && seededIncoming[0]?.senderUserId === xiaoman.userId) await conversationStore.put({ ...existing, pendingFirstMessageUserId: xiaoman.userId });
    }
  }
  for (const row of messages) if (!await messageStore.index('by-client-id').get(row.clientMessageId)) await messageStore.add(row);
  for (const row of content) {
    const existing = await contentStore.get(row.contentId);
    if (!existing) await contentStore.add(row);
    else if (existing.post && row.post?.authorProfileKey && !existing.post.authorProfileKey) await contentStore.put({ ...existing, post: { ...existing.post, authorProfileKey: row.post.authorProfileKey } });
    else if (existing.reply && row.reply?.authorProfileKey && !existing.reply.authorProfileKey) await contentStore.put({ ...existing, reply: { ...existing.reply, authorProfileKey: row.reply.authorProfileKey } });
  }
  await transaction.objectStore('settings').put({ key: seedKey, value: true });
  await transaction.done;
}
