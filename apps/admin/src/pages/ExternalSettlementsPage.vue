<script setup lang="ts">
const flowTypes = [
  { name: 'IN · 入款', description: '必须关联有效充值订单和支付证据。' },
  { name: 'OUT · 出款', description: '必须关联有效 payout_attempt；用户退款也沿用提现出款链路。' },
  { name: 'FEE_ADJUSTMENT · 手续费调整', description: '只追加记录并关联原 IN；不能改写原结算事实。' },
  { name: 'FUNDING · 资金注入', description: '需要有效资金来源凭证，不关联订单或出款尝试。' },
];
</script>

<template>
  <section class="domain-page external-settlements-page">
    <div class="domain-heading">
      <p class="eyebrow">支付与商品 / 外部资金对账</p>
      <h1>通道结算流水</h1>
      <p>查看渠道、银行或链上已确认的外部收付事实。它不替代支付事件日志，也不直接修改用户钱包。</p>
    </div>

    <section class="settlement-query-panel" aria-labelledby="settlement-query-title">
      <div class="agent-domain-section-heading"><div><h2 id="settlement-query-title">筛选外部资金事实</h2><p>使用外部交易号、订单/出款引用、渠道、原币和结算时间定位记录。</p></div><span class="record-count">未查询</span></div>
      <div class="settlement-query-grid">
        <label><span>结算记录 ID</span><input type="text" inputmode="numeric" placeholder="完整记录 ID" disabled /></label>
        <label><span>外部交易号</span><input type="text" placeholder="交易号 / 链事件定位" disabled /></label>
        <label><span>订单 / 出款 ID</span><input type="text" inputmode="numeric" placeholder="业务引用 ID" disabled /></label>
        <label><span>Flow type</span><select disabled><option>全部类型</option></select></label>
        <label><span>渠道 / 原币</span><select disabled><option>全部渠道与币种</option></select></label>
        <button type="button" disabled>查询</button>
      </div>
    </section>

    <section class="settlement-results-panel" aria-labelledby="settlement-results-title">
      <div class="agent-domain-section-heading"><div><h2 id="settlement-results-title">结算明细</h2><p>按原币核对外部收付；CNY 估值与原币数量分列，净额等于毛额减费用。</p></div><span class="record-count">0 条已加载</span></div>
      <div class="settlement-table-wrap">
        <table>
          <caption>外部资金结算记录；服务接入前不展示虚构结算行</caption>
          <thead><tr><th scope="col">Flow type</th><th scope="col">结算 Key</th><th scope="col">业务引用</th><th scope="col">外部交易</th><th scope="col">原币金额</th><th scope="col">毛额 CNY</th><th scope="col">通道费</th><th scope="col">净额</th><th scope="col">结算时间</th><th scope="col">详情</th></tr></thead>
          <tbody><tr><td colspan="10"><div class="settlement-empty-state" role="status"><span class="user-empty-icon" aria-hidden="true">⌕</span><strong>暂无外部结算流水</strong><p>流水详情显示原币、人民币等值、handler 校验结果和关联证据。</p></div></td></tr></tbody>
        </table>
      </div>
      <div class="settlement-mobile-empty" role="status"><span class="user-empty-icon" aria-hidden="true">⌕</span><strong>暂无外部结算流水</strong><p>详情仅展示已确认的外部资金事实和关联证据。</p></div>
    </section>

    <section class="settlement-handler-panel" aria-labelledby="settlement-handler-title">
      <div class="agent-domain-section-heading"><div><h2 id="settlement-handler-title">Flow handler 校验</h2><p>数据库字段组合约束之外，handler 还要校验关联对象的业务类型和状态。</p></div></div>
      <div class="settlement-flow-grid">
        <article v-for="flow in flowTypes" :key="flow.name"><strong>{{ flow.name }}</strong><p>{{ flow.description }}</p></article>
      </div>
      <div class="settlement-adjustment-rule"><strong>手续费差异如何处理</strong><p>追加 gross=0 的费用调整行并关联原 IN；增加手续费时 fee 为正、net 为负；退回手续费时 fee 为负、net 为正。原始入账不可覆盖。退款申请走 withdrawal/payout_attempt 并在外部结算中记录 OUT，不增加 REFUND flow type。</p></div>
      <p class="settlement-ledger-note">external_settlement 记录外部资金变化；payment_event 保存渠道消息；asset_operation / asset_entry 保存平台内部记账。三种事实各自负责不同问题，不能互相替代。</p>
    </section>
  </section>
</template>
