<script setup lang="ts">
import type { PlayerPrimaryDestination } from './PlayerPrimaryNavigation.vue';
import PlayerNotificationsWorkspace from './PlayerNotificationsWorkspace.vue';
import PlayerSupportWorkspace from './PlayerSupportWorkspace.vue';
import PlayerFriendsWorkspace from './PlayerFriendsWorkspace.vue';
import type { NotificationSummaryApplication } from '../platform/notifications/notification-summary-application';
import type { SupportClientApplication } from '../platform/support/support-application';
import type { SocialFriendsApplication } from '../platform/social/friends-application';
import type { NotificationSummaryItemDto } from '@gameing/contracts/notifications';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

export type PlayerMessagesSection = 'all' | 'inbox' | 'private' | 'support';
const props = defineProps<{
  section: PlayerMessagesSection;
  authenticated: boolean;
  userId?: string | undefined;
  socialEnabled: boolean;
  notificationApplication?: NotificationSummaryApplication | undefined;
  supportApplication?: SupportClientApplication | undefined;
  friendsApplication?: SocialFriendsApplication | undefined;
  initialPeer?: { userId: string; displayName: string; friendCode: string } | undefined;
  initialConversationId?: string | undefined;
}>();
const visitedSections = ref(new Set<PlayerMessagesSection>([props.section]));
const refreshing = ref(false);
const notificationsAllRef = ref<InstanceType<typeof PlayerNotificationsWorkspace> | null>(null);
const notificationsInboxRef = ref<InstanceType<typeof PlayerNotificationsWorkspace> | null>(null);
const friendsRef = ref<InstanceType<typeof PlayerFriendsWorkspace> | null>(null);
const supportRef = ref<InstanceType<typeof PlayerSupportWorkspace> | null>(null);
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const emit = defineEmits<{
  navigate: [section: PlayerMessagesSection];
  openNotification: [item: NotificationSummaryItemDto];
  openFriends: [];
  login: [];
  navigatePrimary: [destination: PlayerPrimaryDestination];
  openConversation: [conversationId: string];
  closeConversation: [];
}>();

const sections: { key: PlayerMessagesSection; label: string; description: string; icon: string }[] = [
  { key: 'all', label: '全部', description: '最近的站内信与业务动态', icon: '✦' },
  { key: 'inbox', label: '站内信', description: '平台公告、资产与订单状态', icon: '✉' },
  { key: 'private', label: '私信', description: '好友会话与牌友交流', icon: '◎' },
  { key: 'support', label: '客服', description: '咨询与服务进度', icon: '◉' },
];
const current = () => sections.find((item) => item.key === props.section) ?? sections[0]!;

watch(() => props.section, (section) => {
  visitedSections.value = new Set([...visitedSections.value, section]);
});

async function refreshCurrentSection(): Promise<void> {
  if (refreshing.value) return;
  const refresh = props.section === 'all'
    ? notificationsAllRef.value?.refresh
    : props.section === 'inbox'
      ? notificationsInboxRef.value?.refresh
      : props.section === 'private'
        ? friendsRef.value?.refresh
        : supportRef.value?.refresh;
  if (!refresh) return;
  refreshing.value = true;
  try { await refresh(); }
  finally { refreshing.value = false; }
}

onMounted(() => {
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void refreshCurrentSection();
  }, 60_000);
});
onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
defineExpose({ refresh: refreshCurrentSection });
</script>

