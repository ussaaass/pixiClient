<script setup lang="ts">
import { RouterLink } from 'vue-router';

const attentionAreas = [
  { title: '用户与代理', detail: '用户查询、代理域和资产明细', path: '/admin/users', icon: '♙', tone: 'blue' },
  { title: '游戏运营', detail: '游戏配置、概率模拟与发布', path: '/admin/games', icon: '♠', tone: 'purple' },
  { title: '支付与商品', detail: '商品、Mock 支付和提现审核', path: '/admin/payments/channels', icon: '￥', tone: 'amber' },
  { title: '社区与客服', detail: '话题治理、举报及客服会话', path: '/admin/community', icon: '☏', tone: 'green' },
];
</script>

<template>
  <section class="overview-page">
    <div class="page-intro">
      <div><p class="eyebrow">OPERATIONS WORKSPACE</p><h1>运营总览</h1><p class="intro-copy">选择一个领域，查看对应的运营工作区。</p></div>
    </div>

    <div class="section-heading"><div><h2>工作区</h2><p>选择一个领域查看对应管理功能</p></div><span class="section-meta">7 个领域</span></div>
    <section class="workspace-grid" aria-label="管理领域">
      <RouterLink v-for="area in attentionAreas" :key="area.path" :to="area.path" class="workspace-card">
        <span class="workspace-icon" :class="`tone-${area.tone}`" aria-hidden="true">{{ area.icon }}</span>
        <span class="workspace-card-copy"><strong>{{ area.title }}</strong><small>{{ area.detail }}</small></span>
        <span class="workspace-arrow" aria-hidden="true">↗</span>
      </RouterLink>
      <RouterLink to="/admin/events" class="workspace-card">
        <span class="workspace-icon tone-rose" aria-hidden="true">◉</span><span class="workspace-card-copy"><strong>活动与广播</strong><small>事件规则、奖池和公告投递</small></span><span class="workspace-arrow" aria-hidden="true">↗</span>
      </RouterLink>
      <RouterLink to="/admin/assets" class="workspace-card">
        <span class="workspace-icon tone-cyan" aria-hidden="true">▧</span><span class="workspace-card-copy"><strong>素材与资源</strong><small>素材资产、AI 生成和版本发布</small></span><span class="workspace-arrow" aria-hidden="true">↗</span>
      </RouterLink>
      <RouterLink to="/admin/system" class="workspace-card">
        <span class="workspace-icon tone-slate" aria-hidden="true">⚙</span><span class="workspace-card-copy"><strong>系统设置与审计</strong><small>全局配置、后台权限和操作记录</small></span><span class="workspace-arrow" aria-hidden="true">↗</span>
      </RouterLink>
    </section>

    <section class="empty-workspace" aria-label="运营数据状态">
      <div class="empty-mark">···</div><div><strong>暂无运营事项</strong><p>待办与告警将在这里汇总。</p></div>
    </section>
    <footer class="page-footer">Lottery Game · Admin workspace <span>权限与真实数据均由服务端决定</span></footer>
  </section>
</template>
