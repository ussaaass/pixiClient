<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { SupportCategoryType, SupportConversationStatus, type CreateSupportConversationRequestDto, type SupportConversationDto, type SupportMessageDto } from '@gameing/contracts/support';
import type { SupportClientApplication } from '../platform/support/support-application';

const props = defineProps<{ application: SupportClientApplication }>();
const categories = [
  { id: SupportCategoryType.ACCOUNT, label: '账号与安全' },
  { id: SupportCategoryType.PAYMENT, label: '充值与支付' },
  { id: SupportCategoryType.WITHDRAWAL, label: '提现问题' },
  { id: SupportCategoryType.GAME, label: '游戏问题' },
  { id: SupportCategoryType.OTHER, label: '其他问题' },
] as const;
const conversations = ref<SupportConversationDto[]>([]);
const activeConversation = ref<SupportConversationDto>();
const messages = ref<SupportMessageDto[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const composeOpen = ref(false);
const categoryType = ref<number>(SupportCategoryType.ACCOUNT);
const subject = ref('');
const firstMessage = ref('');
const replyDraft = ref('');
const closeConfirmOpen = ref(false);
let pendingCreate: { signature: string; key: string } | undefined;
let pendingReply: { signature: string; key: string } | undefined;

const categoryLabel = (value: number) => categories.find((item) => item.id === value)?.label ?? '客服咨询';
const statusLabel = (value: number) => value === SupportConversationStatus.CLOSED ? '已关闭' : value === SupportConversationStatus.WAITING_USER ? '等待你回复' : '等待客服回复';

async function loadConversations(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await props.application.listConversations();
    if (!result.ok) { error.value = '会话列表暂时无法读取，请重试。'; return; }
    conversations.value = result.value;
  } catch { error.value = '会话列表暂时无法读取，请重试。'; }
  finally { loading.value = false; }
}

async function openConversation(conversation: SupportConversationDto): Promise<void> {
  activeConversation.value = conversation;
  messages.value = [];
  loading.value = true;
  error.value = '';
  try {
    const result = await props.application.listMessages(conversation.conversationId);
    if (!result.ok) { error.value = result.code === 'CONVERSATION_NOT_FOUND' ? '会话已不可用。' : '消息暂时无法读取，请重试。'; return; }
    activeConversation.value = result.value.conversation;
    messages.value = result.value.messages;
  } catch { error.value = '消息暂时无法读取，请重试。'; }
  finally { loading.value = false; }
}

function createRequest(): CreateSupportConversationRequestDto {
  const signature = JSON.stringify([categoryType.value, subject.value.trim(), firstMessage.value.trim()]);
  if (!pendingCreate || pendingCreate.signature !== signature) pendingCreate = { signature, key: crypto.randomUUID() };
  return { categoryType: categoryType.value as CreateSupportConversationRequestDto['categoryType'], subject: subject.value.trim(), bodyText: firstMessage.value.trim(), messageKey: pendingCreate.key };
}

async function submitConversation(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const result = await props.application.createConversation(createRequest());
    if (!result.ok) { error.value = '请检查问题分类、标题和描述后重试。'; return; }
    pendingCreate = undefined;
    activeConversation.value = result.value.conversation;
    messages.value = [result.value.firstMessage];
    conversations.value = [result.value.conversation, ...conversations.value];
    composeOpen.value = false;
    subject.value = '';
    firstMessage.value = '';
  } catch { error.value = '提交没有得到确认。保留内容后重试即可，不会重复创建会话。'; }
  finally { saving.value = false; }
}

async function submitReply(): Promise<void> {
  if (!activeConversation.value || saving.value) return;
  saving.value = true;
  error.value = '';
  const conversationId = activeConversation.value.conversationId;
  const text = replyDraft.value.trim();
  const signature = JSON.stringify([conversationId, text]);
  if (!pendingReply || pendingReply.signature !== signature) pendingReply = { signature, key: crypto.randomUUID() };
  try {
    const result = await props.application.sendMessage(conversationId, { bodyText: text, messageKey: pendingReply.key });
    if (!result.ok) {
      error.value = result.code === 'CONVERSATION_CLOSED' ? '这个会话已关闭，请新建一个会话继续咨询。' : '消息未发送，请检查内容后重试。';
      return;
    }
    pendingReply = undefined;
    messages.value = [...messages.value, result.value];
    replyDraft.value = '';
    await loadConversations();
    const updated = conversations.value.find((item) => item.conversationId === conversationId);
    if (updated) activeConversation.value = updated;
  } catch { error.value = '发送状态尚未确认。保留内容后重试会复用同一发送编号。'; }
  finally { saving.value = false; }
}

