<script setup lang="ts">
import { ElSelect } from 'element-plus';
import AdminSelectOption from '../components/AdminSelectOption.vue';
const handlingSteps = [
  { title: '打开原始证据', text: '查看 provider 对账文件/事件、外部交易定位和来源时间，不在页面编辑原始内容。' },
  { title: '核对内外记录', text: '并列对照 external_settlement 与内部订单/asset_operation；原币金额和 CNY 估值分开。' },
  { title: '认领并处置', text: '指定处理人，记录调查备注、证据引用和 reason；所有动作写不可变审计。' },
  { title: '有依据地关闭', text: '只有证据足以解释差异时关闭；涉及账务修正时另走追加分录/结算调整用例。' },
];
</script>

<template>
  <section class="domain-page reconciliation-page">
    <div class="domain-heading">
      <p class="eyebrow">支付与商品 / 异常处置</p>
      <h1>对账异常</h1>
      <p>处理外部 provider、链上资金与平台记录之间无法自动解释的差异。异常队列不提供直接编辑历史流水的能力。</p>
    </div>

    <section class="reconciliation-evidence-banner" aria-label="对账事实来源">
      <div><small>渠道消息</small><strong>payment_event</strong><p>验签、回调/查询来源与去重事实</p></div>
      <span aria-hidden="true">→</span>
      <div><small>外部资金</small><strong>external_settlement</strong><p>确认的原币收付、费用和净额</p></div>
      <span aria-hidden="true">↔</span>
      <div><small>平台记账</small><strong>asset_operation / asset_entry</strong><p>内部账户资产分录和操作摘要</p></div>
    </section>

    <section class="reconciliation-filter-panel" aria-labelledby="reconciliation-filter-title">
      <div class="agent-domain-section-heading"><div><h2 id="reconciliation-filter-title">异常队列</h2><p>按 provider、异常类型、日期或关联订单/交易定位；处理范围由服务端授权。</p></div><span class="record-count">未查询</span></div>
      <div class="reconciliation-filter-grid">
        <label><span>Provider</span><el-select disabled><AdminSelectOption value="">全部渠道</AdminSelectOption></el-select></label>
        <label><span>异常类型</span><el-select disabled><AdminSelectOption value="">全部类型</AdminSelectOption></el-select></label>
        <label><span>订单 / 外部交易</span><input type="search" placeholder="等待对账服务" disabled /></label>
        <label><span>发生日期</span><input type="text" placeholder="选择时间范围" disabled /></label>
        <button type="button" disabled>查询</button>
      </div>
    </section>

    <section class="reconciliation-cases-panel" aria-labelledby="reconciliation-cases-title">
      <div class="agent-domain-section-heading"><div><h2 id="reconciliation-cases-title">差异案件</h2><p>包含未匹配收/付款、金额/费用差异、迟到入账和未知出款结果。</p></div><span class="record-count">0 条已加载</span></div>
      <div class="reconciliation-table-wrap">
        <table>
          <caption>支付对账差异案件</caption>
          <thead><tr><th scope="col">案件</th><th scope="col">Provider</th><th scope="col">关联订单/出款</th><th scope="col">外部交易</th><th scope="col">原币差异</th><th scope="col">CNY 差异</th><th scope="col">发生时间</th><th scope="col">处理人</th><th scope="col">状态</th><th scope="col">证据</th></tr></thead>
          <tbody><tr><td colspan="10"><div class="reconciliation-empty-state" role="status"><span class="user-empty-icon" aria-hidden="true">⌕</span><strong>暂无对账异常</strong><p>异常详情关联原始 provider 证据、外部结算流水和内部记账摘要。</p></div></td></tr></tbody>
        </table>
      </div>
      <div class="reconciliation-mobile-empty" role="status"><span class="user-empty-icon" aria-hidden="true">⌕</span><strong>暂无对账异常</strong><p>关闭异常前必须关联证据并填写处置理由。</p></div>
    </section>

    <section class="reconciliation-workflow-panel" aria-labelledby="reconciliation-workflow-title">
      <div class="agent-domain-section-heading"><div><h2 id="reconciliation-workflow-title">案件处置流程</h2><p>案件处理说明资金差异，但不能取代领域账务用例。</p></div></div>
      <ol><li v-for="(step, index) in handlingSteps" :key="step.title"><span>{{ String(index + 1).padStart(2, '0') }}</span><div><strong>{{ step.title }}</strong><p>{{ step.text }}</p></div></li></ol>
      <p class="reconciliation-safety-note">关闭异常不等于改写交易事实。确认手续费差异时追加并关联原入款的 FEE_ADJUSTMENT；实际退款走提现/出款链路；原始 provider 事件、外部结算和内部资产流水均不可覆盖。</p>
    </section>
  </section>
</template>
