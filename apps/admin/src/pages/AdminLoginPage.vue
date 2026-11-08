<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElButton } from 'element-plus';
import 'element-plus/theme-chalk/el-button.css';
import PageHelpOverlay from '../components/PageHelpOverlay.vue';
import { saveAdminSession, clearAdminSession, hasAdminSession } from '../platform/admin-auth';

const router = useRouter();

const allowLayoutPreview = import.meta.env.DEV;
const environmentLabel = import.meta.env.DEV ? '开发环境' : '生产构建';
const loginHelp = [
  {
    heading: '凭证安全',
    body: '密码经 TLS 加密传输，服务端经 argon2id 校验；accessToken 存 sessionStorage（15 分钟有效期），sessionKey 用作会话标识；refreshToken 由服务端置于 HttpOnly cookie，但 Admin 刷新接口尚未接入，过期后需重新登录。',
  },
  {
    heading: '可选 TOTP',
    body: '目前 Admin 登录入口尚未接入 TOTP challenge；已启用 TOTP 的账号暂不能通过此登录界面完成登录，待 KMS 与 identity challenge 集成后开放。',
  },
  { heading: '账号恢复', body: '凭证恢复通过客服人工核验流程处理，不在登录页面重置认证秘密。' },
];

const username = ref('');
const password = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);
const loggedIn = ref(hasAdminSession());

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  error.value = null;

  try {
    const adminApiBase: string | undefined = import.meta.env.VITE_ADMIN_API_BASE;
    const base = (adminApiBase ?? '/admin-api/v1').replace(/\/+$/, '');

    const body = {
      username: username.value.trim(),
      password: password.value,
    };

    const response = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // HttpOnly refresh cookie
      body: JSON.stringify(body),
    });

    const envelope = await response.json();
    if (response.ok && envelope.code === 'OK') {
      const data = envelope.data;
      saveAdminSession({
        accessToken: data.accessToken,
        sessionKey: data.sessionKey,
        adminUserId: data.adminUserId,
      });
      loggedIn.value = true;
      router.push('/admin/overview');
    } else {
      error.value = envelope.message ?? '登录失败，请检查用户名或密码。';
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '网络错误，请稍后重试。';
  } finally {
    submitting.value = false;
  }
}

function logout(): void {
  clearAdminSession();
  loggedIn.value = false;
  username.value = '';
  password.value = '';
}
</script>

<template>
  <main class="login-page">
    <div class="login-topline">
      <RouterLink to="/admin/login" class="login-brand"
        ><span class="login-mark">LG</span><span><strong>Lottery Game</strong><small>运营管理平台</small></span></RouterLink
      ><span class="login-environment">{{ environmentLabel }}</span>
    </div>
    <section class="login-layout">
      <div class="login-story">
        <p class="eyebrow">ADMINISTRATION CONSOLE</p>
        <h1>让每一项运营<br /><span>清晰、可控、可追溯。</span></h1>
        <p>用于管理游戏配置、代理域、支付订单与内容服务。数据范围由服务端权限决定，所有敏感操作均保留审计记录。</p>
        <div class="login-story-rule"><span></span>统一账号身份 · 独立后台授权</div>
      </div>

      <div class="login-card">
        <div class="login-card-heading">
          <div>
            <p class="eyebrow">SECURE SIGN IN</p>
            <h2>管理员登录</h2>
          </div>
          <PageHelpOverlay title="登录与账号恢复" trigger-label="查看登录与账号恢复说明" :sections="loginHelp" />
        </div>

        <!-- 已登录态 -->
        <div v-if="loggedIn && hasAdminSession()" class="login-session-info">
          <p class="eyebrow">SESSION ACTIVE</p>
          <p class="session-note">当前会话有效，可直接访问后台工作区。</p>
          <ElButton type="primary" @click="() => router.push('/admin/overview')">进入管理后台</ElButton>
          <ElButton plain @click="logout">退出登录</ElButton>
        </div>

        <!-- 登录表单 -->
        <form v-else class="login-form" @submit.prevent="submit">
          <label for="admin-account">用户名</label>
          <input
            id="admin-account"
            v-model="username"
            type="text"
            name="username"
            autocomplete="username"
            placeholder="输入管理员用户名"
            :disabled="submitting"
          />
          <label for="admin-password">密码</label>
          <input
            id="admin-password"
            v-model="password"
            type="password"
            name="password"
            autocomplete="current-password"
            placeholder="输入账号密码"
            :disabled="submitting"
          />
          <p v-if="error" class="login-error" role="alert">{{ error }}</p>
          <ElButton
            class="login-submit"
            type="primary"
            :disabled="submitting || username.trim() === '' || password === ''"
            :loading="submitting"
            @click="submit"
          >
            登录
          </ElButton>
        </form>

        <RouterLink v-if="allowLayoutPreview" class="login-preview-link" to="/admin/overview"
          >预览后台页面布局 <span aria-hidden="true">→</span></RouterLink
        >
      </div>
    </section>
    <footer class="login-footer"><span>LOTTERY GAME · ADMIN</span><span>访问受保护的运营工作区</span></footer>
  </main>
</template>

<style scoped>
.login-session-info {
  padding: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.session-note {
  font-size: 13px;
  color: #6b7280;
  margin: 0;
}
.login-error {
  color: #dc2626;
  font-size: 13px;
  margin: 4px 0 0;
}
</style>
