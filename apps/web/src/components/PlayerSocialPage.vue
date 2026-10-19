<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { SocialApplication } from '../platform/social/social-application';
import type { SocialFriendsApplication } from '../platform/social/friends-application';
import type { CoinMarketApplication } from '../platform/coin-market/coin-market-application';
import PlayerSocialWorkspace from './PlayerSocialWorkspace.vue';
import PlayerCoinMarketWorkspace from './PlayerCoinMarketWorkspace.vue';
import PlayerFriendsWorkspace from './PlayerFriendsWorkspace.vue';
import PlayerPublicSocialProfile from './PlayerPublicSocialProfile.vue';

export type SocialSection = 'forum' | 'market' | 'friends';
const props = defineProps<{
  section: SocialSection;
  postId?: string | undefined;
  profileKey?: string | undefined;
  authenticated: boolean;
  userId?: string | undefined;
  socialApplication?: SocialApplication | undefined;
  friendsApplication?: SocialFriendsApplication | undefined;
  marketApplication?: CoinMarketApplication | undefined;
  availableCoins: string;
  turnoverRemaining: string;
}>();
const emit = defineEmits<{
  navigate: [section: SocialSection];
  openPost: [postId: string];
  backToForum: [];
  openProfile: [profileKey: string];
  closeProfile: [];
  openMessages: [peer: { userId: string; displayName: string; friendCode: string; conversationId: string }];
  back: [];
  login: [];
  walletChanged: [];
}>();
const sections: { key: SocialSection; label: string; title: string; description: string; icon: string }[] = [
  { key: 'forum', label: '话题广场', title: '和牌友聊聊', description: '分享玩法心得，参与话题讨论。', icon: '◎' },
  { key: 'market', label: '金币集市', title: '金币挂牌与交易', description: '查看公开挂牌，管理自己的挂牌和交易。', icon: '¤' },
  { key: 'friends', label: '好友', title: '找到熟悉的牌友', description: '用好友码或用户名查找，处理好友申请。', icon: '♧' },
];
const active = computed(() => sections.find((section) => section.key === props.section) ?? sections[0]!);
const slideDirection = ref<'left' | 'right'>('left');
const slideTransition = computed(() => `social-slide-${slideDirection.value}`);
watch(() => props.section, (next, previous) => {
  const previousIndex = sections.findIndex((item) => item.key === previous);
  const nextIndex = sections.findIndex((item) => item.key === next);
  slideDirection.value = nextIndex >= previousIndex ? 'left' : 'right';
});
let restoreScrollY: number | undefined;
function openProfile(profileKey: string): void {
  restoreScrollY = window.scrollY;
  emit('openProfile', profileKey);
}
watch(() => props.profileKey, async (profileKey) => {
  if (!profileKey && restoreScrollY !== undefined) {
    await nextTick();
    window.scrollTo({ top: restoreScrollY, behavior: 'instant' });
    restoreScrollY = undefined;
  }
});
</script>

