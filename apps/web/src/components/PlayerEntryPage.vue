<script setup lang="ts">
import { defineAsyncComponent, onUnmounted, ref } from 'vue';
import { PlayerEntryOutcome } from '../platform/player-entry/player-entry-application';
import type { PlayerEntryApplication } from '../platform/player-entry/player-entry-application';
import { ApiRequestError } from '../platform/http/api-client';

const props = defineProps<{
  application: PlayerEntryApplication;
  emblem: string;
  createDevFixture?: (() => Promise<{ userId: string; displayName: string; identifier: string; password: string; recoveryQrPayload: string; recoveryQrPassword: string; recoveryExpiresAt: string }>) | undefined;
}>();
const emit = defineEmits<{ back: [] }>();
type EntryMode = 'device' | 'password' | 'recovery';
type QrDetection = { detect(source: ImageBitmap): Promise<Array<{ rawValue: string }>> };
type QrDetectorWindow = Window & { BarcodeDetector?: new (options: { formats: string[] }) => QrDetection };

const mode = ref<EntryMode>('device');
const identifier = ref('');
const password = ref('');
const credentialPassword = ref('');
const totp = ref('');
const qrPayload = ref('');
const qrFileName = ref('');
const totpRequired = ref(false);
const loginChallengeId = ref('');
const busy = ref(false);
const feedback = ref('');
const error = ref('');
const qrInput = ref<HTMLInputElement | null>(null);
const DevelopmentIdentityTools = import.meta.env.DEV ? defineAsyncComponent(() => import('./DevelopmentIdentityTools.vue')) : undefined;

const modeTitles: Record<EntryMode, string> = { device: '在这台设备继续', password: '使用账号凭证', recovery: '使用恢复凭证' };

function changeMode(next: EntryMode): void {
  mode.value = next;
  password.value = '';
  credentialPassword.value = '';
  totp.value = '';
  qrPayload.value = '';
  qrFileName.value = '';
  totpRequired.value = false;
  loginChallengeId.value = '';
  if (qrInput.value) qrInput.value.value = '';
  feedback.value = '';
  error.value = '';
}

function entryMessage(outcome: string): string {
  if (outcome === PlayerEntryOutcome.DEVICE_AUTHENTICATED || outcome === PlayerEntryOutcome.PASSWORD_AUTHENTICATED) return '登录成功，已建立本地开发会话。';
  if (outcome === PlayerEntryOutcome.RECOVERY_AUTHENTICATED) return '账号恢复成功，旧的本地会话已撤销。';
  if (outcome === PlayerEntryOutcome.DEVICE_CREDENTIAL_MISSING) {
    return '这台浏览器没有已绑定的设备凭证。当前可继续游客练习；正式设备登录需要身份服务验证。';
  }
  return '该账号凭证暂时无法用于登录。';
}

function failureMessage(code: string): string {
  return ({
    INVALID_REQUEST: '提交内容格式有误，请检查后重试。',
    IDENTIFIER_REQUIRED: '请输入用户名、邮箱或手机号。',
    PASSWORD_REQUIRED: '请输入密码。',
    CREDENTIAL_REQUIRED: '请先选择并读取账号恢复二维码。',
    TOTP_INVALID: '请输入 6 至 8 位数字验证码。',
    INVALID_CREDENTIALS: '账号或密码不正确。',
    RECOVERY_QR_INVALID: '二维码密码错误或二维码内容已损坏，请检查后重试。',
    IDENTITY_SERVICE_ERROR: '身份服务暂时无法完成请求，请稍后重试。',
  } as Record<string, string>)[code] ?? '当前操作无法完成，请重试。';
}

async function checkDevice(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  feedback.value = '';
  error.value = '';
  try {
    const result = await props.application.checkCurrentDevice();
    if (!result.ok) error.value = failureMessage(result.code);
    else if (result.value.outcome === PlayerEntryOutcome.DEVICE_CREDENTIAL_MISSING) feedback.value = entryMessage(result.value.outcome);
    else {
      feedback.value = entryMessage(result.value.outcome);
      if (result.value.outcome === PlayerEntryOutcome.DEVICE_AUTHENTICATED) emit('back');
    }
  } catch {
    error.value = '设备凭证检查失败，请重试或继续游客练习。';
  } finally {
    busy.value = false;
  }
}

