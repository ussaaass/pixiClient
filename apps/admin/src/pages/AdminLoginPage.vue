<script setup lang="ts">
import { ElButton } from 'element-plus';
import 'element-plus/theme-chalk/el-button.css';
import PageHelpOverlay from '../components/PageHelpOverlay.vue';

const allowLayoutPreview = import.meta.env.DEV;
const environmentLabel = import.meta.env.DEV ? '开发环境' : '生产构建';
const loginHelp = [
  { heading: '凭证安全', body: '此开发页面不会发送或保存输入凭证。正式登录由服务端校验普通 user 身份、后台权限和登录风险。' },
  { heading: '可选 TOTP', body: 'TOTP 可选启用；只有登录服务返回第二因素 challenge 时才进入验证步骤。后台不能重置用户 TOTP。' },
  { heading: '账号恢复', body: '凭证恢复通过客服人工核验流程处理，不在登录页面重置认证秘密。' },
];
</script>

<template>
  <main class="login-page">
    <div class="login-topline"><RouterLink to="/admin/login" class="login-brand"><span class="login-mark">LG</span><span><strong>Lottery Game</strong><small>运营管理平台</small></span></RouterLink><span class="login-environment">{{ environmentLabel }}</span></div>
    <section class="login-layout">
      <div class="login-story">
        <p class="eyebrow">ADMINISTRATION CONSOLE</p>
        <h1>让每一项运营<br /><span>清晰、可控、可追溯。</span></h1>
        <p>用于管理游戏配置、代理域、支付订单与内容服务。数据范围由服务端权限决定，所有敏感操作均保留审计记录。</p>
        <div class="login-story-rule"><span></span>统一账号身份 · 独立后台授权</div>
      </div>

      <div class="login-card">
        <div class="login-card-heading"><div><p class="eyebrow">SECURE SIGN IN</p><h2>管理员登录</h2></div><PageHelpOverlay title="登录与账号恢复" trigger-label="查看登录与账号恢复说明" :sections="loginHelp" /></div>
        <form class="login-form" @submit.prevent>
          <label for="admin-account">用户名或邮箱</label>
          <input id="admin-account" type="text" name="username" autocomplete="username" placeholder="输入管理员用户名或邮箱" disabled />
          <label for="admin-password">密码</label>
          <input id="admin-password" type="password" name="password" autocomplete="current-password" placeholder="输入账号密码" disabled />
          <ElButton class="login-submit" type="primary" disabled :loading="false">登录</ElButton>
        </form>
        <RouterLink v-if="allowLayoutPreview" class="login-preview-link" to="/admin/overview">预览后台页面布局 <span aria-hidden="true">→</span></RouterLink>
      </div>
    </section>
    <footer class="login-footer"><span>LOTTERY GAME · ADMIN</span><span>访问受保护的运营工作区</span></footer>
  </main>
</template>
