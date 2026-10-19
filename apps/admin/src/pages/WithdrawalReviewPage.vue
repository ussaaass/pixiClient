<script setup lang="ts">
import { ElSelect } from 'element-plus';
import AdminSelectOption from '../components/AdminSelectOption.vue';
const reviewSteps = [
  { title: '核验申请', text: '确认身份资格、流水完成、金额整数倍门槛和收款账户版本。' },
  { title: '审核决定', text: '通过或拒绝均要求权限与处理理由；审核通过不等于资金已出款。' },
  { title: '等待与出款', text: '申请至少等待 72 小时；付款结果未知时继续占款并先查询对账。' },
  { title: '确认结清', text: '只在出款成功后完成占款扣除；拒绝或确认失败才幂等释放占款。' },
];
</script>

<template>
  <section class="domain-page withdrawal-review-page">
    <div class="domain-heading">
      <p class="eyebrow">支付与商品 / 出款审核</p>
      <h1>提现审核</h1>
      <p>审核用户余额提现。申请净到账额、额外手续费、占款金额和外部出款状态分开核对。</p>
    </div>

    <section class="withdrawal-policy-strip" aria-label="提现处理规则">
      <div><small>最低金额门槛</small><strong>按配置的金币等值门槛取正整数倍</strong></div>
      <div><small>手续费</small><strong>在净到账额之外另计，向上取整</strong></div>
      <div><small>最早出款时间</small><strong>申请满 72 小时后</strong></div>
      <div><small>客损模式</small><strong>代理线下结算，不进入平台提现</strong></div>
    </section>

    <section class="withdrawal-query-panel" aria-labelledby="withdrawal-query-title">
      <div class="agent-domain-section-heading"><div><h2 id="withdrawal-query-title">申请队列</h2><p>筛选申请人、提现单号、处理阶段和申请时间；查询范围由服务端 capability 限制。</p></div><span class="record-count">未查询</span></div>
      <div class="withdrawal-query-grid">
        <label><span>提现单号</span><input type="text" inputmode="numeric" placeholder="完整提现单号" disabled /></label>
        <label><span>用户 ID</span><input type="text" inputmode="numeric" placeholder="完整用户 ID" disabled /></label>
        <label><span>处理阶段</span><el-select disabled><AdminSelectOption value="">全部阶段</AdminSelectOption></el-select></label>
        <label><span>申请时间</span><input type="text" placeholder="等待审核服务" disabled /></label>
        <button type="button" disabled>查询</button>
      </div>
    </section>

    <section class="withdrawal-results-panel" aria-labelledby="withdrawal-results-title">
      <div class="agent-domain-section-heading"><div><h2 id="withdrawal-results-title">提现申请</h2><p>净到账额不含手续费；申请占款总额应覆盖净到账额与按配置向上取整的手续费。</p></div><span class="record-count">0 条已加载</span></div>
      <div class="withdrawal-table-wrap">
        <table>
          <caption>提现申请及出款状态</caption>
          <thead><tr><th scope="col">申请</th><th scope="col">用户</th><th scope="col">净到账</th><th scope="col">手续费</th><th scope="col">占款合计</th><th scope="col">收款方式</th><th scope="col">最早出款</th><th scope="col">状态</th><th scope="col">详情</th></tr></thead>
          <tbody><tr><td colspan="9"><div class="withdrawal-empty-state" role="status"><span class="user-empty-icon" aria-hidden="true">⌕</span><strong>暂无提现申请</strong><p>列表按权限返回脱敏账户、金额快照、审核记录与出款时间线。</p></div></td></tr></tbody>
        </table>
      </div>
      <div class="withdrawal-mobile-empty" role="status"><span class="user-empty-icon" aria-hidden="true">⌕</span><strong>暂无提现申请</strong><p>列表只展示授权范围内的脱敏账户和处理时间线。</p></div>
    </section>

    <section class="withdrawal-process-panel" aria-labelledby="withdrawal-process-title">
      <div class="agent-domain-section-heading"><div><h2 id="withdrawal-process-title">审核和出款边界</h2><p>处理中资金保持占用；没有收到确定结果前，不重复发起付款，也不释放占款。</p></div></div>
      <ol><li v-for="(step, index) in reviewSteps" :key="step.title"><span>{{ String(index + 1).padStart(2, '0') }}</span><div><strong>{{ step.title }}</strong><p>{{ step.text }}</p></div></li></ol>
      <p class="withdrawal-review-note">收款账户详情只显示掩码及账户版本。客损模式客户不进入平台提现审核；管理员不能从本页代替代理线下结算。</p>
    </section>
  </section>
</template>