async function submitPassword(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  feedback.value = '';
  error.value = '';
  try {
    const result = await props.application.passwordLogin({ identifier: identifier.value, password: password.value, ...(loginChallengeId.value ? { challengeId: loginChallengeId.value } : {}), ...(totpRequired.value && totp.value ? { totp: totp.value } : {}) });
    if (!result.ok) error.value = failureMessage(result.code);
    else if (result.value.outcome === PlayerEntryOutcome.PASSWORD_AUTHENTICATED) {
      password.value = '';
      totp.value = '';
      loginChallengeId.value = '';
      totpRequired.value = false;
      feedback.value = entryMessage(result.value.outcome);
      emit('back');
    } else if (result.value.outcome === PlayerEntryOutcome.TOTP_CHALLENGE_REQUIRED && result.value.challengeId) {
      loginChallengeId.value = result.value.challengeId;
      totpRequired.value = true;
      totp.value = '';
      feedback.value = `账号密码正确，请在 ${new Date(result.value.expiresAt ?? '').toLocaleTimeString()} 前输入验证器中的 6 位验证码。`;
    } else {
      password.value = '';
      error.value = entryMessage(result.value.outcome);
    }
  } catch (cause) {
    if (cause instanceof ApiRequestError && ['TOTP_INVALID', 'CHALLENGE_EXPIRED', 'CHALLENGE_NOT_FOUND'].includes(cause.code)) {
      totp.value = '';
      if (cause.code !== 'TOTP_INVALID') loginChallengeId.value = '';
      error.value = cause.code === 'TOTP_INVALID' ? '验证码不正确，请检查设备时间后重试。' : '登录验证已过期，请重新输入账号密码。';
      return;
    }
    password.value = '';
    error.value = cause instanceof ApiRequestError && cause.code === 'INVALID_CREDENTIALS'
      ? '账号或密码不正确。密码已清除。'
      : '身份服务暂时无法完成请求。密码已清除。';
  } finally {
    busy.value = false;
  }
}

function useDevelopmentFixture(created: { identifier: string; password: string; displayName: string; userId: string }): void {
  identifier.value = created.identifier;
  password.value = created.password;
  feedback.value = `已创建本地测试账号 ${created.displayName}（ID ${created.userId}）。请保存测试凭证。`;
  error.value = '';
  mode.value = 'password';
}

async function selectQrImage(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  qrPayload.value = '';
  qrFileName.value = '';
  feedback.value = '';
  error.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    error.value = '请选择二维码图片文件。';
    input.value = '';
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    error.value = '二维码图片不能超过 10 MB。';
    input.value = '';
    return;
  }

  const Detector = (window as QrDetectorWindow).BarcodeDetector;
  if (!Detector || typeof createImageBitmap !== 'function') {
    error.value = '当前浏览器不能直接识别二维码图片。可将恢复码文本粘贴到下方输入框继续。';
    input.value = '';
    return;
  }

  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const [code] = await new Detector({ formats: ['qr_code'] }).detect(bitmap);
    if (!code?.rawValue.trim()) {
      error.value = '图片中没有读取到二维码，请确认选择的是账号恢复凭证。';
      input.value = '';
      return;
    }
    if (code.rawValue.length > 4096) {
      error.value = '二维码内容超出支持范围，请联系人工客服。';
      input.value = '';
      return;
    }
    qrPayload.value = code.rawValue;
    qrFileName.value = file.name;
    feedback.value = '二维码已在本机读取。输入二维码密码和当前 TOTP 后，可继续检查表单。';
  } catch {
    error.value = '二维码图片无法读取，请换一张清晰图片后重试。';
    input.value = '';
  } finally {
    bitmap?.close();
  }
}

async function submitRecovery(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  feedback.value = '';
  error.value = '';
  try {
    const result = await props.application.recoverAccount({
      credentialPayload: qrPayload.value,
      credentialPassword: credentialPassword.value,
      ...(totp.value ? { totp: totp.value } : {}),
    });
    if (!result.ok) error.value = failureMessage(result.code);
    else {
      feedback.value = entryMessage(result.value.outcome);
      credentialPassword.value = '';
      totp.value = '';
      qrPayload.value = '';
      qrFileName.value = '';
      if (qrInput.value) qrInput.value.value = '';
      emit('back');
    }
  } catch (cause) {
    if (cause instanceof ApiRequestError && cause.code === 'TOTP_REQUIRED') {
      totpRequired.value = true;
      error.value = '此账号已启用 TOTP。请输入当前的 6 位验证码后重试。';
      credentialPassword.value = '';
      totp.value = '';
      return;
    }
    credentialPassword.value = '';
    totp.value = '';
    qrPayload.value = '';
    qrFileName.value = '';
    if (qrInput.value) qrInput.value.value = '';
    error.value = cause instanceof ApiRequestError
      ? failureMessage(cause.code)
      : '恢复凭证校验失败。敏感输入已清除，请检查凭证和二维码密码后重试。';
  } finally {
    busy.value = false;
  }
}

function moveMode(event: KeyboardEvent): void {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  const modes: EntryMode[] = ['device', 'password', 'recovery'];
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.player-entry-modes [role="tab"]'));
  const offset = event.key === 'ArrowRight' ? 1 : -1;
  const nextIndex = (modes.indexOf(mode.value) + offset + modes.length) % modes.length;
  changeMode(modes[nextIndex]!);
  tabs[nextIndex]?.focus();
}

onUnmounted(() => {
  identifier.value = '';
  password.value = '';
  credentialPassword.value = '';
  totp.value = '';
  qrPayload.value = '';
});
</script>