<template>
  <main class="social-page" :class="{ 'social-post-detail-page': postId }">
    <div class="social-page-layout" :class="{ 'social-profile-layout': profileKey, 'social-post-detail-layout': postId }">
      <aside v-show="!profileKey && !postId" class="social-rail" aria-label="社交功能导航">
        <p class="social-rail-label">发现与交流</p>
        <button v-for="item in sections" :key="item.key" type="button" :class="{ active: section === item.key }" :aria-current="section === item.key ? 'page' : undefined" @click="emit('navigate', item.key)">
          <span class="social-nav-icon" aria-hidden="true">{{ item.icon }}</span><span>{{ item.label }}</span><span v-if="section === item.key" class="social-nav-arrow" aria-hidden="true">›</span>
        </button>
        <div class="social-rail-help"><strong>从这里开始</strong><p>浏览话题、结识牌友，或查看金币集市的交易。</p></div>
      </aside>
      <section class="social-page-content" :aria-labelledby="`social-title-${section}`">
        <header v-show="!profileKey && !postId" class="social-section-heading">
          <div><h1 :id="`social-title-${section}`">{{ active.title }}</h1><p>{{ active.description }}</p></div>
        </header>
        <nav v-show="!profileKey && !postId" class="social-mobile-nav" aria-label="社交功能导航">
          <button v-for="item in sections" :key="item.key" type="button" :class="{ active: section === item.key }" :aria-current="section === item.key ? 'page' : undefined" @click="emit('navigate', item.key)">{{ item.label }}</button>
        </nav>
        <div v-if="!authenticated && !profileKey" class="social-auth-callout"><span aria-hidden="true">✦</span><div><strong>登录后开始使用</strong><p>账号登录后可浏览和发布话题、添加好友、发送私信及参与金币集市。</p></div><button type="button" @click="emit('login')">登录 / 恢复</button></div>
        <div class="social-workspace-frame" :class="{ 'market-workspace-frame': section === 'market' }" v-show="!profileKey">
          <Transition :name="slideTransition" mode="out-in">
            <div :key="section" class="social-workspace-content">
              <PlayerSocialWorkspace v-if="authenticated && section === 'forum' && socialApplication" :application="socialApplication" :post-id="postId" @open-post="emit('openPost', $event)" @back-to-forum="emit('backToForum')" @open-profile="openProfile" />
              <PlayerCoinMarketWorkspace v-else-if="authenticated && section === 'market' && marketApplication" :application="marketApplication" :available-coins="availableCoins" :turnover-remaining="turnoverRemaining" @listing-changed="emit('walletChanged')" />
              <PlayerFriendsWorkspace v-else-if="authenticated && section === 'friends' && friendsApplication && userId" :application="friendsApplication" mode="friends" :current-user-id="userId" @open-peer-conversation="emit('openMessages', $event)" />
              <div v-else-if="authenticated" class="social-api-unavailable"><strong>此功能暂不可用</strong><p>当前运行环境尚未提供这项功能的 API，请稍后再试。</p></div>
              <div v-else class="social-preview">
                <span class="social-preview-icon" aria-hidden="true">{{ active.icon }}</span><strong>{{ active.label }}等你加入</strong><p>登录后即可查看你的内容和可用操作。</p>
              </div>
            </div>
          </Transition>
        </div>
        <PlayerPublicSocialProfile v-if="profileKey && authenticated && socialApplication && friendsApplication" :public-profile-key="profileKey" :application="socialApplication" :friends-application="friendsApplication" @back="emit('closeProfile')" @open-post="emit('openPost', $event)" @open-messages="emit('openMessages', $event)" />
      </section>
    </div>
  </main>
</template>

