<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { SocialMessageAttachmentKind, type SocialConversationListResponseDto, type SocialConversationPreviewDto, type SocialFriendDto, type SocialMessageDto, type FriendLookupResponseDto } from '@gameing/contracts/social';
import type { SocialFriendsApplication } from '../platform/social/friends-application';
import { ApiRequestError } from '../platform/http/api-client';

type ChatContact = { userId: string; displayName: string; friendCode: string; state?: SocialFriendDto['state'] | 'STRANGER' };

const props = defineProps<{ application: SocialFriendsApplication; mode: 'friends' | 'messages'; currentUserId: string; initialPeer?: Pick<ChatContact, 'userId' | 'displayName' | 'friendCode'> | undefined; initialConversationId?: string | undefined; fullScreen?: boolean }>();
const emit = defineEmits<{
  openConversation: [conversationId: string];
  openPeerConversation: [peer: { userId: string; displayName: string; friendCode: string; conversationId: string }];
  closeConversation: [];
}>();
const friends = ref<SocialFriendDto[]>([]);
const conversations = ref<SocialConversationListResponseDto>([]);
const ownFriendCode = ref('');
const ownFriendQr = ref('');
const results = ref<FriendLookupResponseDto>([]);
const search = ref('');
const draft = ref('');
const activeFriend = ref<ChatContact | null>(null);
const conversationId = ref('');
const messages = ref<SocialMessageDto[]>([]);
const busy = ref(false);
const error = ref('');
const info = ref('');
const chatPolicy = ref({ peerIsFriend: false, canSend: true, requiresReply: false });
const warmTipOpen = ref(false);
const emojiPickerOpen = ref(false);
const attachmentMenuOpen = ref(false);
const attachmentInput = ref<HTMLInputElement>();
const recording = ref(false);
const recordingSeconds = ref(0);
const messageSearchOpen = ref(false);
const messageSearchQuery = ref('');
const pendingAttachments = ref<{ file: File; previewUrl: string }[]>([]);
const messageAttachmentUrls = ref(new Map<string, string>());
const loadingMessageAttachments = ref(new Set<string>());
let initialPeerOpened = false;
let activeMediaRecorder: MediaRecorder | undefined;
let activeRecordingStream: MediaStream | undefined;
let recordingInterval: ReturnType<typeof setInterval> | undefined;
let recordingChunks: BlobPart[] = [];
let discardVoiceRecording = false;
const removeConfirmationUserId = ref('');
const acceptedFriends = computed(() => friends.value.filter((friend) => friend.state === 'ACCEPTED'));
const activeContactIsFriend = computed(() => activeFriend.value?.state === 'ACCEPTED');
const chatContacts = computed<ChatContact[]>(() => {
  const recent = conversations.value.map((conversation) => ({ userId: conversation.peerUserId, displayName: conversation.peerDisplayName, friendCode: conversation.peerFriendCode, state: conversation.peerIsFriend ? 'ACCEPTED' as const : 'STRANGER' as const }));
  const known = new Set(recent.map((contact) => contact.userId));
  return [...recent, ...acceptedFriends.value.filter((friend) => !known.has(friend.userId))];
});
const visibleMessages = computed(() => {
  const query = messageSearchQuery.value.trim().toLocaleLowerCase();
  if (!query) return messages.value;
  return messages.value.filter((message) =>
    message.body.toLocaleLowerCase().includes(query)
    || (message.attachments ?? []).some((attachment) => attachment.fileName.toLocaleLowerCase().includes(query)),
  );
});

