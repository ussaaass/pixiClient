<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AgentDomainStatus, type AgentDomainDto, type InviteLinkDto } from '@gameing/contracts/invite-agent';
import type { InviteAgentApplication } from '../platform/invite-agent/invite-agent-application';

const props = defineProps<{ application: InviteAgentApplication | undefined; authenticated: boolean }>();
const invite = ref<InviteLinkDto | null>(null);
const agentDomain = ref<AgentDomainDto | null>(null);
const loading = ref(false);
const working = ref(false);
const feedback = ref('');
const statusLabel = computed(() => {
  switch (agentDomain.value?.status) {
    case AgentDomainStatus.PENDING_REVIEW: return '审核中';
    case AgentDomainStatus.ACTIVE: return '已开通代理域';
    case AgentDomainStatus.SUSPENDED: return '暂时停用';
    case AgentDomainStatus.REVOKED: return '已撤销';
    case AgentDomainStatus.WITHDRAWN: return '已撤回，可重新申请';
    default: return '尚未申请';
  }
});

async function load(): Promise<void> {
  if (!props.authenticated || !props.application) return;
  loading.value = true;
  feedback.value = '';
  try {
    [invite.value, agentDomain.value] = await Promise.all([props.application.getInviteLink(), props.application.getAgentDomain()]);
  } catch {
    feedback.value = '暂时无法读取邀请与代理信息，请稍后重试。';
  } finally { loading.value = false; }
}
async function createInvite(): Promise<void> {
  if (!props.application) return;
  working.value = true;
  feedback.value = '';
  try { invite.value = await props.application.issueInviteLink(); feedback.value = '邀请链接已准备好，可复制后分享。'; }
  catch { feedback.value = '邀请链接暂时未能生成，请稍后重试。'; }
  finally { working.value = false; }
}
async function copyInvite(): Promise<void> {
  if (!invite.value) return;
  try { await navigator.clipboard.writeText(invite.value.url); feedback.value = '邀请链接已复制。'; }
  catch { feedback.value = '浏览器未授权剪贴板，请手动选择并复制链接。'; }
}
function selectInviteUrl(event: Event): void {
  if (event.currentTarget instanceof HTMLInputElement) event.currentTarget.select();
}
async function apply(): Promise<void> {
  if (!props.application) return;
  working.value = true;
  feedback.value = '';
  try { agentDomain.value = await props.application.applyAgentDomain(); feedback.value = '申请已提交，审核通过前仍是普通玩家。'; }
  catch { feedback.value = '申请未能提交，请检查当前状态后重试。'; }
  finally { working.value = false; }
}
async function withdraw(): Promise<void> {
  if (!props.application) return;
  working.value = true;
  feedback.value = '';
  try { await props.application.withdrawAgentDomain(); await load(); feedback.value = '申请已撤回。'; }
  catch { feedback.value = '当前状态不能撤回申请。'; }
  finally { working.value = false; }
}
function dateLabel(value: string): string { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value)); }
watch(() => [props.authenticated, props.application] as const, () => void load(), { immediate: true });
</script>

<template>
  <div class="player-invite-workspace">
    <div v-if="!authenticated" class="player-panel-empty player-panel-empty-large"><span aria-hidden="true">⌁</span><strong>登录后管理邀请与代理申请</strong><p>邀请码与申请状态会关联到当前账号。</p></div>
    <template v-else>
      <p v-if="loading" class="player-invite-feedback" role="status">正在读取账号信息…</p>
      <div class="player-invite-card"><span aria-hidden="true">⌁</span><div><strong>邀请链接</strong><p v-if="invite">有效期至 {{ dateLabel(invite.expiresAt) }}。分享链接不代表邀请关系已经绑定。</p><p v-else>生成专属邀请链接，有效期两年。访客关系需由平台服务完成归因确认。</p></div><button type="button" :disabled="working || loading" @click="invite ? copyInvite() : createInvite()">{{ invite ? '复制链接' : '生成链接' }}</button></div>
      <label v-if="invite" class="player-invite-url"><span>邀请链接</span><input :value="invite.url" readonly aria-label="邀请链接" @focus="selectInviteUrl"></label>
      <div class="player-invite-card"><span aria-hidden="true">◇</span><div><strong>代理申请 · {{ statusLabel }}</strong><p v-if="agentDomain?.status === AgentDomainStatus.PENDING_REVIEW">申请已提交，平台审核完成前账号仍保持普通玩家权限。</p><p v-else-if="agentDomain?.status === AgentDomainStatus.ACTIVE">代理域权限和可见数据范围由平台授予并由服务端校验。</p><p v-else-if="agentDomain?.status === AgentDomainStatus.WITHDRAWN">再次申请将更新当前申请状态。</p><p v-else>所有用户均可申请；成为代理需平台审核并单独授予后台权限。</p></div><button v-if="!agentDomain || agentDomain.status === AgentDomainStatus.WITHDRAWN" type="button" :disabled="working || loading" @click="apply">{{ agentDomain ? '再次申请' : '提交申请' }}</button><button v-else-if="agentDomain.status === AgentDomainStatus.PENDING_REVIEW" type="button" :disabled="working" @click="withdraw">撤回申请</button></div>
      <p v-if="feedback" class="player-invite-feedback" role="status">{{ feedback }}</p>
      <p class="player-invite-note">邀请链接用于进入归因流程，邀请关系以平台确认结果为准。</p>
      <button v-if="!loading" class="player-invite-refresh" type="button" @click="load">刷新状态</button>
    </template>
  </div>
</template>
