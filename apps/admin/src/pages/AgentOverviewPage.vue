<script setup lang="ts">
import PageHelpOverlay from '../components/PageHelpOverlay.vue';

const workspaces = [
  { path: '/agent/downlines', title: '下线管理', permission: 'AGENT_DOWNLINE_READ', detail: '查看已授权直接下线的资产、订单、牌局和邀请资料；永不展示认证秘密。', icon: '♙' },
  { path: '/agent/games', title: '域级游戏配置', permission: 'AGENT_GAME_CONFIG_READ', detail: '查看本域有效版本；模拟和发布能力须另行授权并受平台边界约束。', icon: '♠' },
  { path: '/agent/announcements', title: '域内广播', permission: 'AGENT_ANNOUNCEMENT_MANAGE', detail: '只管理当前域公告，不能选择平台全局范围。', icon: '◉' },
  { path: '/agent/social', title: '社区与私聊', permission: 'AGENT_SOCIAL_MODERATE', detail: '仅展示获批社区能力；读取私聊需要独立 capability 并记录审计。', icon: '☏' },
  { path: '/agent/audit', title: '代理操作记录', permission: 'AGENT_DASHBOARD_READ', detail: '查看本人代理域操作及 Admin 授权状态。', icon: '≋' },
];
</script>

<template>
  <section class="agent-overview-page">
    <div class="agent-overview-heading">
      <div><p class="eyebrow">AGENT WORKSPACE</p><h1>代理域总览</h1><p>从下方进入代理运营工作区。</p></div>
      <div class="agent-overview-heading-actions"><PageHelpOverlay title="代理域数据范围" trigger-label="查看代理域数据范围说明" :sections="[{ heading: '授权边界', body: '下线所属域由服务端按当前邀请链解析。父代理只可能看到授权的脱敏汇总，不能访问子代理域明细。换绑后旧域权限立即撤销，社交内容依服务端迁移任务进入新域。页面不会接受客户端传入的 agent_domain_id 作为授权依据。' }]" /></div>
    </div>

    <section class="agent-overview-workspaces" aria-labelledby="agent-workspace-title">
      <div class="agent-overview-section-heading"><div><h2 id="agent-workspace-title">代理运营工作区</h2><p>选择一个工作区继续。</p></div><span>5 个工作区</span></div>
      <div class="agent-workspace-grid">
        <RouterLink v-for="space in workspaces" :key="space.permission" :to="space.path" class="agent-workspace-card">
          <span class="agent-workspace-icon" aria-hidden="true">{{ space.icon }}</span>
          <div><strong>{{ space.title }}</strong><small>{{ space.permission }}</small><p>{{ space.detail }}</p></div>
        </RouterLink>
      </div>
    </section>

  </section>
</template>