<template>
  <main class="player-entry-page">
    <header class="player-entry-header"><button class="back-button" type="button" @click="emit('back')">‹ 返回大厅</button><div class="brand-lockup"><img class="brand-logo" :src="emblem" alt="" /><span>LOTTERY <strong>GAME</strong></span></div></header>
    <section class="player-entry-card" aria-labelledby="player-entry-title">
      <p class="eyebrow">PLAYER ACCOUNT</p><h1 id="player-entry-title">登录与账号恢复</h1>
      <p class="player-entry-intro">登录或恢复账号，在不同设备间继续游戏并保护账户资产。</p>
      <div class="player-entry-modes" role="tablist" aria-label="登录方式">
        <button id="entry-mode-device" type="button" role="tab" aria-controls="player-entry-panel" :tabindex="mode === 'device' ? 0 : -1" :aria-selected="mode === 'device'" :class="{ active: mode === 'device' }" @keydown="moveMode" @click="changeMode('device')">本设备</button>
        <button id="entry-mode-password" type="button" role="tab" aria-controls="player-entry-panel" :tabindex="mode === 'password' ? 0 : -1" :aria-selected="mode === 'password'" :class="{ active: mode === 'password' }" @keydown="moveMode" @click="changeMode('password')">账号密码</button>
        <button id="entry-mode-recovery" type="button" role="tab" aria-controls="player-entry-panel" :tabindex="mode === 'recovery' ? 0 : -1" :aria-selected="mode === 'recovery'" :class="{ active: mode === 'recovery' }" @keydown="moveMode" @click="changeMode('recovery')">凭证恢复</button>
      </div>
      <div v-if="mode === 'device'" id="player-entry-panel" class="player-entry-content" role="tabpanel" aria-labelledby="entry-mode-device">
        <h2>{{ modeTitles.device }}</h2><p>使用已绑定的设备凭证登录；游客设备仍可继续本地练习。</p>
        <div class="player-entry-device"><span aria-hidden="true">⌁</span><div><strong>当前浏览器</strong><small>设备凭证只由身份服务签发和验证</small></div></div>
        <button class="panel-primary" type="button" :disabled="busy" @click="checkDevice">{{ busy ? '正在检查…' : '检查本机凭证' }}</button>
      </div>
      <form v-else-if="mode === 'password'" id="player-entry-panel" class="player-entry-content" role="tabpanel" aria-labelledby="entry-mode-password" novalidate @submit.prevent="submitPassword">
        <h2>{{ modeTitles.password }}</h2><p>使用已设置的用户名及密码登录；邮箱或手机号也可作为账号凭证。</p>
        <label>用户名 / 邮箱 / 手机<input v-model="identifier" type="text" autocomplete="username" maxlength="128" required placeholder="请输入账号" /></label>
        <label>密码<input v-model="password" type="password" autocomplete="current-password" maxlength="256" required placeholder="请输入密码" /></label>
        <label v-if="totpRequired">当前 TOTP 或备用恢复码<input v-model="totp" type="text" inputmode="text" autocomplete="one-time-code" maxlength="16" pattern="([0-9]{6}|[A-Fa-f0-9]{16})" required placeholder="6 位验证码或 16 位备用码" /></label>
        <button class="panel-primary" type="submit" :disabled="busy">{{ busy ? '正在检查…' : '登录' }}</button>
      </form>
      <form v-else id="player-entry-panel" class="player-entry-content" role="tabpanel" aria-labelledby="entry-mode-recovery" novalidate @submit.prevent="submitRecovery">
        <h2>{{ modeTitles.recovery }}</h2><p>选择原设备导出的账号恢复二维码并输入二维码密码；启用两步验证时再输入当前 TOTP。</p>
        <label class="player-entry-qr-picker">账号恢复二维码图片<input ref="qrInput" type="file" accept="image/*" @change="selectQrImage" /><small v-if="qrFileName">已读取：{{ qrFileName }}</small><small v-else>图片只在本机读取；也可粘贴恢复码文本</small></label>
        <label>恢复码文本<textarea v-model="qrPayload" rows="3" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="LGRC1.…" /></label>
        <label>二维码密码<input v-model="credentialPassword" type="password" autocomplete="off" maxlength="256" required placeholder="请输入二维码密码" /></label>
        <label v-if="totpRequired">当前 TOTP<input v-model="totp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required placeholder="6 位验证码" /></label>
        <button class="panel-primary" type="submit" :disabled="busy || !qrPayload">{{ busy ? '正在检查…' : '验证并恢复账号' }}</button>
        <p class="player-entry-hint">如果账号启用了 TOTP，系统会要求当前验证码。二维码密码和恢复秘密只在本机解密，账号恢复后旧会话会撤销。</p>
      </form>
      <p v-if="feedback" class="player-entry-feedback" role="status">{{ feedback }}</p>
      <component :is="DevelopmentIdentityTools" v-if="DevelopmentIdentityTools && props.createDevFixture" :create-fixture="props.createDevFixture" @created="useDevelopmentFixture" @error="error = $event" />
      <p v-if="error" class="player-entry-error" role="alert">{{ error }}</p>
      <div class="player-entry-footer"><span>当前可使用游客模式体验本地十三张练习</span><button type="button" @click="emit('back')">继续游客练习</button></div>
    </section>
  </main>
</template>