async function closeConversation(): Promise<void> {
  if (!activeConversation.value || saving.value) return;
  saving.value = true;
  error.value = '';
  const id = activeConversation.value.conversationId;
  try {
    const result = await props.application.closeConversation(id);
    if (!result.ok) { error.value = '会话状态未更新，请重试。'; return; }
    activeConversation.value = result.value;
    conversations.value = conversations.value.map((item) => item.conversationId === id ? result.value : item);
    closeConfirmOpen.value = false;
  } catch { error.value = '关闭状态尚未确认，请重试。'; }
  finally { saving.value = false; }
}

function backToList(): void {
  activeConversation.value = undefined;
  messages.value = [];
  closeConfirmOpen.value = false;
  error.value = '';
  void loadConversations();
}

onMounted(() => { void loadConversations(); });
</script>

<template>
  <section class="support-workspace" aria-label="客服会话">
    <template v-if="activeConversation">
      <header class="support-detail-header">
        <button type="button" class="support-back" @click="backToList">‹ 会话列表</button>
        <div><strong>{{ activeConversation.subject }}</strong><small>{{ categoryLabel(activeConversation.categoryType) }} · {{ statusLabel(activeConversation.status) }}</small></div>
        <button v-if="activeConversation.status !== SupportConversationStatus.CLOSED" type="button" :disabled="saving" @click="closeConfirmOpen = true">结束会话</button>
      </header>
      <section v-if="closeConfirmOpen" class="support-close-confirm" role="alertdialog" aria-label="确认结束客服会话"><p>结束后会保留历史，但不能继续发送消息。需要继续处理时可以新建会话。</p><div><button type="button" :disabled="saving" @click="closeConfirmOpen = false">继续会话</button><button class="support-primary" type="button" :disabled="saving" @click="closeConversation">确认结束</button></div></section>
      <p class="support-system-note">请勿在客服消息中发送密码、验证码或 TOTP 密钥。账号验证会通过安全流程完成。</p>
      <p v-if="error" class="support-error" role="alert">{{ error }}</p>
      <div v-if="loading" class="support-loading" role="status">正在读取消息…</div>
      <ol v-else class="support-message-list" aria-label="会话消息">
        <li v-for="message in messages" :key="message.messageId" :class="{ 'from-user': message.senderType === 1 }">
          <small>{{ message.senderType === 1 ? '我' : message.senderType === 2 ? '客服' : '系统' }} · {{ new Date(message.createdAt).toLocaleString() }}</small>
          <p>{{ message.bodyText }}</p>
        </li>
      </ol>
      <form v-if="activeConversation.status !== SupportConversationStatus.CLOSED" class="support-reply-form" @submit.prevent="submitReply">
        <label for="support-reply">继续补充</label>
        <textarea id="support-reply" v-model="replyDraft" maxlength="4000" rows="3" required placeholder="描述遇到的问题"></textarea>
        <div><small>{{ replyDraft.length }}/4000</small><button class="support-primary" type="submit" :disabled="saving || !replyDraft.trim()">{{ saving ? '发送中…' : '发送消息' }}</button></div>
      </form>
      <p v-else class="support-closed-note">此会话已结束。需要继续处理时，请新建会话。</p>
    </template>
    <template v-else>
      <div class="support-heading"><div><strong>最近会话</strong><small>账号问题会由客服通过会话跟进。</small></div><button class="support-primary" type="button" @click="composeOpen = !composeOpen">{{ composeOpen ? '返回列表' : '新建咨询' }}</button></div>
      <p class="support-system-note">请勿发送密码、验证码或 TOTP 密钥。丢失验证器时，客服只能协助人工核验，不会重置 TOTP。</p>
      <form v-if="composeOpen" class="support-create-form" @submit.prevent="submitConversation">
        <label>问题分类<select v-model.number="categoryType"><option v-for="item in categories" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
        <label>问题标题<input v-model="subject" maxlength="160" minlength="3" required placeholder="简要描述你需要的帮助" /></label>
        <label>问题描述<textarea v-model="firstMessage" maxlength="4000" minlength="1" rows="5" required placeholder="请说明发生了什么，以及你希望获得什么帮助"></textarea></label>
        <div><small>{{ firstMessage.length }}/4000</small><button class="support-primary" type="submit" :disabled="saving || !subject.trim() || !firstMessage.trim()">{{ saving ? '提交中…' : '提交咨询' }}</button></div>
      </form>
      <p v-if="error" class="support-error" role="alert">{{ error }} <button type="button" @click="loadConversations">重试</button></p>
      <div v-if="loading" class="support-loading" role="status">正在读取会话…</div>
      <ul v-else-if="conversations.length" class="support-conversation-list">
        <li v-for="conversation in conversations" :key="conversation.conversationId"><button type="button" @click="openConversation(conversation)"><span><strong>{{ conversation.subject }}</strong><small>{{ categoryLabel(conversation.categoryType) }} · {{ new Date(conversation.updatedAt).toLocaleString() }}</small></span><b>{{ statusLabel(conversation.status) }} ›</b></button></li>
      </ul>
      <div v-else-if="!composeOpen" class="support-empty"><span aria-hidden="true">？</span><strong>还没有客服会话</strong><p>提交问题后，可以在这里查看会话和后续回复。</p><button type="button" @click="composeOpen = true">新建咨询</button></div>
    </template>
  </section>
