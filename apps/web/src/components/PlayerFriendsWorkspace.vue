<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { SocialFriendDto, SocialMessageDto, FriendLookupResponseDto } from '@gameing/contracts/social';
import type { SocialFriendsApplication } from '../platform/social/friends-application';

const props = defineProps<{ application: SocialFriendsApplication; mode: 'friends' | 'messages'; currentUserId: string }>();
const friends = ref<SocialFriendDto[]>([]);
const ownFriendCode = ref('');
const ownFriendQr = ref('');
const results = ref<FriendLookupResponseDto>([]);
const search = ref('');
const draft = ref('');
const activeFriend = ref<SocialFriendDto | null>(null);
const conversationId = ref('');
const messages = ref<SocialMessageDto[]>([]);
const busy = ref(false);
const error = ref('');
const info = ref('');
const removeConfirmationUserId = ref('');
const acceptedFriends = computed(() => friends.value.filter((friend) => friend.state === 'ACCEPTED'));

async function loadFriends(): Promise<void> {
  try {
    const [items, profile] = await Promise.all([props.application.listFriends(), props.application.ownProfile()]);
    friends.value = items; ownFriendCode.value = profile.friendCode;
    const qr = await import('qrcode'); ownFriendQr.value = await qr.toDataURL(`LG-FRIEND:${profile.friendCode}`, { errorCorrectionLevel: 'M', margin: 1, width: 160 });
  }
  catch { error.value = '好友列表暂时无法读取，请检查连接后重试。'; }
}

async function findFriends(): Promise<void> {
  error.value = ''; info.value = ''; results.value = [];
  const value = search.value.trim().replace(/^LG-FRIEND:/i, '');
  if (value.length < 3) { error.value = '请输入至少 3 位好友码或完整用户名。'; return; }
  busy.value = true;
  try {
    results.value = await props.application.lookup(value);
    if (!results.value.length) info.value = '没有找到匹配的好友码或用户名。';
  } catch { error.value = '查找失败，请稍后重试。'; }
  finally { busy.value = false; }
}

async function requestFriend(userId: string): Promise<void> {
  busy.value = true; error.value = ''; info.value = '';
  try {
    const result = await props.application.requestFriend(userId);
    info.value = result.accepted ? '你们已经是好友。' : '好友申请已发送。';
    await loadFriends();
  } catch { error.value = '好友申请没有发送，请重试。'; }
  finally { busy.value = false; }
}

async function acceptFriend(userId: string): Promise<void> {
  busy.value = true; error.value = '';
  try { await props.application.acceptFriend(userId); await loadFriends(); }
  catch { error.value = '这条好友申请已失效，请刷新列表。'; }
  finally { busy.value = false; }
}

async function rejectFriend(userId: string): Promise<void> {
  busy.value = true; error.value = '';
  try { await props.application.rejectFriend(userId); await loadFriends(); }
  catch { error.value = '这条好友申请已失效，请刷新列表。'; }
  finally { busy.value = false; }
}

async function removeFriend(userId: string): Promise<void> {
  busy.value = true; error.value = '';
  try { await props.application.removeFriend(userId); removeConfirmationUserId.value = ''; await loadFriends(); }
  catch { error.value = '好友关系暂时无法删除，请重试。'; }
  finally { busy.value = false; }
}

async function openChat(friend: SocialFriendDto): Promise<void> {
  busy.value = true; error.value = ''; activeFriend.value = friend;
  try {
    const conversation = await props.application.openConversation(friend.userId);
    conversationId.value = conversation.conversationId;
    const page = await props.application.listMessages(conversation.conversationId);
    messages.value = page.messages;
  } catch { error.value = '私信暂时无法打开，请稍后重试。'; activeFriend.value = null; }
  finally { busy.value = false; }
}

async function refreshChat(): Promise<void> {
  if (!conversationId.value) return;
  busy.value = true; error.value = '';
  try { messages.value = (await props.application.listMessages(conversationId.value)).messages; }
  catch { error.value = '历史消息暂时无法读取，请检查连接后重试。'; }
  finally { busy.value = false; }
}

async function sendMessage(): Promise<void> {
  if (!conversationId.value || !draft.value.trim() || busy.value) return;
  busy.value = true; error.value = '';
  try {
    const message = await props.application.sendMessage(conversationId.value, { clientMessageId: crypto.randomUUID(), body: draft.value });
    messages.value = [...messages.value, message]; draft.value = '';
  } catch { error.value = '消息没有发送，请保留内容后重试。'; }
  finally { busy.value = false; }
}

watch(() => props.mode, () => { activeFriend.value = null; conversationId.value = ''; messages.value = []; error.value = ''; });
watch(() => props.currentUserId, () => {
  friends.value = []; results.value = []; activeFriend.value = null; conversationId.value = ''; messages.value = []; ownFriendCode.value = ''; ownFriendQr.value = ''; error.value = '';
  void loadFriends();
});
onMounted(() => { void loadFriends(); });
</script>