async function loadFriends(): Promise<void> {
  busy.value = true;
  try {
    const [items, profile, chats] = await Promise.all([props.application.listFriends(), props.application.ownProfile(), props.application.listConversations()]);
    friends.value = items; ownFriendCode.value = profile.friendCode; conversations.value = chats;
    const qr = await import('qrcode'); ownFriendQr.value = await qr.toDataURL(`LG-FRIEND:${profile.friendCode}`, { errorCorrectionLevel: 'M', margin: 1, width: 160 });
    if (!initialPeerOpened && props.mode === 'messages' && props.initialConversationId) {
      initialPeerOpened = true;
      const conversation = conversations.value.find((item) => item.conversationId === props.initialConversationId);
      if (conversation) await openConversationPreview(conversation);
      else error.value = '这段会话暂时无法读取，请返回会话列表后重试。';
    } else if (!initialPeerOpened && props.mode === 'messages' && props.initialPeer) {
      initialPeerOpened = true;
      const contact = chatContacts.value.find((item) => item.userId === props.initialPeer!.userId)
        ?? { ...props.initialPeer, state: 'STRANGER' as const };
      await openChat(contact);
    }
  }
  catch { error.value = '好友列表暂时无法读取，请检查连接后重试。'; }
  finally { busy.value = false; }
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

async function openChat(friend: ChatContact, existingConversationId?: string): Promise<void> {
  busy.value = true; error.value = ''; activeFriend.value = friend;
  try {
    const conversation = existingConversationId ? { conversationId: existingConversationId } : await props.application.openConversation(friend.userId);
    conversationId.value = conversation.conversationId;
    const page = await props.application.listMessages(conversation.conversationId);
    messages.value = page.messages; chatPolicy.value = { peerIsFriend: page.peerIsFriend, canSend: page.canSend, requiresReply: page.requiresReply };
    await loadMessageAttachments(page.messages);
    if (props.mode === 'messages') emit('openConversation', conversation.conversationId);
    else emit('openPeerConversation', { userId: friend.userId, displayName: friend.displayName, friendCode: friend.friendCode, conversationId: conversation.conversationId });
  } catch { error.value = '私信暂时无法打开，请稍后重试。'; activeFriend.value = null; }
  finally { busy.value = false; }
}

async function refreshChat(): Promise<void> {
  if (!conversationId.value) return;
  busy.value = true; error.value = '';
  try { const page = await props.application.listMessages(conversationId.value); messages.value = page.messages; chatPolicy.value = { peerIsFriend: page.peerIsFriend, canSend: page.canSend, requiresReply: page.requiresReply }; await loadMessageAttachments(page.messages); }
  catch { error.value = '历史消息暂时无法读取，请检查连接后重试。'; }
  finally { busy.value = false; }
}

async function sendMessage(): Promise<void> {
  if (!conversationId.value || (!draft.value.trim() && !pendingAttachments.value.length) || busy.value || !chatPolicy.value.canSend) return;
  if (pendingAttachments.value.length && !activeContactIsFriend.value) { error.value = '图片、动图、视频和语音仅限好友之间发送。'; return; }
  const isFirstColdMessage = !chatPolicy.value.peerIsFriend && messages.value.length === 0;
  busy.value = true; error.value = '';
  try {
    const attachmentDtos = await Promise.all(pendingAttachments.value.map(({ file }) => props.application.uploadAttachment(file, activeFriend.value!.userId)));
    const message = await props.application.sendMessage(conversationId.value, { clientMessageId: crypto.randomUUID(), body: draft.value, ...(attachmentDtos.length ? { attachments: attachmentDtos } : {}) });
    messages.value = [...messages.value, message]; draft.value = '';
    clearPendingAttachments();
    const page = await props.application.listMessages(conversationId.value);
    chatPolicy.value = { peerIsFriend: page.peerIsFriend, canSend: page.canSend, requiresReply: page.requiresReply };
    messages.value = page.messages;
    await loadMessageAttachments(page.messages);
    conversations.value = await props.application.listConversations();
    if (isFirstColdMessage) warmTipOpen.value = true;
  } catch (cause) {
    error.value = cause instanceof ApiRequestError && cause.code === 'SOCIAL_FIRST_CONTACT_WAITING_FOR_REPLY'
      ? '对方回复前暂时不能再发消息，请耐心等待。'
      : cause instanceof Error && cause.message === 'SOCIAL_ATTACHMENT_FRIENDS_ONLY'
        ? '图片、动图、视频和语音仅限好友之间发送。'
        : cause instanceof Error && cause.message.startsWith('SOCIAL_ATTACHMENT_')
          ? '附件格式或内容校验未通过，请重新选择文件。'
        : '消息没有发送，请保留内容后重试。';
  }
  finally { busy.value = false; }
}

async function openConversationPreview(conversation: SocialConversationPreviewDto): Promise<void> {
  await openChat({ userId: conversation.peerUserId, displayName: conversation.peerDisplayName, friendCode: conversation.peerFriendCode, state: conversation.peerIsFriend ? 'ACCEPTED' : 'STRANGER' }, conversation.conversationId);
}

function handleAttachmentSelection(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length) return;
  const total = pendingAttachments.value.length + files.length;
  if (total > 4) { error.value = '一条消息最多添加 4 个附件。'; return; }
  const invalid = files.find((file) => !/^(image\/(jpeg|png|webp|avif|gif)|video\/(mp4|webm)|audio\/(mp4|webm|ogg))(;.*)?$/i.test(file.type) || file.size < 1 || file.size > 50 * 1024 * 1024);
  if (invalid) { error.value = '支持 JPG、PNG、WebP、AVIF、GIF、MP4、WebM 和语音音频；单个附件最大 50 MB。'; return; }
  error.value = '';
  pendingAttachments.value = [...pendingAttachments.value, ...files.map((file) => ({ file, previewUrl: URL.createObjectURL(file) }))];
}

