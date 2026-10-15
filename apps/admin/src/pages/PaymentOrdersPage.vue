<script setup lang="ts">
const orderEvidence = [
  { step: '订单', text: '商品快照、支付方式、应付金额和创建时间' },
  { step: '支付事件', text: 'provider 原始事件摘要、验签/handler 结果和状态迁移' },
  { step: '履约', text: '关联 asset_operation 与金币入账结果；重复回调不得重复履约' },
];
</script>

<template>
  <section class="domain-page payment-orders-page">
    <RouterLink to="/admin/payments/channels" class="back-link">← 返回支付渠道</RouterLink>
    <div class="domain-heading">
      <p class="eyebrow">支付与商品 / 充值处理</p>
      <h1>充值订单</h1>
      <p>订单视图串联支付通道事件与资产履约证据。后台人员不能直接伪造“已支付”，也不能从此页直接补发金币。</p>
    </div>

    <section class="order-query-panel" aria-labelledby="order-query-title">
      <div class="agent-domain-section-heading"><div><h2 id="order-query-title">查找订单</h2><p>使用精确 ID 和时间范围定位订单；订单 ID 按十进制字符串处理。</p></div><span class="record-count">未查询</span></div>
      <div class="order-query-grid">
        <label><span>订单 ID</span><input type="text" inputmode="numeric" placeholder="完整订单 ID" disabled /></label>
        <label><span>用户 ID</span><input type="text" inputmode="numeric" placeholder="完整用户 ID" disabled /></label>
        <label><span>支付方式</span><select disabled><option>全部方式</option></select></label>
        <label><span>订单状态</span><select disabled><option>全部状态</option></select></label>
        <label><span>创建时间</span><input type="text" placeholder="等待订单服务" disabled /></label>
        <button type="button" disabled>查询</button>
      </div>
    </section>

    <section class="order-results-panel" aria-labelledby="order-results-title">
      <div class="agent-domain-section-heading"><div><h2 id="order-results-title">订单记录</h2><p>订单金额与商品快照是创建时事实；回调不重新读取当前价格或汇率。</p></div><span class="record-count">0 条已加载</span></div>
      <div class="order-table-wrap">
        <table>
          <caption>充值订单及履约状态</caption>
          <thead><tr><th scope="col">订单</th><th scope="col">用户</th><th scope="col">商品快照</th><th scope="col">实付 / 计价</th><th scope="col">方式 / Provider</th><th scope="col">状态</th><th scope="col">创建时间</th><th scope="col">详情</th></tr></thead>
          <tbody><tr><td colspan="8"><div class="order-empty-state" role="status"><span class="user-empty-icon" aria-hidden="true">⌕</span><strong>暂无充值订单</strong><p>订单详情关联支付事件与账本履约证据；敏感商户凭证不会在这里回显。</p></div></td></tr></tbody>
        </table>
      </div>
      <div class="order-mobile-empty" role="status"><span class="user-empty-icon" aria-hidden="true">⌕</span><strong>暂无充值订单</strong><p>订单详情关联支付事件与账本履约证据。</p></div>
    </section>

    <section class="order-evidence-panel" aria-labelledby="order-evidence-title">
      <div class="agent-domain-section-heading"><div><h2 id="order-evidence-title">订单详情的证据链</h2><p>订单时间线用于定位问题，状态变更仍归支付 handler 与账本用例负责。</p></div></div>
      <ol><li v-for="item in orderEvidence" :key="item.step"><strong>{{ item.step }}</strong><p>{{ item.text }}</p></li></ol>
      <p class="order-safety-note">USDT 订单展示创建时锁定的报价快照和独立收款地址；错额、超时或迟到到账进入异常处置，不能按最新汇率自动补发。</p>
    </section>
  </section>
</template>
