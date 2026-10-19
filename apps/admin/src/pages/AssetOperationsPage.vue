<script setup lang="ts">
import { ElSelect } from 'element-plus';
import AdminSelectOption from '../components/AdminSelectOption.vue';
const principles = [
  { title: '追加式账务', body: 'asset_operation 表示一次业务操作；asset_entry 按账户与资产记录借贷变化，不改写历史余额事实。', icon: '＋' },
  { title: '冻结是占用/hold 状态', body: '冻结记录占用可用余额；释放只解除占用，不再次入账。COIN 与 CNY 分账核对。', icon: '▣' },
  { title: '跨资产与系统账户', body: '兑换和手续费分别记录不同资产分录；系统账户作为来源/归宿，不能把不同资产金额相加。', icon: '⇄' },
];
</script>

<template>
  <section class="asset-operations-page">
    <RouterLink to="/admin/overview" class="back-link">← 返回运营总览</RouterLink>
    <div class="domain-heading"><p class="eyebrow">用户与代理 / 资产</p><h1>资产操作</h1><p>按不可变 operation 与 entry 查询用户及系统账户资产变化。</p></div>
    <section class="asset-filter-panel">
      <div class="user-filter-heading"><div><h2>查询资产操作</h2><p>按用户、operation、资产类型和时间范围检索；金额以十进制字符串传输。</p></div></div>
      <div class="asset-filter-grid">
        <label>用户 ID<input disabled placeholder="十进制字符串"></label>
        <label>操作类型<el-select disabled><AdminSelectOption value="">全部操作</AdminSelectOption></el-select></label>
        <label>资产类型<el-select disabled><AdminSelectOption value="">全部资产</AdminSelectOption></el-select></label>
        <label>关联来源<input disabled placeholder="订单 / 局 / 请求 ID"></label>
        <label>时间范围<input disabled placeholder="开始时间 — 结束时间"></label>
        <button type="button" disabled>查询账本</button>
      </div>
    </section>
    <section class="asset-operation-results"><div class="user-results-heading"><div><h2>操作与分录</h2><p>每次操作可包含多条 entry；冻结与解冻是 hold 生命周期，不产生第二次资金入账。</p></div></div><div class="asset-empty-state"><strong>暂无可读取的账本记录</strong><p>服务端接入后展示 operation 状态、账户方向、精确 delta、关联主体和不可变分录。</p></div></section>
    <section class="asset-ledger-principles"><div class="user-results-heading"><div><h2>账本语义</h2><p>页面只解释记录口径，不推导或修改业务状态。</p></div></div><div class="asset-principle-grid"><article v-for="principle in principles" :key="principle.title" class="asset-principle-card"><span aria-hidden="true">{{ principle.icon }}</span><div><h3>{{ principle.title }}</h3><p>{{ principle.body }}</p></div></article></div><p class="asset-ledger-footnote">管理员不直接修改 amount/frozen_amount。调账、追回、冲正必须创建新操作，并满足系统账户守恒、权限分离和不可变审计。</p></section>
  </section>
</template>
