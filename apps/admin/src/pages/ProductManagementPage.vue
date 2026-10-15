<script setup lang="ts">
const productFields = [
  { title: '商品身份', detail: '商品编码、名称、分类与可售状态由 Product API 返回。' },
  { title: '价格与币种', detail: '金额使用精确十进制字符串；支付币种和展示价格不可由浏览器换算。' },
  { title: '交付定义', detail: '关联已登记的交付类型与版本化参数，不在 Admin 页面直接写资产账本。' },
  { title: '版本与订单快照', detail: '下架/改价只影响新订单；已付款订单按创建时商品和履约快照处理。' },
];
</script>

<template>
  <section class="product-management-page">
    <div class="product-heading">
      <div><p class="eyebrow">支付与商品</p><h1>商品管理</h1><p>维护平台可售商品及其履约定义，不限定为金币商品。</p></div>
    </div>

    <section class="product-query-panel">
      <div class="product-panel-heading"><div><h2>商品目录</h2><p>按商品信息、分类、可售状态与交付类型筛选。</p></div><button type="button" disabled>＋ 新建商品</button></div>
      <div class="product-filter-grid">
        <label>商品名称 / 编码<input disabled placeholder="输入精确名称或编码"></label>
        <label>商品分类<select disabled><option>全部分类</option></select></label>
        <label>可售状态<select disabled><option>全部状态</option></select></label>
        <label>交付类型<select disabled><option>全部类型</option></select></label>
        <button type="button" disabled>查询商品</button>
      </div>
      <div class="product-empty-state"><span>▤</span><strong>暂无可读取的商品</strong><p>接入商品 API 后，列表显示商品版本、支付价格、交付摘要和可售状态。敏感支付配置不在此页回显。</p></div>
    </section>

    <section class="product-field-grid" aria-label="商品信息边界">
      <article v-for="field in productFields" :key="field.title"><span aria-hidden="true">◇</span><div><strong>{{ field.title }}</strong><p>{{ field.detail }}</p></div></article>
    </section>

    <section class="product-lifecycle-panel">
      <div><p class="eyebrow">订单一致性</p><h2>商品变更不会改写已付款订单</h2><p>订单创建时固定商品版本、价格/币种、支付方式、交付参数和兑换比例快照。只有经过验证的支付成功事件才能调用履约用例；Admin 不提供手工“支付成功”或直接发资产入口。</p></div>
      <div class="product-lifecycle-steps" aria-label="订单履约步骤"><span>商品快照</span><b>→</b><span>通道确认</span><b>→</b><span>服务端履约</span><b>→</b><span>资产流水</span></div>
    </section>

    <div class="product-action-row"><button type="button" disabled>编辑商品</button><button type="button" disabled>用户端预览</button><button type="button" disabled>下架商品</button></div>
  </section>
</template>