<template>
  <main v-if="section === 'private' && initialConversationId && authenticated && socialEnabled && friendsApplication && userId" class="player-conversation-route" aria-label="私信会话">
    <PlayerFriendsWorkspace :application="friendsApplication" mode="messages" :current-user-id="userId" :initial-peer="initialPeer" :initial-conversation-id="initialConversationId" full-screen @open-conversation="emit('openConversation', $event)" @close-conversation="emit('closeConversation')" />
  </main>
  <main v-else class="player-messages-page">
    <div class="player-messages-layout">
      <aside class="player-messages-rail" aria-label="消息分类">
        <header><span class="player-messages-envelope" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg></span><div><h1>消息</h1><p>和牌友保持联系</p></div></header>
        <nav>
          <button v-for="item in sections" :key="item.key" type="button" :class="{ active: section === item.key, unavailable: item.key === 'private' && !socialEnabled }" :aria-current="section === item.key ? 'page' : undefined" :disabled="item.key === 'private' && !socialEnabled" @click="emit('navigate', item.key)">
            <span aria-hidden="true">{{ item.icon }}</span><span>{{ item.label }}</span><i v-if="section === item.key" aria-hidden="true">›</i>
          </button>
        </nav>
        <p v-if="!socialEnabled" class="player-messages-rail-note">当前账号暂不可使用私信</p>
      </aside>

      <section class="player-messages-content" :aria-label="current().label">
        <header class="player-messages-heading">
          <div><span>{{ current().label }}</span><h2>{{ section === 'all' ? '最近消息' : current().label }}</h2><p>{{ current().description }}</p></div>
          <div class="player-messages-heading-actions">
            <button class="player-messages-refresh" type="button" :disabled="refreshing" aria-label="刷新当前消息" title="刷新；每分钟自动更新" @click="refreshCurrentSection"><svg :class="{ spinning: refreshing }" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4.7 9a7.5 7.5 0 0 1 12.8-2L20 12M4 17v-5h5m10.3 3a7.5 7.5 0 0 1-12.8 2L4 12" /></svg></button>
            <button v-if="section === 'private' && socialEnabled" class="player-messages-friends" type="button" @click="emit('openFriends')">社区好友 <span aria-hidden="true">›</span></button>
          </div>
        </header>
        <nav class="player-messages-mobile-tabs" aria-label="消息分类">
          <button v-for="item in sections" :key="item.key" type="button" :class="{ active: section === item.key }" :disabled="item.key === 'private' && !socialEnabled" :aria-current="section === item.key ? 'page' : undefined" @click="emit('navigate', item.key)">{{ item.label }}</button>
        </nav>

        <section v-if="visitedSections.has('all')" v-show="section === 'all'" class="player-messages-section" aria-label="全部消息">
          <div class="player-message-shortcuts" aria-label="消息分类快捷入口">
            <button v-for="item in sections.slice(1)" v-show="item.key !== 'private' || socialEnabled" :key="item.key" type="button" @click="emit('navigate', item.key)">
              <span class="player-message-shortcut-icon" :class="`is-${item.key}`" aria-hidden="true">{{ item.icon }}</span><span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span><i aria-hidden="true">›</i>
            </button>
          </div>
          <section class="player-message-recent"><h3>最近动态</h3>
            <PlayerNotificationsWorkspace v-if="notificationApplication" ref="notificationsAllRef" :application="notificationApplication" :authenticated="authenticated" :social-enabled="socialEnabled" @open="emit('openNotification', $event)" @login="emit('login')" />
            <div v-else class="player-message-empty"><span>✉</span><strong>消息暂不可用</strong><p>请稍后重试。</p></div>
          </section>
        </section>

        <section v-if="visitedSections.has('inbox')" v-show="section === 'inbox'" class="player-message-domain player-message-domain-inbox" aria-label="站内信">
          <PlayerNotificationsWorkspace v-if="notificationApplication" ref="notificationsInboxRef" :application="notificationApplication" :authenticated="authenticated" :sources="['ANNOUNCEMENT', 'WALLET']" :social-enabled="socialEnabled" @open="emit('openNotification', $event)" @login="emit('login')" />
        </section>
        <section v-if="visitedSections.has('private')" v-show="section === 'private'" class="player-message-domain player-message-domain-private">
          <div v-if="!authenticated" class="player-message-empty"><span>◎</span><strong>登录后查看私信</strong><p>好友会话会保存在当前账号中。</p><button type="button" @click="emit('login')">登录 / 恢复账号</button></div>
          <PlayerFriendsWorkspace v-else-if="socialEnabled && friendsApplication && userId" ref="friendsRef" :application="friendsApplication" mode="messages" :current-user-id="userId" :initial-peer="initialPeer" @open-conversation="emit('openConversation', $event)" />
          <div v-else class="player-message-empty"><span>◎</span><strong>私信暂不可用</strong><p>请稍后重试。</p></div>
        </section>
        <section v-if="visitedSections.has('support')" v-show="section === 'support'" class="player-message-domain">
          <div v-if="!authenticated" class="player-message-empty"><span>◉</span><strong>登录后联系在线客服</strong><p>客服会话将与账号关联，方便继续查看处理进度。</p><button type="button" @click="emit('login')">登录 / 恢复账号</button></div>
          <PlayerSupportWorkspace v-else-if="supportApplication" ref="supportRef" :application="supportApplication" />
          <div v-else class="player-message-empty"><span>◉</span><strong>客服暂不可用</strong><p>请稍后重试。</p></div>
        </section>
      </section>
    </div>
  </main>
</template>

