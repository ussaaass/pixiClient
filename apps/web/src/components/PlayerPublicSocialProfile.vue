<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { SocialPublicProfileDto, SocialPostDto } from '@gameing/contracts/social';
import type { SocialAuthorReportRequestDto } from '@gameing/contracts/social';
import type { SocialApplication } from '../platform/social/social-application';
import type { SocialFriendsApplication } from '../platform/social/friends-application';
import PlayerSocialShareCard, { type SocialShareCardData } from './PlayerSocialShareCard.vue';
import PlayerAppSelect from './PlayerAppSelect.vue';

const props = defineProps<{ publicProfileKey: string; application: SocialApplication; friendsApplication: SocialFriendsApplication }>();
const emit = defineEmits<{ back: []; openPost: [postId: string]; openMessages: [peer: { userId: string; displayName: string; friendCode: string; conversationId: string }] }>();
const profile = ref<SocialPublicProfileDto>();
const posts = ref<SocialPostDto[]>([]);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const shareData = ref<SocialShareCardData>();
const moreOpen = ref(false);
const reportOpen = ref(false);
const blockConfirmOpen = ref(false);
const reportReason = ref<SocialAuthorReportRequestDto['reasonCode']>('SPAM');
const reportReasonOptions = [
  { value: 'SPAM', label: '垃圾广告' }, { value: 'ABUSE', label: '辱骂骚扰' },
  { value: 'FRAUD', label: '诈骗或诱导转账' }, { value: 'SEXUAL_CONTENT', label: '色情或不适内容' }, { value: 'OTHER', label: '其他违规行为' },
] as const;
const reportDetails = ref('');
const reportError = ref('');
const blockError = ref('');
const actionFeedback = ref('');
const activeProfileTab = ref<'games' | 'posts'>('games');
const profileQrOpen = ref(false);
const profileQrDataUrl = ref('');
const winRateLabel = computed(() => {
  const basisPoints = profile.value?.recentWinRate.rateBps;
  return basisPoints === null || basisPoints === undefined ? '暂无记录' : `${(basisPoints / 100).toFixed(1)}%`;
});
const recentWonCoinsLabel = computed(() => BigInt(profile.value?.recentWonCoins ?? '0').toLocaleString('zh-CN'));

async function loadProfile(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await props.application.getPublicProfile(props.publicProfileKey);
    if (!result.ok) { profile.value = undefined; posts.value = []; error.value = result.code === 'AUTHENTICATION_REQUIRED' ? '登录状态已失效，请重新登录。' : '这个主页暂时无法查看。'; return; }
    profile.value = result.value;
    const page = await props.application.listPublicProfilePosts(props.publicProfileKey);
    if (!page.ok) { posts.value = []; error.value = '主页帖子暂时无法读取，请重试。'; return; }
    posts.value = page.value.items;
  } catch { profile.value = undefined; error.value = '主页暂时无法读取，请检查连接后重试。'; }
  finally { loading.value = false; }
}

async function resolveTarget(): Promise<string | null> {
  const current = profile.value;
  if (!current) return null;
  const matches = await props.friendsApplication.lookup(current.publicCode);
  return matches.find((person) => person.friendCode === current.publicCode)?.userId ?? null;
}

async function friendAction(): Promise<void> {
  if (!profile.value || profile.value.isSelf || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const userId = await resolveTarget();
    if (!userId) { error.value = '暂时无法联系这位牌友，请刷新后重试。'; return; }
    if (profile.value.relationship === 'REQUEST_RECEIVED') {
      await props.friendsApplication.acceptFriend(userId);
      await loadProfile();
    } else {
      await props.friendsApplication.requestFriend(userId);
      await loadProfile();
    }
  } catch { error.value = '操作没有完成，请稍后重试。'; }
  finally { busy.value = false; }
}

async function openPrivateMessage(): Promise<void> {
  if (!profile.value || profile.value.isSelf || profile.value.blockedByMe || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const userId = await resolveTarget();
    if (!userId) { error.value = '暂时无法联系这位牌友，请刷新后重试。'; return; }
    const { conversationId } = await props.friendsApplication.openConversation(userId);
    emit('openMessages', { userId, displayName: profile.value.displayName, friendCode: profile.value.publicCode, conversationId });
  } catch { error.value = '私信暂时无法打开，请稍后重试。'; }
  finally { busy.value = false; }
}