</template>

<style scoped>
.support-workspace { display:flex; flex-direction:column; gap:12px; min-height:250px; color:#e9e5d8; }
.support-heading,.support-detail-header { display:flex; align-items:center; gap:10px; justify-content:space-between; }
.support-heading > div,.support-detail-header > div { display:grid; gap:4px; min-width:0; }
.support-heading strong,.support-detail-header strong { font-size:13px; }
.support-heading small,.support-detail-header small,.support-message-list small,.support-reply-form small,.support-create-form small { color:#aeb9a8; font-size:10px; }
.support-primary,.support-detail-header button,.support-empty button,.support-back,.support-error button { min-height:38px; border:1px solid #d9bd7850; border-radius:9px; padding:0 12px; color:#f2dfa8; background:#d9bd7814; font:inherit; font-size:11px; cursor:pointer; }
.support-primary:disabled { opacity:.55; cursor:wait; }
.support-system-note { margin:0; padding:10px 12px; border-left:2px solid #d9bd78; border-radius:6px; color:#c1c8b8; background:#ffffff08; font-size:10px; line-height:1.6; }
.support-create-form,.support-reply-form { display:grid; gap:10px; }
.support-create-form label,.support-reply-form label { display:grid; gap:6px; color:#cbd5c9; font-size:11px; }
.support-create-form input,.support-create-form select,.support-create-form textarea,.support-reply-form textarea { width:100%; min-height:40px; border:1px solid #ffffff24; border-radius:8px; padding:10px; color:#eee7d6; background:#061b18; font:inherit; font-size:12px; }
.support-create-form textarea,.support-reply-form textarea { resize:vertical; }
.support-create-form label:last-of-type textarea { min-height:110px; }
.support-create-form > div,.support-reply-form > div { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.support-conversation-list,.support-message-list { display:grid; gap:8px; margin:0; padding:0; list-style:none; }
.support-conversation-list li button { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; min-height:60px; padding:10px 12px; border:1px solid #ffffff18; border-radius:10px; color:inherit; background:#ffffff08; text-align:left; cursor:pointer; }
.support-conversation-list li button span { display:grid; gap:5px; min-width:0; }
.support-conversation-list li button strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; }
.support-conversation-list li button small { color:#aeb9a8; font-size:9px; }
.support-conversation-list li button b { flex:0 0 auto; color:#dec780; font-size:9px; }
.support-detail-header { align-items:flex-start; }
.support-detail-header > div { flex:1; padding-top:4px; }
.support-detail-header > button { flex:0 0 auto; min-height:34px; padding:0 8px; font-size:10px; }
.support-detail-header .support-back { border:0; padding:0; background:transparent; }
.support-close-confirm { display:grid; gap:9px; padding:11px; border:1px solid #d9bd7840; border-radius:10px; background:#d9bd780d; }
.support-close-confirm p { margin:0; color:#d7d2c2; font-size:10px; line-height:1.6; }
.support-close-confirm > div { display:flex; justify-content:flex-end; gap:8px; }
.support-close-confirm > div button { min-height:34px; border:1px solid #ffffff20; border-radius:8px; padding:0 10px; color:#d7dccc; background:#ffffff08; font:inherit; font-size:10px; cursor:pointer; }
.support-message-list { flex:1; max-height:330px; overflow:auto; padding:4px; }
.support-message-list li { max-width:86%; padding:9px 11px; border:1px solid #ffffff18; border-radius:10px 10px 10px 2px; background:#ffffff09; }
.support-message-list li.from-user { justify-self:end; border-radius:10px 10px 2px 10px; background:#d9bd7814; }
.support-message-list p { margin:5px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; line-height:1.55; }
.support-empty { display:grid; justify-items:center; gap:8px; margin:auto; padding:24px 10px; text-align:center; }
.support-empty > span { display:grid; width:38px; height:38px; place-items:center; border-radius:12px; color:#e3ca87; background:#e3ca8716; }
.support-empty strong { font-size:12px; }
.support-empty p,.support-closed-note { margin:0; color:#aeb9a8; font-size:10px; line-height:1.6; text-align:center; }
.support-error { margin:0; color:#ffb9a8; font-size:11px; }
.support-error button { min-height:28px; }
.support-loading { padding:22px; color:#bec9b7; text-align:center; font-size:11px; }
@media(max-width:480px) { .support-detail-header { flex-wrap:wrap; } .support-detail-header > div { order:3; flex:1 0 100%; } .support-message-list { max-height:38vh; } }
</style>