<style scoped>
.player-messages-page{position:relative;z-index:1;box-sizing:border-box;min-height:100svh;padding:28px clamp(16px,4vw,64px) calc(112px + env(safe-area-inset-bottom));color:#f6f0df;background:linear-gradient(135deg,rgba(10,24,24,.24),rgba(16,31,29,.18) 56%,rgba(43,33,23,.22))}.player-messages-layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:24px;max-width:1320px;min-height:calc(100svh - 150px);margin:0 auto}.player-messages-rail{align-self:start;padding:20px 14px;border:1px solid #e8c77d30;border-radius:18px;background:#071714a6}.player-messages-rail>header{display:flex;align-items:center;gap:12px;padding:0 8px 20px;border-bottom:1px solid #ffffff16}.player-messages-envelope{display:grid;width:42px;height:42px;place-items:center;border:1px solid #e8c77d50;border-radius:13px;color:#efd184;background:#d9ba7514}.player-messages-envelope svg{width:23px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.player-messages-rail h1{margin:0;font-size:19px}.player-messages-rail header p{margin:4px 0 0;color:#aebbb0;font-size:11px}.player-messages-rail nav{display:grid;gap:5px;padding-top:13px}.player-messages-rail nav button{display:flex;align-items:center;gap:11px;width:100%;min-height:46px;padding:0 12px;border:1px solid transparent;border-radius:11px;color:#d3d8cd;background:transparent;text-align:left;font:inherit;cursor:pointer}.player-messages-rail nav button>span:first-child{display:grid;width:25px;place-items:center;color:#cbb46e;font-size:17px}.player-messages-rail nav button.active{border-color:#e8c77d35;color:#f3d98f;background:linear-gradient(100deg,#d9ba7523,#d9ba750b)}.player-messages-rail nav button i{margin-left:auto;font-style:normal;font-size:21px}.player-messages-rail nav button:disabled{opacity:.38;cursor:not-allowed}.player-messages-rail-note{margin:14px 6px 0;color:#aebbb0;font-size:10px;line-height:1.5}.player-messages-content{min-width:0;padding:8px 0 30px}.player-messages-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 2px 18px}.player-messages-heading>div>span{color:#d8b869;font-size:11px;letter-spacing:.1em}.player-messages-heading h2{margin:5px 0 4px;font-size:27px}.player-messages-heading p{margin:0;color:#b6c2b6;font-size:12px}.player-messages-heading-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}.player-messages-refresh{display:grid;width:40px;height:40px;place-items:center;border:1px solid #e8c77d45;border-radius:12px;color:#efd184;background:rgba(4,17,14,.58);cursor:pointer}.player-messages-refresh svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.player-messages-refresh:disabled{opacity:.7;cursor:wait}.player-messages-refresh svg.spinning{animation:player-message-refresh-spin .8s linear infinite}@keyframes player-message-refresh-spin{to{transform:rotate(360deg)}}.player-messages-friends{min-height:38px;padding:0 13px;border:1px solid #e8c77d35;border-radius:10px;color:#f0d58e;background:#d9ba7510;font:inherit;font-size:11px;cursor:pointer}.player-messages-friends span{margin-left:5px}.player-messages-mobile-tabs{display:none}.player-message-shortcuts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:22px}.player-message-shortcuts>button{display:flex;align-items:center;gap:11px;min-width:0;min-height:76px;padding:12px;border:1px solid #e8c77d26;border-radius:13px;color:#f2ecdc;background:linear-gradient(140deg,#122c26dd,#081a18dd);text-align:left;font:inherit;cursor:pointer}.player-message-shortcut-icon{display:grid;width:38px;height:38px;flex:0 0 38px;place-items:center;border:1px solid #e8c77d30;border-radius:12px;color:#edcf80;background:#d9ba7514;font-size:18px}.player-message-shortcut-icon.is-support{color:#b7d4bb;background:#79a98718;border-color:#9fc8a42c}.player-message-shortcut-icon.is-private{color:#dfbd8a;background:#d2a46516;border-color:#d2a46535}.player-message-shortcuts>button>span:nth-child(2){display:grid;gap:4px;min-width:0}.player-message-shortcuts strong{font-size:12px}.player-message-shortcuts small{overflow:hidden;color:#aebbb0;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.player-message-shortcuts i{margin-left:auto;color:#c9b36f;font-size:20px;font-style:normal}.player-message-recent,.player-message-domain{min-width:0;padding:18px;border:1px solid #e8c77d24;border-radius:16px;background:#071714ad}.player-message-recent>h3{margin:0 0 12px;color:#f0e6cf;font-size:15px}.player-message-empty{display:grid;justify-items:center;gap:9px;min-height:240px;align-content:center;text-align:center;color:#e9e1ce}.player-message-empty>span{display:grid;width:45px;height:45px;place-items:center;border:1px solid #e8c77d38;border-radius:15px;color:#efd184;background:#d9ba7515;font-size:22px}.player-message-empty p{margin:0;color:#b3bcae;font-size:12px;line-height:1.6}.player-message-empty button{min-height:38px;margin-top:5px;padding:0 15px;border:0;border-radius:9px;color:#29251b;background:#e2c578;font:inherit;font-size:12px;font-weight:700;cursor:pointer}
@media(max-width:760px){.player-messages-page{padding:17px 14px calc(100px + env(safe-area-inset-bottom));background:linear-gradient(155deg,rgba(13,33,31,.28),rgba(16,39,35,.22) 55%,rgba(48,39,28,.28))}.player-messages-layout{display:block;min-height:0;margin:0}.player-messages-rail{display:none}.player-messages-content{padding:0 0 16px}.player-messages-heading{margin:2px 2px 14px}.player-messages-heading>div>span{display:none}.player-messages-heading h2{margin:0 0 4px;font-size:25px}.player-messages-heading p{font-size:11px}.player-messages-mobile-tabs{display:flex;gap:7px;overflow-x:auto;margin:0 -14px 15px;padding:2px 14px 8px;scrollbar-width:none}.player-messages-mobile-tabs::-webkit-scrollbar{display:none}.player-messages-mobile-tabs button{flex:1 0 auto;min-height:39px;padding:0 14px;border:1px solid #e8c77d24;border-radius:11px;color:#d4d8cc;background:#091b18;font:inherit;font-size:12px;white-space:nowrap}.player-messages-mobile-tabs button.active{border-color:#e8c77d72;color:#f4d98c;background:#d9ba7522}.player-messages-mobile-tabs button:disabled{opacity:.38}.player-message-shortcuts{grid-template-columns:1fr;gap:8px;margin-bottom:16px}.player-message-shortcuts>button{min-height:62px;padding:10px 12px}.player-message-recent,.player-message-domain{padding:13px 11px;border-radius:14px}.player-message-recent>h3{font-size:14px}.player-messages-friends{min-height:35px;padding:0 10px;font-size:10px}}
@media(min-width:761px) and (max-width:1020px){.player-messages-layout{grid-template-columns:190px minmax(0,1fr);gap:16px}.player-message-shortcuts{gap:7px}.player-message-shortcuts>button{gap:7px;padding:9px}}
@media(prefers-reduced-motion:no-preference){.player-message-shortcuts>button,.player-messages-rail nav button{transition:background .16s ease,border-color .16s ease,transform .16s ease}.player-message-shortcuts>button:hover{transform:translateY(-2px);border-color:#e8c77d58}.player-messages-rail nav button:hover{background:#ffffff0b}}
.player-conversation-route{position:fixed;z-index:35;inset:0;overflow:hidden;color:#f4efdf;background:linear-gradient(160deg,rgba(3,16,14,.94),rgba(7,25,21,.92) 52%,rgba(28,22,16,.94))}
.player-messages-rail,.player-message-shortcuts>button,.player-message-recent,.player-message-domain,.player-messages-mobile-tabs button,.player-messages-friends{background-color:rgba(4,17,14,.6);-webkit-backdrop-filter:blur(4px) saturate(108%);backdrop-filter:blur(4px) saturate(108%)}
.player-message-shortcuts>button{background-image:linear-gradient(140deg,rgba(18,44,38,.62),rgba(4,17,14,.58))}
.player-messages-rail{border-color:#e8c77d55}
.player-message-recent,.player-message-domain{border-color:#e8c77d42}
.player-messages-mobile-tabs button.active{background-color:rgba(76,59,25,.72)}
.player-message-domain-private{padding:0;border:0;border-radius:0;background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none}
.player-message-domain-private :deep(.social-message-list){gap:0}
.player-message-domain-private :deep(.social-chat-choice){min-height:68px;padding:9px 4px;border:0;border-bottom:1px solid #e8c77d20;border-radius:0;background:transparent}
.player-message-domain-private :deep(.social-chat-choice:hover){background:#ffffff08}
.player-message-domain-private :deep(.social-chat-choice .social-friend-avatar){width:42px;height:42px;flex-basis:42px}
.player-message-domain-private :deep(.social-chat-choice-copy){gap:5px}
.player-message-domain-private :deep(.social-chat-choice-copy strong){color:#f1ead9;font-size:12px}
.player-message-domain-private :deep(.social-chat-choice-copy small){font-size:10px}
.player-message-domain-inbox :deep(.notification-item){border-color:#e8c77d30;background:rgba(4,17,14,.72);-webkit-backdrop-filter:blur(5px) saturate(108%);backdrop-filter:blur(5px) saturate(108%)}
.player-message-recent :deep(.notification-item){border-color:#e8c77d30;background:rgba(4,17,14,.72);-webkit-backdrop-filter:blur(5px) saturate(108%);backdrop-filter:blur(5px) saturate(108%)}
.player-message-domain-private :deep(.social-friend-search){background:rgba(4,17,14,.72);-webkit-backdrop-filter:blur(5px) saturate(108%);backdrop-filter:blur(5px) saturate(108%)}
.player-message-domain-private :deep(.social-chat-choice){background:rgba(4,17,14,.62);-webkit-backdrop-filter:blur(5px) saturate(108%);backdrop-filter:blur(5px) saturate(108%)}
.player-message-domain-private :deep(.social-chat-choice:hover){background:rgba(17,35,29,.76)}
</style>