async function toggleFollow(): Promise<void> {
  if (!profile.value || profile.value.isSelf || profile.value.blockedByMe || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await props.application.setFollowAuthor(profile.value.publicProfileKey, !profile.value.followedByMe);
    if (!result.ok) { error.value = '关注状态没有保存，请重试。'; return; }
    profile.value = { ...profile.value, followedByMe: result.value };
    actionFeedback.value = result.value ? '已关注这位牌友。' : '已取消关注。';
  } catch { error.value = '关注操作没有完成，请稍后重试。'; }
  finally { busy.value = false; }
}

async function copyPublicCode(): Promise<void> {
  if (!profile.value) return;
  try {
    await navigator.clipboard.writeText(profile.value.publicCode);
  } catch {
    const input = document.createElement('textarea');
    input.value = profile.value.publicCode;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  actionFeedback.value = '用户唯一码已复制。';
}

async function showProfileQr(): Promise<void> {
  if (!profile.value) return;
  try {
    const qr = await import('qrcode');
    const svg = await qr.toString(profile.value.profileLandingUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 240 });
    profileQrDataUrl.value = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    profileQrOpen.value = true;
  } catch { error.value = '二维码暂时无法生成，请稍后重试。'; }
}

async function setBlocked(blocked: boolean): Promise<void> {
  if (!profile.value || profile.value.isSelf || busy.value) return;
  busy.value = true;
  error.value = '';
  actionFeedback.value = '';
  blockError.value = '';
  try {
    const result = await props.application.setBlockAuthor(profile.value.publicProfileKey, blocked);
    if (!result.ok) { error.value = '拉黑状态没有保存，请重试。'; return; }
    profile.value = { ...profile.value, blockedByMe: result.value };
    if (blocked) {
      posts.value = [];
      actionFeedback.value = '已拉黑该用户，你将不再看到对方的社区内容，也无法互相发起好友和私信操作。';
    } else {
      const page = await props.application.listPublicProfilePosts(profile.value.publicProfileKey);
      if (page.ok) posts.value = page.value.items;
      actionFeedback.value = '已取消拉黑。';
    }
    blockConfirmOpen.value = false;
  } catch { blockError.value = '拉黑操作没有完成，请稍后重试。'; }
  finally { busy.value = false; }
}

async function submitAuthorReport(): Promise<void> {
  if (!profile.value || profile.value.isSelf || busy.value) return;
  busy.value = true;
  error.value = '';
  reportError.value = '';
  try {
    const result = await props.application.reportAuthor({ publicProfileKey: profile.value.publicProfileKey, reasonCode: reportReason.value, ...(reportDetails.value.trim() ? { details: reportDetails.value.trim() } : {}) });
    if (!result.ok) { reportError.value = '举报没有提交，请重试。'; return; }
    profile.value = { ...profile.value, reportedByMe: true };
    actionFeedback.value = '举报已提交，平台审核后会处理。';
    reportOpen.value = false;
    reportDetails.value = '';
  } catch { reportError.value = '举报没有提交，请稍后重试。'; }
  finally { busy.value = false; }
}

async function runProfileAction(): Promise<void> {
  moreOpen.value = false;
  actionFeedback.value = '';
  await friendAction();
}

function shareProfile(): void {
  if (!profile.value) return;
  shareData.value = {
    kind: 'PROFILE', title: profile.value.displayName, subtitle: profile.value.bio || '来 Lottery Game 牌友社区看看我的主页',
    description: `常玩：${profile.value.favoriteGames.map((game) => game.gameName).join('、') || '暂无游戏记录'}`,
    stats: `近 30 天胜率 ${winRateLabel.value}`, publicCode: profile.value.publicCode, url: profile.value.profileLandingUrl,
  };
}

function sharePost(post: SocialPostDto): void {
  if (!profile.value) return;
  shareData.value = {
    kind: 'POST', title: post.title, subtitle: profile.value.displayName, topic: post.topicKey.replaceAll('_', ' '),
    description: post.body.slice(0, 150), url: `${window.location.origin}/social/forum/posts/${encodeURIComponent(post.postId)}`,
  };
}