<style scoped>
.social-page{position:relative;z-index:1;min-height:100svh;padding:24px clamp(18px,4vw,64px) 48px;color:#f6f0df;background:linear-gradient(125deg,rgba(12,25,27,.22),rgba(20,31,30,.16) 58%,rgba(46,35,23,.2));box-sizing:border-box}.social-page-layout{max-width:1440px;margin:10px auto 0;display:grid;grid-template-columns:238px minmax(0,1fr);gap:28px}.social-rail{align-self:start;padding:18px 12px;border:1px solid rgba(232,199,125,.2);border-radius:20px;background:rgba(9,18,19,.68)}.social-rail-label{margin:0 10px 13px;color:#a8aaa0;font-size:12px;letter-spacing:.12em}.social-rail>button{position:relative;display:flex;align-items:center;gap:12px;width:100%;padding:13px 12px;margin:4px 0;border:0;border-radius:12px;background:transparent;color:#d9d9cd;text-align:left;font:inherit;cursor:pointer}.social-rail>button.active{background:linear-gradient(100deg,rgba(204,166,91,.2),rgba(204,166,91,.07));color:#f3d58e}.social-nav-icon{width:24px;text-align:center;font-size:19px}.social-nav-arrow{margin-left:auto;font-size:22px}.social-rail-help{margin:28px 4px 0;padding:15px 12px;border-top:1px solid rgba(232,199,125,.18);color:#e4d5b5}.social-rail-help p{margin:7px 0 0;color:#aeb1a9;font-size:13px;line-height:1.55}.social-page-content{min-width:0}.social-section-heading{display:flex;justify-content:space-between;align-items:center;gap:20px;margin:8px 0 20px}.social-section-heading h1{margin:7px 0 5px;font-size:clamp(25px,3vw,36px);line-height:1.15}.social-section-heading p{margin:0;color:#c4c4b9}.social-heading-action{flex:none;border:1px solid #dab86d;border-radius:12px;padding:12px 17px;background:#d9b66c;color:#25251e;font-weight:750;cursor:pointer}.social-workspace-frame{min-height:420px;padding:22px;border:1px solid rgba(232,199,125,.22);border-radius:20px;background:rgba(13,21,22,.84);box-shadow:0 20px 55px rgba(0,0,0,.22)}.social-auth-callout{display:flex;align-items:center;gap:14px;margin:0 0 16px;padding:15px 18px;border:1px solid rgba(218,184,109,.34);border-radius:14px;background:rgba(218,184,109,.1)}.social-auth-callout>span{font-size:24px;color:#e9c675}.social-auth-callout div{flex:1}.social-auth-callout strong{color:#f2dfb7}.social-auth-callout p{margin:4px 0 0;color:#c5c1b2;font-size:13px}.social-auth-callout button{border:0;border-radius:9px;background:#d9b66c;color:#25251e;padding:10px 14px;font-weight:700;cursor:pointer}.social-preview,.social-api-unavailable{min-height:370px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#ddd4bf}.social-preview-icon{font-size:48px;color:#d6b66f}.social-preview strong,.social-api-unavailable strong{margin-top:13px;font-size:19px}.social-preview p,.social-api-unavailable p{color:#aaa99e}.social-mobile-nav{display:none}
@media(max-width:760px){.social-page{padding:0 0 calc(20px + env(safe-area-inset-bottom));min-height:100svh;background:linear-gradient(160deg,rgba(13,25,27,.28),rgba(22,30,29,.2) 56%,rgba(40,31,23,.28))}.social-page-layout{display:block;margin:0}.social-rail{display:none}.social-page-content{padding:19px 14px}.social-section-heading{margin:4px 2px 16px;align-items:flex-start}.social-section-heading h1{font-size:25px}.social-section-heading p{font-size:13px;line-height:1.5}.social-heading-action{padding:10px 12px;font-size:13px}.social-mobile-nav{display:flex;gap:7px;overflow-x:auto;padding:3px 1px 12px;scrollbar-width:none}.social-mobile-nav::-webkit-scrollbar{display:none}.social-mobile-nav button{flex:1 0 auto;display:flex;align-items:center;justify-content:center;gap:6px;min-height:42px;padding:0 12px;border:1px solid rgba(232,199,125,.2);border-radius:12px;background:rgba(9,18,19,.58);color:#d9d9cd;font-size:13px;white-space:nowrap}.social-mobile-nav button.active{border-color:rgba(232,199,125,.62);background:rgba(204,166,91,.2);color:#f3d58e}.social-workspace-frame{min-height:calc(100svh - 150px);padding:15px 12px;border-radius:16px}.social-auth-callout{align-items:flex-start;padding:13px}.social-auth-callout p{line-height:1.5}.social-auth-callout button{align-self:center;white-space:nowrap}.social-preview,.social-api-unavailable{min-height:300px}}
@media(max-width:380px){.social-section-heading p{max-width:220px}.social-heading-action{font-size:12px;padding:9px}.social-auth-callout{flex-wrap:wrap}.social-auth-callout div{min-width:180px}.social-auth-callout button{margin-left:38px}}
.social-page{padding-bottom:104px}
@media(max-width:760px){.social-page{padding-bottom:calc(92px + env(safe-area-inset-bottom))}}
.social-workspace-frame.market-workspace-frame{min-height:0;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none}
.social-page-layout.social-profile-layout{grid-template-columns:minmax(0,1fr)}
@media(max-width:760px){.social-workspace-frame.market-workspace-frame{min-height:0;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none}}
.social-rail,.social-workspace-frame:not(.market-workspace-frame),.social-mobile-nav button{background-color:rgba(4,15,13,.58);-webkit-backdrop-filter:blur(4px) saturate(108%);backdrop-filter:blur(4px) saturate(108%)}
.social-workspace-frame:not(.market-workspace-frame){background:rgba(4,15,13,.56)}
.social-workspace-content{min-width:0;}
.social-slide-left-enter-active,.social-slide-left-leave-active,.social-slide-right-enter-active,.social-slide-right-leave-active{transition:transform .22s cubic-bezier(.2,.75,.25,1),opacity .18s ease;}
.social-slide-left-enter-from{opacity:0;transform:translateX(24px)}.social-slide-left-leave-to{opacity:0;transform:translateX(-24px)}
.social-slide-right-enter-from{opacity:0;transform:translateX(-24px)}.social-slide-right-leave-to{opacity:0;transform:translateX(24px)}
@media(prefers-reduced-motion:reduce){.social-slide-left-enter-active,.social-slide-left-leave-active,.social-slide-right-enter-active,.social-slide-right-leave-active{transition:none}}
.social-rail{border-color:rgba(232,199,125,.38)}
.social-mobile-nav button{border-color:rgba(232,199,125,.34)}
.social-mobile-nav button.active{background:rgba(76,59,25,.7)}
.social-auth-callout{background:rgba(48,37,17,.62);-webkit-backdrop-filter:blur(4px) saturate(108%);backdrop-filter:blur(4px) saturate(108%)}
.social-page :deep(.coin-market-listing-row),.social-page :deep(.coin-market-trade-row),.social-page :deep(.coin-market-sell-panel),.social-page :deep(.coin-market-quote-result>div){background-color:rgba(4,17,14,.62);-webkit-backdrop-filter:blur(4px) saturate(108%);backdrop-filter:blur(4px) saturate(108%)}
.social-page{padding-right:clamp(16px,2.5vw,40px);padding-left:clamp(16px,2.5vw,40px)}
.social-page-layout{grid-template-columns:220px minmax(0,1fr);gap:20px}
.social-workspace-frame:not(.market-workspace-frame){min-height:0;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none}
.social-workspace-frame:not(.market-workspace-frame){background:rgba(4,15,13,.34);-webkit-backdrop-filter:blur(4px) saturate(108%);backdrop-filter:blur(4px) saturate(108%)}
@media(max-width:760px){.social-page{padding-right:0;padding-left:0}.social-page-layout{grid-template-columns:minmax(0,1fr);gap:0}.social-page-content{padding:16px 10px}.social-mobile-nav{gap:4px;overflow-x:auto;margin:0 -10px;padding:3px 10px 12px;overscroll-behavior-x:contain;scrollbar-width:none}.social-mobile-nav button{flex:0 0 auto;min-height:40px;gap:0;padding:0 15px;border-radius:10px}.social-workspace-frame:not(.market-workspace-frame){min-height:0;padding:0;border:0;border-radius:0;background:rgba(4,15,13,.34);box-shadow:none;-webkit-backdrop-filter:blur(4px) saturate(108%);backdrop-filter:blur(4px) saturate(108%)}}
.social-page-layout.social-post-detail-layout{grid-template-columns:minmax(0,1fr);max-width:980px}
.social-page.social-post-detail-page .social-page-content{min-width:0}
.social-page.social-post-detail-page .social-workspace-frame{min-height:0;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none}
@media(max-width:760px){.social-page.social-post-detail-page{min-height:calc(100svh - 72px)}.social-page.social-post-detail-page .social-page-content{padding-top:8px}.social-page.social-post-detail-page .social-workspace-frame{min-height:0}}
</style>