function openMediaPicker(): void {
  attachmentMenuOpen.value = false;
  attachmentInput.value?.click();
}

function clearRecordingTimer(): void {
  if (recordingInterval) clearInterval(recordingInterval);
  recordingInterval = undefined;
}

function stopVoiceRecording(discard = false): void {
  if (!activeMediaRecorder) return;
  discardVoiceRecording = discard;
  clearRecordingTimer();
  if (activeMediaRecorder.state !== 'inactive') activeMediaRecorder.stop();
}

async function startVoiceRecording(): Promise<void> {
  attachmentMenuOpen.value = false;
  if (!activeContactIsFriend.value || !chatPolicy.value.canSend) { error.value = '语音消息仅限可发送消息的好友会话。'; return; }
  if (pendingAttachments.value.length >= 4) { error.value = '一条消息最多添加 4 个附件。'; return; }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { error.value = '当前浏览器不支持语音录制。'; return; }
  error.value = '';
  try {
    activeRecordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type));
    activeMediaRecorder = mimeType ? new MediaRecorder(activeRecordingStream, { mimeType }) : new MediaRecorder(activeRecordingStream);
    recordingChunks = [];
    discardVoiceRecording = false;
    recordingSeconds.value = 0;
    activeMediaRecorder.ondataavailable = (event) => { if (event.data.size > 0) recordingChunks.push(event.data); };
    activeMediaRecorder.onerror = () => { error.value = '录音失败，请检查麦克风权限后重试。'; stopVoiceRecording(true); };
    activeMediaRecorder.onstop = () => {
      const recorder = activeMediaRecorder;
      activeMediaRecorder = undefined;
      activeRecordingStream?.getTracks().forEach((track) => track.stop());
      activeRecordingStream = undefined;
      recording.value = false;
      if (!recorder || discardVoiceRecording || !recordingChunks.length) { recordingChunks = []; return; }
      const recordedChunk = recordingChunks.find((chunk): chunk is Blob => chunk instanceof Blob && Boolean(chunk.type));
      const recordedType = (recorder.mimeType || recordedChunk?.type || 'audio/webm').split(';', 1)[0] || 'audio/webm';
      const extension = recordedType === 'audio/mp4' ? 'm4a' : recordedType === 'audio/ogg' ? 'ogg' : 'webm';
      const file = new File(recordingChunks, `voice-message-${Date.now()}.${extension}`, { type: recordedType });
      recordingChunks = [];
      if (file.size < 1 || file.size > 50 * 1024 * 1024) { error.value = '语音文件为空或超过 50 MB，请重新录制。'; return; }
      pendingAttachments.value = [...pendingAttachments.value, { file, previewUrl: URL.createObjectURL(file) }];
    };
    activeMediaRecorder.start(500);
    recording.value = true;
    recordingInterval = setInterval(() => {
      recordingSeconds.value += 1;
      if (recordingSeconds.value >= 180) stopVoiceRecording();
    }, 1000);
  } catch {
    activeRecordingStream?.getTracks().forEach((track) => track.stop());
    activeRecordingStream = undefined;
    activeMediaRecorder = undefined;
    recording.value = false;
    error.value = '无法访问麦克风，请允许麦克风权限后重试。';
  }
}