function actionLabel(): string {
  if (!profile.value) return '加好友';
  return profile.value.relationship === 'FRIEND' ? '已是好友'
    : profile.value.relationship === 'REQUEST_SENT' ? '申请已发送'
      : profile.value.relationship === 'REQUEST_RECEIVED' ? '处理好友申请' : '加好友';
}

function resultText(result: SocialPublicProfileDto['favoriteGames'][number]['recentResults'][number]['result']): string {
  return result === 'WIN' ? '赢' : result === 'LOSS' ? '输' : '平';
}

function resultTitle(result: 'WIN' | 'LOSS' | 'DRAW', settledAt: string): string {
  return `${formatResultDate(settledAt)} ${resultText(result)}`;
}

function formatResultDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(value));
}

watch(() => props.publicProfileKey, () => { void loadProfile(); });
onMounted(() => { void loadProfile(); });
</script>

<template>
  <section class="public-social-profile" aria-label="牌友主页">
    <header class="public-profile-toolbar"><button type="button" @click="emit('back')"><span aria-hidden="true">‹</span>返回社区</button><strong>个人主页</strong><button class="public-profile-share-trigger" type="button" :disabled="!profile" :aria-expanded="moreOpen" @click="moreOpen = !moreOpen">更多</button></header>
    <div v-if="moreOpen && profile" class="public-profile-overlay" role="presentation" @click.self="moreOpen = false"><section class="public-profile-menu" role="dialog" aria-modal="true" aria-labelledby="public-profile-menu-title"><header><div><small>牌友操作</small><h2 id="public-profile-menu-title">{{ profile.displayName }}</h2></div><button type="button" aria-label="关闭更多操作" @click="moreOpen = false">×</button></header><button v-if="!profile.isSelf && profile.relationship !== 'FRIEND'" type="button" :disabled="busy || profile.blockedByMe || profile.relationship === 'REQUEST_SENT'" @click="runProfileAction">{{ busy ? '处理中…' : actionLabel() }}</button><button type="button" @click="moreOpen = false; shareProfile()">分享</button><button v-if="!profile.isSelf" type="button" :disabled="busy || profile.reportedByMe" @click="moreOpen = false; reportError = ''; reportDetails = ''; reportOpen = true">{{ profile.reportedByMe ? '已举报' : '举报' }}</button><button v-if="!profile.isSelf" class="danger" type="button" :disabled="busy" @click="moreOpen = false; blockError = ''; blockConfirmOpen = true">{{ profile.blockedByMe ? '取消拉黑' : '拉黑' }}</button></section></div>
    <div v-if="loading" class="public-profile-state" role="status">正在载入主页…</div>
    <div v-else-if="error && !profile" class="public-profile-state public-profile-error" role="alert"><strong>主页暂不可用</strong><p>{{ error }}</p><button type="button" @click="loadProfile">重试</button></div>
    <template v-else-if="profile">
      <section class="public-profile-hero">
        <div class="public-profile-identity"><div class="public-profile-avatar" aria-hidden="true">{{ profile.displayName.slice(-1) }}</div><div class="public-profile-name"><h1>{{ profile.displayName }}</h1><p v-if="profile.bio">{{ profile.bio }}</p><div class="public-profile-meta"><small>加入于 {{ profile.joinedMonth.replace('-', ' 年 ') }} 月</small><span class="profile-trade-count">集市成交 {{ profile.completedCoinMarketTradeCount }} 笔</span></div><div class="public-profile-code-inline"><button class="profile-public-code-copy" type="button" :aria-label="`复制用户唯一码 ${profile.publicCode}`" @click="copyPublicCode">{{ profile.publicCode }}</button><button class="profile-qr-trigger" type="button" aria-label="显示用户平台二维码" @click="showProfileQr"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 2h6v6H2zM12 2h6v6h-6zM2 12h6v6H2zM12 12h2v2h-2zM16 12h2v2h-2zM12 16h2v2h-2zM16 16h2v2h-2z" fill="currentColor"/><path d="M4 4h2v2H4zM14 4h2v2h-2zM4 14h2v2H4z" fill="#17231e"/></svg></button></div></div></div>
        <div v-if="!profile.isSelf" class="public-profile-actions"><button type="button" :disabled="busy || profile.blockedByMe" @click="toggleFollow">{{ profile.followedByMe ? '已关注' : '关注' }}</button><button class="public-profile-primary" type="button" :disabled="busy || profile.blockedByMe" @click="openPrivateMessage">私信</button></div><span v-else class="public-profile-self-label">我的主页</span>
      </section>
      <section class="public-profile-metrics" aria-label="近 30 天游戏数据">
        <article><span>近 30 天胜率</span><strong>{{ winRateLabel }}</strong><small>按已结算对局计算</small></article>
        <article><span>近 30 天赢取金币</span><strong>{{ recentWonCoinsLabel }}</strong><small>仅累计获胜对局的净赢金币</small></article>
      </section>
      <section class="public-profile-section public-profile-content-tabs">
        <header class="public-profile-tabs" role="tablist" aria-label="主页内容"><button id="profile-games-tab" type="button" role="tab" :aria-selected="activeProfileTab === 'games'" aria-controls="profile-games-panel" :class="{ active: activeProfileTab === 'games' }" @click="activeProfileTab = 'games'">常玩游戏</button><button id="profile-posts-tab" type="button" role="tab" :aria-selected="activeProfileTab === 'posts'" aria-controls="profile-posts-panel" :class="{ active: activeProfileTab === 'posts' }" @click="activeProfileTab = 'posts'">动态 <span>{{ posts.length }}</span></button></header>
        <div v-if="activeProfileTab === 'games'" id="profile-games-panel" role="tabpanel" aria-labelledby="profile-games-tab" class="public-profile-tab-panel"><div class="public-profile-panel-heading"><h2>常玩游戏</h2><span>近 30 天</span></div>
        <div v-if="profile.favoriteGames.length" class="public-profile-favorite-games"><article v-for="game in profile.favoriteGames" :key="game.gameKey"><span class="favorite-game-icon" aria-hidden="true">♧</span><strong>{{ game.gameName }}</strong><small>{{ game.settledRounds }} 局</small><span class="favorite-recent-label">最近输赢</span><div v-if="game.recentResults.length" class="favorite-recent-results" :aria-label="`${game.gameName}最近输赢`"><span v-for="(result, index) in game.recentResults" :key="`${result.settledAt}-${index}`" :class="result.result.toLowerCase()" :title="resultTitle(result.result, result.settledAt)">{{ resultText(result.result) }}</span></div><small v-else class="favorite-no-results">暂无记录</small></article></div>
        <p v-else class="public-profile-empty-copy">暂无游戏记录。</p>
        </div>
        <div v-else id="profile-posts-panel" role="tabpanel" aria-labelledby="profile-posts-tab" class="public-profile-tab-panel"><div class="public-profile-panel-heading"><h2>{{ profile.displayName }}的动态</h2><span>{{ posts.length }} 条</span></div>
        <p v-if="profile.blockedByMe" class="public-profile-empty-copy">你已拉黑该用户，对方的帖子已隐藏。</p>
        <p v-else-if="!posts.length" class="public-profile-empty-copy">还没有公开发布的帖子。</p>
        <article v-for="post in posts" :key="post.postId" class="social-post-card public-profile-post-card"><header><span class="social-author">{{ profile.displayName }}</span><time>{{ formatResultDate(post.createdAt) }}</time><button class="social-more-trigger" type="button" :aria-label="`分享帖子：${post.title}`" @click="sharePost(post)">更多</button></header><h3>{{ post.title }}</h3><p class="social-post-body">{{ post.body }}</p><footer><span>{{ post.topicKey.replaceAll('_', ' ') }}</span><button type="button" @click="emit('openPost', post.postId)">查看详情与回复 ›</button></footer></article>
        </div>
      </section>
      <p v-if="profile.blockedByMe" class="public-profile-blocked-note" role="status">你已拉黑该用户，对方的社区内容已隐藏。可在“更多”中取消拉黑。</p>
      <p v-if="actionFeedback" class="public-profile-feedback" role="status">{{ actionFeedback }}</p>
      <p v-if="error" class="public-profile-inline-error" role="status">{{ error }}</p>
    </template>
    <div v-if="reportOpen && profile" class="public-profile-overlay" role="presentation" @click.self="reportOpen = false"><form class="public-profile-menu public-profile-report" role="dialog" aria-modal="true" aria-labelledby="public-profile-report-title" @submit.prevent="submitAuthorReport"><header><div><small>社区管理</small><h2 id="public-profile-report-title">举报用户</h2></div><button type="button" aria-label="关闭举报" @click="reportOpen = false">×</button></header><label>举报原因<PlayerAppSelect v-model="reportReason" label="举报原因" :options="[...reportReasonOptions]" /></label><label>补充说明（选填）<textarea v-model="reportDetails" maxlength="300" rows="3" placeholder="请简要说明情况"></textarea></label><p v-if="reportError" class="public-profile-inline-error" role="alert">{{ reportError }}</p><footer><button type="button" @click="reportOpen = false">取消</button><button type="submit" :disabled="busy">{{ busy ? '提交中…' : '提交举报' }}</button></footer></form></div>
    <div v-if="blockConfirmOpen && profile" class="public-profile-overlay" role="presentation" @click.self="blockConfirmOpen = false"><section class="public-profile-menu public-profile-confirm" role="dialog" aria-modal="true" aria-labelledby="public-profile-block-title"><header><div><small>社区关系</small><h2 id="public-profile-block-title">{{ profile.blockedByMe ? '取消拉黑' : '拉黑用户' }}</h2></div><button type="button" aria-label="关闭确认" @click="blockConfirmOpen = false">×</button></header><p>{{ profile.blockedByMe ? '取消后会重新显示对方的社区内容，并恢复好友与私信入口。' : '拉黑后将隐藏对方的社区内容，并停止双方的好友和私信操作。' }}</p><p v-if="blockError" class="public-profile-inline-error" role="alert">{{ blockError }}</p><footer><button type="button" @click="blockConfirmOpen = false">取消</button><button type="button" class="danger" :disabled="busy" @click="setBlocked(!profile.blockedByMe)">{{ busy ? '处理中…' : profile.blockedByMe ? '确认取消' : '确认拉黑' }}</button></footer></section></div>
    <div v-if="profileQrOpen && profile" class="public-profile-overlay" role="presentation" @click.self="profileQrOpen = false"><section class="public-profile-menu public-profile-qr-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-qr-title"><header><div><small>牌友主页</small><h2 id="profile-qr-title">{{ profile.displayName }}的平台二维码</h2></div><button type="button" aria-label="关闭二维码" @click="profileQrOpen = false">×</button></header><img :src="profileQrDataUrl" alt="扫描二维码访问用户主页"><strong>{{ profile.publicCode }}</strong><p>扫码可打开该用户主页</p></section></div>
    <PlayerSocialShareCard v-if="shareData" :data="shareData" @close="shareData = undefined" />
  </section>