<template>
  <section class="social-friends-workspace" :aria-label="mode === 'friends' ? '好友管理' : '好友私信'">
    <template v-if="mode === 'friends'">
      <div v-if="ownFriendCode" class="social-own-friend-code"><img :src="ownFriendQr" alt="好友码二维码" /><div><strong>我的好友码</strong><code>{{ ownFriendCode }}</code><small>好友可扫码或输入好友码添加你</small></div></div>
      <form class="social-friend-search" @submit.prevent="findFriends">
        <label for="social-friend-search">查找牌友</label>
        <div><input id="social-friend-search" v-model="search" maxlength="64" autocomplete="off" placeholder="输入好友码或完整用户名" /><button class="panel-primary" type="submit" :disabled="busy">查找</button></div>
        <small>好友码可从账号资料中分享；只支持精确用户名查找。</small>
      </form>
      <p v-if="info" class="social-inline-success" role="status">{{ info }}</p>
      <div v-if="results.length" class="social-friend-results" aria-label="查找结果"><article v-for="person in results" :key="person.userId"><span class="social-friend-avatar">{{ person.displayName.slice(-1) }}</span><div><strong>{{ person.displayName }}</strong><small>好友码 {{ person.friendCode }}</small></div><button type="button" :disabled="busy" @click="requestFriend(person.userId)">加好友</button></article></div>
      <p v-if="error" class="social-workspace-error" role="alert">{{ error }} <button type="button" @click="loadFriends">重试</button></p>
      <div class="social-friend-list"><header><h3>好友与申请 <span>{{ friends.length }}</span></h3><button type="button" :disabled="busy" @click="loadFriends">刷新</button></header>
        <article v-for="friend in friends" :key="friend.userId" class="social-friend-row"><span class="social-friend-avatar">{{ friend.displayName.slice(-1) }}</span><div><strong>{{ friend.displayName }}</strong><small>{{ friend.state === 'ACCEPTED' ? `好友码 ${friend.friendCode}` : friend.state === 'PENDING_INCOMING' ? '等待你处理' : '等待对方通过' }}</small><small v-if="removeConfirmationUserId === friend.userId" class="social-remove-confirm">删除好友后，双方将不能继续私信。</small></div><button v-if="friend.state === 'PENDING_INCOMING'" type="button" :disabled="busy" @click="acceptFriend(friend.userId)">通过</button><button v-if="friend.state === 'PENDING_INCOMING'" class="social-secondary-action" type="button" :disabled="busy" @click="rejectFriend(friend.userId)">拒绝</button><button v-else-if="friend.state === 'ACCEPTED'" type="button" @click="openChat(friend)">发消息</button><template v-if="friend.state === 'ACCEPTED'"><button v-if="removeConfirmationUserId !== friend.userId" class="social-secondary-action" type="button" @click="removeConfirmationUserId = friend.userId">删除</button><template v-else><button type="button" :disabled="busy" @click="removeFriend(friend.userId)">确认删除</button><button class="social-secondary-action" type="button" @click="removeConfirmationUserId = ''">取消</button></template></template><span v-if="friend.state === 'PENDING_OUTGOING'" class="social-pending-label">已申请</span></article>
        <p v-if="!friends.length" class="social-friends-empty">还没有好友。可以用好友码或用户名查找牌友。</p>
      </div>
    </template>
    <template v-else>
      <div v-if="!activeFriend" class="social-message-list"><h3>选择好友</h3><button v-for="friend in acceptedFriends" :key="friend.userId" class="social-chat-choice" type="button" @click="openChat(friend)"><span class="social-friend-avatar">{{ friend.displayName.slice(-1) }}</span><strong>{{ friend.displayName }}</strong><span>›</span></button><p v-if="!acceptedFriends.length" class="social-friends-empty">通过好友申请后，就可以在这里私信。</p></div>
      <section v-else class="social-chat-panel" :aria-label="`与${activeFriend.displayName}的私信`"><header><button type="button" @click="activeFriend = null; conversationId = ''">‹ 好友列表</button><strong>{{ activeFriend.displayName }}</strong><button class="social-chat-refresh" type="button" :disabled="busy" @click="refreshChat">刷新消息</button></header><div class="social-chat-messages" aria-live="polite"><p v-if="!messages.length" class="social-friends-empty">发送第一条消息，开始交流。</p><article v-for="message in messages" :key="message.messageId" :class="{ own: message.senderUserId === currentUserId }"><p>{{ message.body }}</p><time>{{ new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt)) }}</time></article></div><form class="social-chat-compose" @submit.prevent="sendMessage"><textarea v-model="draft" rows="2" maxlength="2000" placeholder="发送文字消息…" aria-label="消息内容"></textarea><button class="panel-primary" type="submit" :disabled="busy || !draft.trim()">发送</button></form></section>
      <p v-if="error" class="social-workspace-error" role="alert">{{ error }}</p>
    </template>
  </section>
</template>