function toggleMessageSearch(): void {
  messageSearchOpen.value = !messageSearchOpen.value;
  if (!messageSearchOpen.value) messageSearchQuery.value = '';
}

function clearPendingAttachments(): void {
  pendingAttachments.value.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
  pendingAttachments.value = [];
}

function removePendingAttachment(index: number): void {
  const [removed] = pendingAttachments.value.splice(index, 1);
  if (removed) URL.revokeObjectURL(removed.previewUrl);
}

function appendEmoji(emoji: string): void {
  draft.value = `${draft.value}${emoji}`;
  emojiPickerOpen.value = false;
}

function attachmentUrl(message: SocialMessageDto, assetId: string): string | undefined {
  return messageAttachmentUrls.value.get(`${message.messageId}:${assetId}`);
}

async function loadMessageAttachments(items: SocialMessageDto[]): Promise<void> {
  const recent = items.slice(-5).flatMap((message) => (message.attachments ?? []).map((attachment) => loadMessageAttachment(message, attachment.assetId)));
  await Promise.all(recent);
}

async function loadMessageAttachment(message: SocialMessageDto, assetId: string): Promise<void> {
  const key = `${message.messageId}:${assetId}`;
  if (messageAttachmentUrls.value.has(key) || loadingMessageAttachments.value.has(key)) return;
  loadingMessageAttachments.value = new Set(loadingMessageAttachments.value).add(key);
  try {
    const blob = await props.application.openAttachment(assetId, props.currentUserId);
    const next = new Map(messageAttachmentUrls.value).set(key, URL.createObjectURL(blob));
    messageAttachmentUrls.value = next;
  } catch { /* The attachment row remains visible and can be retried on demand. */ }
  finally {
    const next = new Set(loadingMessageAttachments.value);
    next.delete(key);
    loadingMessageAttachments.value = next;
  }
}

function closeConversation(): void {
  if (props.mode === 'messages' && props.fullScreen) emit('closeConversation');
  else { activeFriend.value = null; conversationId.value = ''; void loadFriends(); }
}

async function refresh(): Promise<void> {
  if (activeFriend.value && conversationId.value) await refreshChat();
  else await loadFriends();
}

watch(() => props.mode, () => { stopVoiceRecording(true); activeFriend.value = null; conversationId.value = ''; messages.value = []; error.value = ''; messageSearchOpen.value = false; messageSearchQuery.value = ''; });
watch(() => props.initialConversationId, (routeConversationId) => {
  if (routeConversationId) { initialPeerOpened = false; void loadFriends(); }
  else if (props.fullScreen) { stopVoiceRecording(true); activeFriend.value = null; conversationId.value = ''; messages.value = []; }
});
watch(() => props.currentUserId, () => {
  friends.value = []; conversations.value = []; results.value = []; activeFriend.value = null; conversationId.value = ''; messages.value = []; ownFriendCode.value = ''; ownFriendQr.value = ''; error.value = '';
  void loadFriends();
});
onMounted(() => { void loadFriends(); });
onBeforeUnmount(() => {
  stopVoiceRecording(true);
  clearRecordingTimer();
  clearPendingAttachments();
  for (const url of messageAttachmentUrls.value.values()) URL.revokeObjectURL(url);
});
defineExpose({ refresh });
</script>