</template>

<style scoped>
.public-social-profile{display:grid;gap:16px;max-width:900px;margin:0 auto;color:#f4eedf}.public-profile-toolbar{position:sticky;top:0;z-index:5;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;min-height:48px;padding:0 0 10px;border-bottom:1px solid #ffffff16;background:#101d1bea;backdrop-filter:blur(12px)}.public-profile-toolbar button{justify-self:start;display:flex;align-items:center;gap:6px;min-height:40px;padding:0 10px;border:0;border-radius:10px;background:transparent;color:#e1c478;font:inherit;font-size:13px}.public-profile-toolbar button span{font-size:26px;line-height:1}.public-profile-toolbar strong{font-size:15px}.public-profile-toolbar .public-profile-share-trigger{justify-self:end;border:1px solid #d9b66c50;background:#d9b66c12}.public-profile-hero{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:20px;border:1px solid #d9b66c35;border-radius:20px;background:radial-gradient(ellipse at 15% 0%,#d9b66c21,transparent 58%),linear-gradient(145deg,#182b26,#101a17)}.public-profile-identity{display:flex;align-items:center;gap:16px;min-width:0}.public-profile-avatar{display:grid;place-items:center;flex:0 0 76px;width:76px;height:76px;border:2px solid #e1c276;border-radius:50%;background:linear-gradient(140deg,#987c48,#3b604f);color:#fff3d3;font-size:30px;font-weight:750}.public-profile-name{min-width:0}.public-profile-name h1{margin:0;color:#f7efd9;font-size:24px}.public-profile-name p{margin:6px 0;color:#d3cbb9;line-height:1.5;overflow-wrap:anywhere}.public-profile-name small{color:#aaa99c;font-size:12px}.public-profile-actions{display:flex;gap:8px;flex:none}.public-profile-actions button,.public-profile-error button{min-height:42px;padding:0 15px;border:1px solid #d9b66c5c;border-radius:12px;background:#ffffff08;color:#f0dfb9;font-weight:700}.public-profile-actions .public-profile-primary{background:#d9b66c;color:#282219}.public-profile-actions button:disabled{opacity:.55}.public-profile-self-label{padding:10px 14px;border:1px solid #ffffff20;border-radius:12px;color:#c9c2b1}.public-profile-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.public-profile-metrics article{display:grid;gap:7px;min-width:0;padding:15px;border:1px solid #ffffff18;border-radius:15px;background:#ffffff07}.public-profile-metrics article>span,.public-profile-section>header span{color:#aeb1a6;font-size:11px}.public-profile-metrics strong{color:#f3d58e;font-size:21px;overflow-wrap:anywhere}.public-profile-metrics strong.positive{color:#8fd0a1}.public-profile-metrics strong.negative{color:#e9a293}.public-profile-metrics small{color:#adb0a5;font-size:11px}.public-profile-section{display:grid;gap:10px}.public-profile-section>header{display:flex;align-items:center;justify-content:space-between;gap:12px}.public-profile-section h2{margin:0;color:#f0e6cf;font-size:17px}.public-profile-results{display:grid;gap:7px}.public-profile-results article{display:grid;grid-template-columns:36px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:48px;padding:6px 12px;border:1px solid #ffffff14;border-radius:12px;background:#ffffff05}.public-profile-results article strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.public-profile-results time{color:#a8aa9e;font-size:11px}.result-badge{display:grid;place-items:center;width:30px;height:28px;border-radius:8px;font-size:12px;font-weight:800}.result-badge.win{background:#73b98422;color:#a6dfae}.result-badge.loss{background:#dc817122;color:#f2a99b}.result-badge.draw{background:#ffffff15;color:#d7d3c6}.public-profile-favorite-games{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.public-profile-favorite-games article{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:4px 9px;padding:12px;border:1px solid #d9b66c2b;border-radius:13px;background:#d9b66c09}.public-profile-favorite-games article>span{grid-row:span 2;color:#e3c579;font-size:19px}.public-profile-favorite-games strong{font-size:13px}.public-profile-favorite-games small{color:#a8aa9e;font-size:10px}.public-profile-code{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 17px;border:1px solid #d9b66c42;border-radius:16px;background:#d9b66c0c}.public-profile-code>div{display:grid;gap:4px;min-width:0}.public-profile-code small{color:#bdb6a5;font-size:11px}.public-profile-code strong{color:#f1d58e;font-size:17px;letter-spacing:.08em}.public-profile-code p{margin:0;color:#aaa99c;font-size:11px}.public-profile-code button{min-height:40px;flex:none;padding:0 12px;border:1px solid #d9b66c55;border-radius:10px;background:#d9b66c16;color:#eed89f}.public-profile-empty-copy{margin:0;padding:18px;border:1px dashed #ffffff25;border-radius:13px;color:#a8aa9e;text-align:center;font-size:13px}.public-profile-posts{padding-bottom:14px}.public-profile-post-card{margin:0}.public-profile-post-card footer button{border:0;background:transparent}.public-profile-state{display:grid;place-items:center;min-height:240px;color:#d6cfbc;text-align:center}.public-profile-error strong{font-size:18px}.public-profile-error p{color:#b4b1a7}.public-profile-inline-error{margin:0;color:#f2a99b;font-size:12px}
@media(max-width:760px){.public-social-profile{gap:13px}.public-profile-toolbar{margin:0 -2px;padding-inline:2px}.public-profile-hero{display:grid;gap:15px;padding:15px;border-radius:16px}.public-profile-identity{gap:12px}.public-profile-avatar{flex-basis:60px;width:60px;height:60px;font-size:24px}.public-profile-name h1{font-size:20px}.public-profile-name p{font-size:13px}.public-profile-actions{display:grid;grid-template-columns:1fr 1fr}.public-profile-actions button{width:100%}.public-profile-metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.public-profile-metrics article{padding:12px}.public-profile-metrics article:last-child{grid-column:1/-1}.public-profile-metrics strong{font-size:18px}.public-profile-favorite-games{grid-template-columns:1fr}.public-profile-favorite-games article{grid-template-columns:auto 1fr auto}.public-profile-favorite-games article>span{grid-row:auto}.public-profile-results article{grid-template-columns:34px minmax(0,1fr) auto;padding-inline:9px}.public-profile-results article strong{font-size:12px}.public-profile-code{padding:13px}.public-profile-code strong{font-size:15px}.public-profile-section h2{font-size:15px}}
@media(max-width:360px){.public-profile-metrics article{padding:10px}.public-profile-metrics strong{font-size:16px}.public-profile-code{align-items:flex-start;flex-direction:column}.public-profile-code button{width:100%}}
.public-profile-overlay{position:fixed;z-index:220;inset:0;display:grid;place-items:center;padding:16px;background:#06100edb;backdrop-filter:blur(8px)}.public-profile-menu{box-sizing:border-box;width:min(100%,420px);padding:18px;border:1px solid #d9b66c66;border-radius:20px;background:linear-gradient(145deg,#172a25,#0e1916);box-shadow:0 25px 90px #000b;color:#f2ecdc}.public-profile-menu>header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.public-profile-menu header small{color:#e3c579;font-size:11px}.public-profile-menu h2{margin:5px 0 0;font-size:19px}.public-profile-menu header button{display:grid;place-items:center;flex:none;width:40px;height:40px;border:1px solid #ffffff25;border-radius:12px;background:#ffffff08;color:#f2ecdc;font-size:24px}.public-profile-menu>button{display:flex;align-items:center;width:100%;min-height:48px;margin-top:8px;padding:0 14px;border:1px solid #ffffff18;border-radius:12px;background:#ffffff08;color:#eee5d1;text-align:left;font:inherit;font-weight:650}.public-profile-menu>button.danger,.public-profile-menu footer button.danger{color:#f0aaa0}.public-profile-menu button:disabled{opacity:.55}.public-profile-report label{display:grid;gap:7px;margin:12px 0;color:#ded5c1;font-size:13px}.public-profile-report select,.public-profile-report textarea{box-sizing:border-box;width:100%;min-height:44px;padding:10px 12px;border:1px solid #ffffff24;border-radius:10px;background:#0c1714;color:#f2ecdc;font:inherit}.public-profile-report textarea{resize:vertical}.public-profile-menu footer{display:flex;gap:9px;margin-top:16px}.public-profile-menu footer button{flex:1;min-height:44px;padding:0 12px;border:1px solid #d9b66c55;border-radius:11px;background:#ffffff08;color:#efdfbd;font:inherit;font-weight:650}.public-profile-menu footer button:last-child{background:#d9b66c;color:#211f19}.public-profile-confirm p{color:#c8c3b5;line-height:1.55}.public-profile-blocked-note,.public-profile-feedback{margin:0;padding:12px 14px;border:1px solid #d9b66c40;border-radius:12px;background:#d9b66c0c;color:#dfd3b7;font-size:13px;line-height:1.5}.public-profile-favorite-games article{grid-template-columns:30px minmax(0,1fr) auto;grid-template-rows:auto auto auto}.public-profile-favorite-games article>.favorite-game-icon{grid-column:1;grid-row:1/3}.public-profile-favorite-games article>strong{grid-column:2;grid-row:1}.public-profile-favorite-games article>small:not(.favorite-no-results){grid-column:3;grid-row:1;color:#a8aa9e}.public-profile-favorite-games article>.favorite-recent-label{grid-column:2/-1;grid-row:2;color:#a8aa9e;font-size:10px}.favorite-recent-results{display:flex;grid-column:2/-1;grid-row:3;gap:5px}.favorite-recent-results span{display:grid;place-items:center;width:25px;height:24px;border-radius:7px;font-size:11px;font-weight:750}.favorite-recent-results .win{background:#73b98422;color:#a6dfae}.favorite-recent-results .loss{background:#dc817122;color:#f2a99b}.favorite-recent-results .draw{background:#ffffff15;color:#d7d3c6}.public-profile-favorite-games article>.favorite-no-results{grid-column:2/-1;grid-row:3;color:#a8aa9e;font-size:11px}.public-profile-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.public-profile-post-card>header time{margin-left:auto}
</style>

<style scoped>
.public-profile-hero{align-items:center}
.public-profile-actions{display:flex;gap:8px}
.public-profile-actions button{min-height:40px;padding:0 17px;border:1px solid #d9b66c60;border-radius:12px;background:#ffffff08;color:#f0dfb9;font:inherit;font-weight:700;white-space:nowrap}
.public-profile-actions .public-profile-primary{background:#d9b66c;color:#282219}
.public-profile-meta{display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;margin-top:5px}
.profile-trade-count{color:#aaa99c;font-size:11px}
.public-profile-code-inline{display:flex;align-items:center;gap:5px;margin-top:5px}
.profile-public-code-copy{padding:0;border:0;background:transparent;color:#f1d58e;font:inherit;font-size:13px;font-weight:750;letter-spacing:.08em;cursor:pointer}
.profile-qr-trigger{display:grid;place-items:center;width:24px;height:24px;padding:4px;border:0;border-radius:6px;background:transparent;color:#d9c27f;cursor:pointer}
.profile-qr-trigger svg{width:16px;height:16px}
.public-profile-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
.public-profile-metrics article{min-height:92px;align-content:center}
.public-profile-content-tabs{gap:12px;padding:14px;border:1px solid #ffffff16;border-radius:16px;background:#ffffff04}
.public-profile-tabs{display:flex;gap:8px;border-bottom:1px solid #ffffff16}
.public-profile-tabs button{position:relative;display:flex;align-items:center;gap:7px;min-height:40px;padding:0 12px;border:0;background:transparent;color:#aeb1a6;font:inherit;font-size:13px;font-weight:700;cursor:pointer}
.public-profile-tabs button.active{color:#f2d68f}
.public-profile-tabs button.active::after{position:absolute;right:8px;bottom:-1px;left:8px;height:2px;border-radius:2px;background:#e0bd6f;content:""}
.public-profile-tabs button span{color:#aeb1a6;font-size:11px}
.public-profile-tab-panel{display:grid;gap:10px;min-width:0}
.public-profile-panel-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}
.public-profile-panel-heading h2{margin:0;color:#f0e6cf;font-size:14px}
.public-profile-panel-heading>span{color:#aeb1a6;font-size:11px}
.public-profile-qr-dialog{display:grid;justify-items:center;text-align:center}
.public-profile-qr-dialog>header{width:100%;text-align:left}
.public-profile-qr-dialog img{width:min(62vw,220px);aspect-ratio:1;padding:10px;border-radius:14px;background:#fff}
.public-profile-qr-dialog>strong{margin-top:12px;color:#f1d58e;letter-spacing:.08em}
.public-profile-qr-dialog>p{margin:6px 0 0;color:#aaa99c;font-size:12px}
@media(max-width:760px){
  .public-profile-hero{grid-template-columns:minmax(0,1fr);gap:13px}
  .public-profile-actions{display:grid;grid-template-columns:1fr 1fr;width:100%}
  .public-profile-actions button{width:100%;padding:0 8px}
  .public-profile-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
  .public-profile-metrics article:last-child{grid-column:auto}
  .public-profile-content-tabs{padding:11px}
  .public-profile-favorite-games{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-width:430px){
  .public-profile-identity{align-items:flex-start}
  .public-profile-meta{gap:5px 9px}
  .public-profile-metrics article{min-height:84px;padding:10px}
  .public-profile-metrics strong{font-size:16px}
  .public-profile-favorite-games{grid-template-columns:1fr}
}
</style>
