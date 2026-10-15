<script setup lang="ts">
const matchStages = [
  { title: '创建订单', detail: '锁定 USDT/CNY 报价，并给订单绑定唯一收款地址。' },
  { title: '分配尾数', detail: '基础金额截断到 0.1 USDT 后，按窗口分配不重复递增槽位。' },
  { title: '监测确认', detail: '按 TRON 网络、合约、接收地址、精确金额与确认条件识别入账。' },
  { title: '异常转客服', detail: '超时、迟到、错额或无法匹配保留原始链事件，不自动履约。' },
];
</script>

<template>
  <section class="domain-page chain-deposits-page">
    <div class="domain-heading">
      <p class="eyebrow">支付与商品 / TRON 链充值</p>
      <h1>链上充值监控</h1>
      <p>监控 TRON/TRC-20 入账及订单匹配。页面只读链上证据，不执行转账、不托管私钥，也不因发现交易就直接发币。</p>
    </div>

    <section class="chain-safety-grid" aria-label="链上充值安全边界">
      <article><small>监控网络</small><strong>TRON · TRC-20</strong></article>
      <article><small>订单匹配</small><strong>独立地址 + 精确金额</strong></article>
      <article><small>链事件唯一性</small><strong>网络 + 交易哈希 + 事件位置</strong></article>
      <article><small>异常处置</small><strong>保留证据并转客服，不自动履约</strong></article>
    </section>

    <section class="chain-filter-panel" aria-labelledby="chain-filter-title">
      <div class="agent-domain-section-heading"><div><h2 id="chain-filter-title">订单与链事件</h2><p>按订单、收款地址、交易哈希或处理状态检索；完整地址与交易证据按授权读取。</p></div><span class="record-count">未查询</span></div>
      <div class="chain-filter-grid">
        <label><span>订单 ID</span><input type="text" inputmode="numeric" placeholder="完整订单 ID" disabled /></label>
        <label><span>收款地址</span><input type="text" placeholder="完整地址 / 后缀" disabled /></label>
        <label><span>交易哈希</span><input type="text" placeholder="Transaction hash" disabled /></label>
        <label><span>处理状态</span><select disabled><option>全部状态</option></select></label>
        <label><span>发生时间</span><input type="text" placeholder="等待链监测服务" disabled /></label>
        <button type="button" disabled>查询</button>
      </div>
    </section>

    <section class="chain-events-panel" aria-labelledby="chain-events-title">
      <div class="agent-domain-section-heading"><div><h2 id="chain-events-title">监测记录</h2><p>待确认、已匹配、错额、超时和迟到事件都保留原始定位信息。</p></div><span class="record-count">0 条已加载</span></div>
      <div class="chain-events-table-wrap">
        <table>
          <caption>TRON 链充值事件</caption>
          <thead><tr><th scope="col">订单</th><th scope="col">地址</th><th scope="col">应收 USDT</th><th scope="col">实收 USDT</th><th scope="col">交易哈希</th><th scope="col">区块 / 事件</th><th scope="col">确认数</th><th scope="col">处理状态</th><th scope="col">操作</th></tr></thead>
          <tbody><tr><td colspan="9"><div class="chain-events-empty" role="status"><span class="user-empty-icon" aria-hidden="true">⌕</span><strong>暂无链上充值事件</strong><p>事件详情显示脱敏地址、应收/实收差异和链上交易定位。</p></div></td></tr></tbody>
        </table>
      </div>
      <div class="chain-events-mobile-empty" role="status"><span class="user-empty-icon" aria-hidden="true">⌕</span><strong>暂无链上充值事件</strong><p>事件详情只展示脱敏订单信息和链上交易定位。</p></div>
    </section>

    <section class="chain-matching-panel" aria-labelledby="chain-matching-title">
      <div class="agent-domain-section-heading"><div><h2 id="chain-matching-title">金额识别与异常处理</h2><p>订单尾数用于识别订单，不改变商品标价、汇率快照或充值返点基数。</p></div></div>
      <div class="chain-matching-example"><span>例：商品 ¥100 · 锁定汇率 6.7 CNY/USDT</span><strong>14.9 → 14.910 → 14.911 → 14.912 USDT</strong><small>按订单窗口分配不重复的递增尾数；示例不是当前可支付报价。</small></div>
      <ol><li v-for="(stage, index) in matchStages" :key="stage.title"><span>{{ String(index + 1).padStart(2, '0') }}</span><div><strong>{{ stage.title }}</strong><p>{{ stage.detail }}</p></div></li></ol>
      <p class="chain-private-key-note">界面和普通链监测服务均不得显示或读取转账私钥。超时到账、错额及无法唯一匹配由客服根据链上证据人工处置。</p>
    </section>
  </section>
</template>