<template>
  <section class="social-friends-workspace" :class="{ 'social-message-fullscreen': fullScreen }" :aria-label="mode === 'friends' ? '好友管理' : '好友私信'">
    <template v-if="mode === 'friends'">
      <div v-if="ownFriendCode" class="social-own-friend-code"><img :src="ownFriendQr" alt="好友码二维码" /><div><strong>我的好友码</strong><code>{{ ownFriendCode }}</code><small>好友可扫码或输入好友码添加你</small></div></div>
      <form class="social-friend-search" @submit.prevent="findFriends">
        <label for="social-friend-search">查找牌友</label>
        <div><input id="social-friend-search" v-model="search" maxlength="64" autocomplete="off" placeholder="输入好友码或完整用户名" /><button class="panel-primary" type="submit" :disabled="busy">查找</button></div>
        <small>好友码可从账号资料中分享；只支持精确用户名查找。</small>
      </form>
      <p v-if="info" class="social-inline-success" role="status">{{ info }}</p>
      <div v-if="results.length" class="social-friend-results" aria-label="查找结果"><article v-for="person in results" :key="person.userId"><span class="social-friend-avatar">{{ person.displayName.slice(-1) }}</span><div><strong>{{ person.displayName }}</strong><small>好友码 {{ person.friendCode }}</small></div><button type="button" :disabled="busy" @click="requestFriend(person.userId)">加好友</button><button class="social-secondary-action" type="button" :disabled="busy" @click="openChat(person)">发消息</button></article></div>
      <p v-if="error" class="social-workspace-error" role="alert">{{ error }} <button type="button" @click="loadFriends">重试</button></p>
      <div class="social-friend-list"><header><h3>好友与申请 <span>{{ friends.length }}</span></h3><button type="button" :disabled="busy" @click="loadFriends">刷新</button></header>
        <article v-for="friend in friends" :key="friend.userId" class="social-friend-row"><span class="social-friend-avatar">{{ friend.displayName.slice(-1) }}</span><div><strong>{{ friend.displayName }}</strong><small>{{ friend.state === 'ACCEPTED' ? `好友码 ${friend.friendCode}` : friend.state === 'PENDING_INCOMING' ? '等待你处理' : '等待对方通过' }}</small><small v-if="removeConfirmationUserId === friend.userId" class="social-remove-confirm">删除好友后，双方将不能继续私信。</small></div><button v-if="friend.state === 'PENDING_INCOMING'" type="button" :disabled="busy" @click="acceptFriend(friend.userId)">通过</button><button v-if="friend.state === 'PENDING_INCOMING'" class="social-secondary-action" type="button" :disabled="busy" @click="rejectFriend(friend.userId)">拒绝</button><button v-else-if="friend.state === 'ACCEPTED'" type="button" @click="openChat(friend)">发消息</button><template v-if="friend.state === 'ACCEPTED'"><button v-if="removeConfirmationUserId !== friend.userId" class="social-secondary-action" type="button" @click="removeConfirmationUserId = friend.userId">删除</button><template v-else><button type="button" :disabled="busy" @click="removeFriend(friend.userId)">确认删除</button><button class="social-secondary-action" type="button" @click="removeConfirmationUserId = ''">取消</button></template></template><span v-if="friend.state === 'PENDING_OUTGOING'" class="social-pending-label">已申请</span></article>
        <p v-if="!friends.length" class="social-friends-empty">还没有好友。可以用好友码或用户名查找牌友。</p>
      </div>
    </template>
    <template v-else>
      <div v-if="fullScreen && !activeFriend" class="social-message-loading" role="status"><span>{{ busy ? '正在打开会话…' : error || '正在读取这段会话…' }}</span><button v-if="!busy && error" type="button" @click="loadFriends">重试</button></div>
      <div v-else-if="!activeFriend" class="social-message-list"><h3>最近会话</h3>
        <form class="social-friend-search social-message-search" @submit.prevent="findFriends"><label for="social-message-search">查找牌友并发起私信</label><div><input id="social-message-search" v-model="search" maxlength="64" autocomplete="off" placeholder="好友码或完整用户名" /><button class="panel-primary" type="submit" :disabled="busy">查找</button></div><small>陌生人每天只能先发一条开场消息，对方回复后当天可继续交流。</small></form>
        <div v-if="results.length" class="social-friend-results" aria-label="私信查找结果"><article v-for="person in results" :key="person.userId"><span class="social-friend-avatar">{{ person.displayName.slice(-1) }}</span><div><strong>{{ person.displayName }}</strong><small>好友码 {{ person.friendCode }}</small></div><button type="button" :disabled="busy" @click="openChat(person)">发消息</button><button class="social-secondary-action" type="button" :disabled="busy" @click="requestFriend(person.userId)">加好友</button></article></div>
        <button v-for="contact in chatContacts" :key="contact.userId" class="social-chat-choice" type="button" @click="openChat(contact)"><span class="social-friend-avatar">{{ contact.displayName.slice(-1) }}</span><span class="social-chat-choice-copy"><strong>{{ contact.displayName }}</strong><small>{{ contact.state === 'ACCEPTED' ? '好友' : '陌生人 · 回复前限发一条' }}<template v-if="conversations.find((item) => item.peerUserId === contact.userId)?.lastMessage"> · {{ conversations.find((item) => item.peerUserId === contact.userId)?.lastMessage }}</template></small></span><span>›</span></button>
        <p v-if="!chatContacts.length" class="social-friends-empty">查找好友码或用户名，可以发起一对一私信。</p></div>
      <section v-else class="social-chat-panel" :class="{ 'social-chat-panel-fullscreen': fullScreen }" :aria-label="`与${activeFriend.displayName}的私信`">
        <header class="social-chat-header"><button class="social-chat-back" type="button" @click="closeConversation">‹ <span>{{ fullScreen ? '返回' : '会话列表' }}</span></button><span class="social-friend-avatar">{{ activeFriend.displayName.slice(-1) }}</span><strong>{{ activeFriend.displayName }}<small>{{ activeContactIsFriend ? '好友' : '陌生人' }}</small></strong><button class="social-chat-search" type="button" :aria-expanded="messageSearchOpen" aria-label="搜索聊天消息" title="搜索当前已加载的消息" @click="toggleMessageSearch"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 5 5"/></svg></button></header>
        <div class="social-chat-messages" aria-live="polite">
          <form v-if="messageSearchOpen" class="social-chat-search-bar" role="search" @submit.prevent>
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 5 5"/></svg>
            <input v-model="messageSearchQuery" type="search" aria-label="搜索当前已加载的消息" placeholder="搜索当前已加载的消息" />
            <button type="button" aria-label="关闭搜索" @click="toggleMessageSearch">×</button>
          </form>
          <div v-if="!activeContactIsFriend" class="social-cold-contact-policy" role="note">陌生人每天先发一条文字开场消息；对方回复后，当天双方可继续发文字。图片、动图、视频和语音仅限好友之间发送。</div>
          <p v-if="!messages.length" class="social-friends-empty">发送第一条消息，开始交流。</p>
          <p v-else-if="messageSearchQuery && !visibleMessages.length" class="social-friends-empty">没有找到匹配的已加载消息。</p>
          <article v-for="message in visibleMessages" :key="message.messageId" :class="{ own: message.senderUserId === currentUserId }">
            <p v-if="message.body">{{ message.body }}</p>
            <div v-if="message.attachments?.length" class="social-message-attachments">
              <template v-for="attachment in message.attachments" :key="attachment.assetId">
                <img v-if="attachment.kind === SocialMessageAttachmentKind.IMAGE && attachmentUrl(message, attachment.assetId)" :src="attachmentUrl(message, attachment.assetId)" :alt="attachment.fileName" loading="lazy"/>
                <video v-else-if="attachment.kind === SocialMessageAttachmentKind.VIDEO && attachmentUrl(message, attachment.assetId)" :src="attachmentUrl(message, attachment.assetId)" controls playsinline preload="metadata"/>
                <audio v-else-if="attachment.kind === SocialMessageAttachmentKind.AUDIO && attachmentUrl(message, attachment.assetId)" :src="attachmentUrl(message, attachment.assetId)" controls preload="metadata" aria-label="语音消息"/>
                <button v-else class="social-attachment-load" type="button" :disabled="loadingMessageAttachments.has(`${message.messageId}:${attachment.assetId}`)" @click="loadMessageAttachment(message, attachment.assetId)">{{ loadingMessageAttachments.has(`${message.messageId}:${attachment.assetId}`) ? '正在解密…' : `查看附件 · ${attachment.fileName}` }}</button>
              </template>
            </div>
            <time>{{ new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt)) }}</time>
          </article>
        </div>
        <div v-if="pendingAttachments.length" class="social-message-pending-attachments" aria-label="待发送附件"><article v-for="(attachment, index) in pendingAttachments" :key="attachment.previewUrl"><img v-if="attachment.file.type.startsWith('image/')" :src="attachment.previewUrl" :alt="attachment.file.name"/><video v-else-if="attachment.file.type.startsWith('video/')" :src="attachment.previewUrl" muted playsinline/><audio v-else :src="attachment.previewUrl" controls preload="metadata" :aria-label="`预览 ${attachment.file.name}`"/><span>{{ attachment.file.name }}</span><button type="button" :aria-label="`移除 ${attachment.file.name}`" @click="removePendingAttachment(index)">×</button></article></div>
        <p v-if="chatPolicy.requiresReply" class="social-inline-success">你已收到一条陌生人消息，可以回复一次；回复后当天即可继续交流。</p>
        <p v-if="error" class="social-workspace-error" role="alert">{{ error }}</p>
        <form class="social-chat-compose" @submit.prevent="sendMessage">
          <div v-if="attachmentMenuOpen" class="social-attachment-menu" role="menu" aria-label="选择消息类型">
            <button type="button" role="menuitem" @click="openMediaPicker"><span aria-hidden="true">▧</span><span><strong>照片、动图或视频</strong><small>从设备中选择媒体</small></span></button>
            <button type="button" role="menuitem" :disabled="!activeContactIsFriend || !chatPolicy.canSend" @click="startVoiceRecording"><span aria-hidden="true">♫</span><span><strong>语音消息</strong><small>录制并预览后发送</small></span></button>
          </div>
          <div class="social-chat-tools">
            <button class="social-chat-tool-button" type="button" aria-label="表情" :disabled="!chatPolicy.canSend" @click="emojiPickerOpen = !emojiPickerOpen"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.2s1.2 2 3.5 2 3.5-2 3.5-2M9 9.5h.01M15 9.5h.01"/></svg></button>
            <button class="social-chat-tool-button social-attachment-trigger" type="button" aria-label="添加附件" title="添加附件" :disabled="!activeContactIsFriend || !chatPolicy.canSend" @click="attachmentMenuOpen = !attachmentMenuOpen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
            <input ref="attachmentInput" class="social-chat-file-input" type="file" accept="image/jpeg,image/png,image/webp,image/avif,image/gif,video/mp4,video/webm" multiple :disabled="!activeContactIsFriend || !chatPolicy.canSend" @change="handleAttachmentSelection" />
          </div>
          <div v-if="emojiPickerOpen" class="social-emoji-picker" aria-label="选择表情"><button v-for="emoji in ['😀','😊','😂','🥰','👍','🎉','❤️','🤝','🀄','✨','🙏','😅']" :key="emoji" type="button" @click="appendEmoji(emoji)">{{ emoji }}</button></div>
          <div v-if="recording" class="social-voice-recording" role="status"><span><i aria-hidden="true"></i>录音中 {{ Math.floor(recordingSeconds / 60).toString().padStart(2, '0') }}:{{ (recordingSeconds % 60).toString().padStart(2, '0') }} / 03:00</span><button type="button" @click="stopVoiceRecording()">完成语音</button><button type="button" @click="stopVoiceRecording(true)">取消</button></div>
          <textarea v-else v-model="draft" rows="1" maxlength="2000" placeholder="发送文字消息…" aria-label="消息内容" :disabled="!chatPolicy.canSend"/>
          <button class="social-send-message" type="submit" :disabled="busy || recording || (!draft.trim() && !pendingAttachments.length) || !chatPolicy.canSend">{{ busy ? '发送中…' : '发送' }}</button>
        </form>
      </section>
      <p v-if="error && !activeFriend" class="social-workspace-error" role="alert">{{ error }}</p>
    </template>
    <div v-if="warmTipOpen" class="social-message-rules-overlay" role="presentation" @click.self="warmTipOpen = false"><section role="dialog" aria-modal="true" aria-labelledby="social-message-rules-title"><span class="social-rules-mark" aria-hidden="true">✦</span><h3 id="social-message-rules-title">私信小提醒</h3><p>陌生人每天只能先发送一条开场消息；对方回复后，当天双方可以继续交流。图片、动图、视频和语音仅限好友之间发送。请勿分享密码、验证码、收款凭证或其他敏感信息。</p><button type="button" @click="warmTipOpen = false">我知道了</button></section></div>
  </section>
</template>
