<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  createFixture: () => Promise<{ userId: string; displayName: string; identifier: string; password: string; recoveryQrPayload: string; recoveryQrPassword: string; recoveryExpiresAt: string }>;
}>();
const emit = defineEmits<{
  created: [fixture: { userId: string; displayName: string; identifier: string; password: string; recoveryQrPayload: string; recoveryQrPassword: string; recoveryExpiresAt: string }];
  error: [message: string];
}>();
const busy = ref(false);
const generated = ref<{ userId: string; displayName: string; identifier: string; password: string; recoveryQrPayload: string; recoveryQrPassword: string; recoveryExpiresAt: string }>();
const recovery = ref<{ qrPayload: string; qrPassword: string; expiresAt: string }>();
const copied = ref(false);

async function generate(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  emit('error', '');
  try {
    generated.value = await props.createFixture();
    recovery.value = { qrPayload: generated.value.recoveryQrPayload, qrPassword: generated.value.recoveryQrPassword, expiresAt: generated.value.recoveryExpiresAt };
    emit('created', generated.value);
  } catch {
    emit('error', '创建测试账号失败，本地存储可能不可用。');
  } finally {
    busy.value = false;
  }
}

async function copyRecoveryPayload(): Promise<void> {
  if (!recovery.value) return;
  await navigator.clipboard.writeText(recovery.value.qrPayload);
  copied.value = true;
}
</script>

<template>
  <section class="player-entry-dev-tools" aria-label="开发测试工具">
    <h3>本地测试账号（仅开发环境）</h3>
    <p>生成一个只保存在当前浏览器的虚构账号，账号密码只展示在本机，用于验证真实密码登录。</p>
    <button class="panel-secondary" type="button" :disabled="busy" @click="generate">{{ busy ? '正在创建…' : '生成测试账号' }}</button>
    <p v-if="generated" role="status">已创建本地测试账号 {{ generated.displayName }}（ID {{ generated.userId }}）。请保存测试凭证。</p>
    <dl v-if="generated" class="player-entry-dev-credentials"><div><dt>用户名</dt><dd>{{ generated.identifier }}</dd></div><div><dt>随机密码</dt><dd>{{ generated.password }}</dd></div></dl>
    <div v-if="recovery" class="player-entry-dev-recovery">
      <strong>恢复测试资料</strong>
      <p>仅供当前浏览器本地测试。恢复码已用下方密码加密；请复制码文本，再切换到“凭证恢复”完成实际登录流程。有效期至 {{ new Date(recovery.expiresAt).toLocaleDateString() }}。</p>
      <label>恢复码文本<textarea readonly :value="recovery.qrPayload" rows="4" spellcheck="false" /></label>
      <button class="panel-secondary" type="button" @click="copyRecoveryPayload">{{ copied ? '已复制恢复码' : '复制恢复码' }}</button>
      <p><code>二维码密码：{{ recovery.qrPassword }}</code></p>
    </div>
  </section>
</template>

<style scoped>
.player-entry-dev-tools { display: grid; gap: 8px; margin-top: 14px; padding: 12px; border: 1px dashed #e1c27655; border-radius: 10px; background: #061b1870; }
.player-entry-dev-tools h3,.player-entry-dev-tools p { margin: 0; }
.player-entry-dev-tools h3 { color: #f2d88f; font-size: 10px; }
.player-entry-dev-tools p { color: #aebbad; font-size: 9px; line-height: 1.6; }
.player-entry-dev-credentials { display: grid; gap: 6px; margin: 0; }
.player-entry-dev-credentials > div { display: grid; grid-template-columns: 72px minmax(0,1fr); gap: 8px; padding: 7px; border-radius: 6px; background: #ffffff08; }
.player-entry-dev-credentials dt { color: #aebbad; font-size: 9px; }
.player-entry-dev-credentials dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: #fff0bf; font: 10px/1.5 ui-monospace,monospace; user-select: all; }
.player-entry-dev-recovery { display: grid; gap: 6px; padding-top: 8px; border-top: 1px solid #ffffff18; }
.player-entry-dev-recovery > strong { color: #f2d88f; font-size: 10px; }
.player-entry-dev-recovery > p,.player-entry-dev-recovery label { margin: 0; color: #aebbad; font-size: 9px; line-height: 1.6; }
.player-entry-dev-recovery textarea { display: block; width: 100%; margin-top: 4px; padding: 8px; border: 1px solid #ffffff20; border-radius: 6px; background: #061512; color: #fff0bf; font: 9px/1.5 ui-monospace,monospace; overflow-wrap: anywhere; resize: vertical; }
.player-entry-dev-recovery code { color: #fff0bf; overflow-wrap: anywhere; user-select: all; }
</style>
