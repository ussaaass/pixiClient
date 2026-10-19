<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { CoinMarketListingStatus, CoinMarketPaymentMethod, CoinMarketTradeStatus, type CoinMarketListingDto, type CoinMarketPriceQuoteDto, type CoinMarketTradeDto } from '@gameing/contracts/coin-market';
import type { CoinMarketApplication } from '../platform/coin-market/coin-market-application';
import { parseCoinMarketRmbToFen } from '../platform/coin-market/coin-market-application';

const props = defineProps<{ application: CoinMarketApplication; availableCoins: string; turnoverRemaining: string }>();
const emit = defineEmits<{ listingChanged: [] }>();
const coins = ref('1000');
const priceRmb = ref('120');
const quote = ref<CoinMarketPriceQuoteDto>();
const loading = ref(false);
const error = ref('');
const listings = ref<CoinMarketListingDto[]>([]);
const activeListingCount = computed(() => listings.value.filter((item) => item.status === CoinMarketListingStatus.ACTIVE).length);
const listingsLoading = ref(false);
const listingBusy = ref(false);
const listingError = ref('');
const listingMessage = ref('');
const selectedPaymentMethods = ref<number[]>([CoinMarketPaymentMethod.BANK_TRANSFER]);
const paymentMethodOptions = [
  { value: CoinMarketPaymentMethod.BANK_TRANSFER, label: '银行卡转账' }, { value: CoinMarketPaymentMethod.ALIPAY, label: '支付宝' },
  { value: CoinMarketPaymentMethod.WECHAT, label: '微信' }, { value: CoinMarketPaymentMethod.UNION_QR, label: '银联二维码' },
  { value: CoinMarketPaymentMethod.DIGITAL_RMB, label: '数字人民币' }, { value: CoinMarketPaymentMethod.USDT_TRC20, label: 'USDT · TRON/TRC-20' },
] as const;
const paymentMethodLabels: Record<number, string> = Object.fromEntries(paymentMethodOptions.map(({ value, label }) => [value, label]));
const tradeStatusLabels: Record<number, string> = {
  [CoinMarketTradeStatus.PAYMENT_PENDING]: '等待买家付款', [CoinMarketTradeStatus.SELLER_CONFIRMATION_PENDING]: '等待卖家确认',
  [CoinMarketTradeStatus.DISPUTED]: '争议处理中', [CoinMarketTradeStatus.BUYER_EVIDENCE_PENDING]: '等待买家补证',
  [CoinMarketTradeStatus.SELLER_EVIDENCE_PENDING]: '等待卖家补证', [CoinMarketTradeStatus.PLATFORM_REVIEW]: '等待平台裁定',
  [CoinMarketTradeStatus.RELEASED]: '金币已转入买家账户（本地模拟）', [CoinMarketTradeStatus.RETURNED]: '金币已退回卖家（本地模拟）',
  [CoinMarketTradeStatus.PAYMENT_EXPIRED]: '付款超时',
};
const paymentInstructions = ref('');
const publicListings = ref<CoinMarketListingDto[]>([]);
const trades = ref<CoinMarketTradeDto[]>([]);
const tradeText = ref<Record<string, string>>({});
const tradeNotice = ref('');
const buyQuantities = ref<Record<string, string>>({});
const selectedMethods = ref<Record<string, number>>({});
const minimumTradeCoins = ref('1000');
const activeTab = ref<'market' | 'mine' | 'trades'>('market');
const activeTradeCount = computed(() => trades.value.filter((trade) => ![CoinMarketTradeStatus.RELEASED, CoinMarketTradeStatus.RETURNED, CoinMarketTradeStatus.PAYMENT_EXPIRED].includes(trade.status as 7 | 8 | 9)).length);

onMounted(() => { void Promise.all([loadListings(), loadMarket(), loadTrades()]); });

async function loadMarket(): Promise<void> { const result = await props.application.publicListings(); if (result.ok) { publicListings.value = result.value.items; minimumTradeCoins.value = result.value.minimumTradeCoins; for (const listing of result.value.items) { selectedMethods.value[listing.listingId] ??= listing.paymentMethods?.[0] ?? CoinMarketPaymentMethod.BANK_TRANSFER; buyQuantities.value[listing.listingId] ??= result.value.minimumTradeCoins; } } }
async function loadTrades(): Promise<void> { const result = await props.application.myTrades(); if (result.ok) trades.value = result.value; }

async function loadListings(): Promise<void> {
  listingsLoading.value = true;
  const result = await props.application.myListings();
  listingsLoading.value = false;
  if (!result.ok) { listingError.value = '无法读取我的挂牌，请稍后重试。'; return; }
  listings.value = result.value;
}

async function requestQuote(): Promise<void> {
  quote.value = undefined;
  error.value = '';
  const priceCentsPer1000Coins = parseCoinMarketRmbToFen(priceRmb.value);
  if (!/^[1-9][0-9]{0,18}$/.test(coins.value) || !priceCentsPer1000Coins) {
    error.value = '请输入正整数金币数量，以及最多精确到分的人民币挂牌价。';
    return;
  }
  loading.value = true;
  const result = await props.application.quotePrice({ coins: coins.value, priceCentsPer1000Coins });
  loading.value = false;
  if (!result.ok) {
    error.value = result.code === 'SOCIAL_ACCESS_DISABLED' ? '当前账号暂不可使用金币集市。' : '价格暂时无法计算，请稍后重试。';
    return;
  }
  quote.value = result.value;
}

async function createListing(): Promise<void> {
  if (!quote.value) return;
  listingBusy.value = true;
  listingError.value = '';
  listingMessage.value = '';
  if (!selectedPaymentMethods.value.length || !paymentInstructions.value.trim()) { listingError.value = '请选择至少一种收款方式，并填写仅在买家接单后展示的收款资料。'; listingBusy.value = false; return; }
  const result = await props.application.createListing({ coins: quote.value.coins, priceCentsPer1000Coins: quote.value.priceCentsPer1000Coins, idempotencyKey: crypto.randomUUID(), paymentMethods: selectedPaymentMethods.value as typeof CoinMarketPaymentMethod[keyof typeof CoinMarketPaymentMethod][], paymentInstructions: paymentInstructions.value.trim() });
  listingBusy.value = false;
  if (!result.ok) {
    const messages: Record<string, string> = {
      TURNOVER_INCOMPLETE: '有效下注流水尚未完成，暂不能挂牌。',
      INSUFFICIENT_AVAILABLE_BALANCE: '可用金币不足，或部分金币已被冻结。',
      LISTING_BELOW_MINIMUM: `低于最低挂牌量 ${quote.value.minimumListingCoins} 金币。`,
      SOCIAL_ACCESS_DISABLED: '当前账号暂不可使用金币集市。',
    };
    listingError.value = messages[result.code] ?? '挂牌未创建，请刷新我的挂牌后重试。';
    return;
  }
  listingMessage.value = `挂牌已创建，${result.value.coins} 金币已冻结。`;
  await loadListings();
  await loadMarket();
  activeTab.value = 'mine';
  emit('listingChanged');
}

async function cancelListing(listing: CoinMarketListingDto): Promise<void> {
  listingError.value = '';
  const result = await props.application.cancelListing(listing.listingId);
  if (!result.ok) { listingError.value = '撤销失败，挂牌状态可能已变化。'; return; }
  await loadListings();
  await loadMarket();
  emit('listingChanged');
}

async function buy(listing: CoinMarketListingDto): Promise<void> {
  const method = selectedMethods.value[listing.listingId];
  const coins = buyQuantities.value[listing.listingId] ?? minimumTradeCoins.value;
  if (!method || !/^[1-9][0-9]{0,18}$/.test(coins) || BigInt(coins) < BigInt(minimumTradeCoins.value) || BigInt(coins) > BigInt(listing.availableCoins)) { tradeNotice.value = `请输入不低于 ${minimumTradeCoins.value} 且不超过该挂牌可售数量的金币数。`; return; }
  const result = await props.application.createTrade(listing.listingId, { coins, paymentMethod: method as typeof CoinMarketPaymentMethod[keyof typeof CoinMarketPaymentMethod], idempotencyKey: crypto.randomUUID() });
  tradeNotice.value = result.ok ? '已创建成交。仅为本机开发模拟：请按订单资料线下操作，再提交付款说明。' : result.code === 'TRADE_BELOW_MINIMUM' ? '单笔成交不得低于 1000 金币。' : result.code === 'PAYMENT_HANDLER_UNAVAILABLE' ? 'USDT 链上校验尚未接入，当前开发版不接受此方式。' : '接单失败，挂牌库存可能已变化。';
  await Promise.all([loadMarket(), loadTrades()]);
  if (result.ok) activeTab.value = 'trades';
}
async function tradeAction(trade: CoinMarketTradeDto, action: 'paymentProof' | 'appeal' | 'buyerEvidence' | 'sellerEvidence' | 'confirmReceipt'): Promise<void> {
  const result = await props.application.tradeCommand(action, trade.tradeId, action === 'confirmReceipt' ? undefined : { text: tradeText.value[trade.tradeId]?.trim() ?? '' });
  tradeNotice.value = result.ok ? '订单状态已更新。浏览器开发模式不构成真实付款或真实资金托管。' : '操作未完成，请核对当前订单状态和参与者身份。';
  await loadTrades();
}
function tradeStatus(status: number): string { return tradeStatusLabels[status] ?? '处理中'; }
function needsTradeText(status: number): boolean { return status === CoinMarketTradeStatus.PAYMENT_PENDING || status === CoinMarketTradeStatus.SELLER_CONFIRMATION_PENDING || status === CoinMarketTradeStatus.DISPUTED || status === CoinMarketTradeStatus.SELLER_EVIDENCE_PENDING; }
function handleTabKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = ['market', 'mine', 'trades'] as const;
  const current = tabs.indexOf(activeTab.value);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
  activeTab.value = tabs[next]!;
  document.getElementById(`coin-market-tab-${activeTab.value}`)?.focus();
}

function formatRmb(fen: string): string {
  const amount = BigInt(fen);
  const yuan = amount / 100n;
  const remainder = (amount % 100n).toString().padStart(2, '0');
  return `¥${yuan.toLocaleString('zh-CN')}.${remainder}`;
}
function payableAmount(listing: CoinMarketListingDto): string {
  const coins = BigInt(buyQuantities.value[listing.listingId] ?? minimumTradeCoins.value);
  return ceilRatio(BigInt(listing.priceCentsPer1000Coins) * coins, 1000n).toString();
}
function ceilRatio(amount: bigint, divisor: bigint): bigint { return (amount + divisor - 1n) / divisor; }
function validPurchaseQuantity(listing: CoinMarketListingDto): boolean {
  const value = buyQuantities.value[listing.listingId] ?? minimumTradeCoins.value;
  return /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) >= BigInt(minimumTradeCoins.value) && BigInt(value) <= BigInt(listing.availableCoins);
}
</script>

<template>
  <section class="coin-market-workspace" aria-label="金币集市">
    <div class="coin-market-tabs" role="tablist" aria-label="金币集市分类">
      <button id="coin-market-tab-market" type="button" role="tab" :aria-selected="activeTab === 'market'" aria-controls="coin-market-panel-market" :tabindex="activeTab === 'market' ? 0 : -1" :class="{ active: activeTab === 'market' }" @click="activeTab = 'market'" @keydown="handleTabKeydown">金币挂牌 <span>{{ publicListings.length }}</span></button>
      <button id="coin-market-tab-mine" type="button" role="tab" :aria-selected="activeTab === 'mine'" aria-controls="coin-market-panel-mine" :tabindex="activeTab === 'mine' ? 0 : -1" :class="{ active: activeTab === 'mine' }" @click="activeTab = 'mine'" @keydown="handleTabKeydown">我的挂牌 <span>{{ activeListingCount }}</span></button>
      <button id="coin-market-tab-trades" type="button" role="tab" :aria-selected="activeTab === 'trades'" aria-controls="coin-market-panel-trades" :tabindex="activeTab === 'trades' ? 0 : -1" :class="{ active: activeTab === 'trades' }" @click="activeTab = 'trades'" @keydown="handleTabKeydown">我的成交 <span>{{ activeTradeCount }}</span></button>
    </div>
    <section v-if="activeTab === 'market'" id="coin-market-panel-market" class="coin-market-tab-panel coin-market-public" role="tabpanel" aria-labelledby="coin-market-tab-market" tabindex="0">
      <div class="coin-market-section-heading"><div><h4 id="coin-market-public-title">玩家转让</h4><p>浏览其他玩家的公开挂牌，按每 1000 金币报价；可部分成交。</p></div><span>{{ publicListings.length }} 条</span></div>
      <p v-if="tradeNotice" class="coin-market-success" role="status">{{ tradeNotice }}</p>
      <p v-if="!publicListings.length" class="coin-market-empty-listings">暂时没有可购买的挂牌。你可以稍后再来看看，或发布自己的转让。</p>
      <article v-for="listing in publicListings" :key="listing.listingId" class="coin-market-listing-row">
        <div><strong>{{ BigInt(listing.availableCoins).toLocaleString('zh-CN') }} 金币可售</strong><span>{{ listing.sellerLabel }} · ¥{{ formatRmb(listing.priceCentsPer1000Coins).slice(1) }} / 1000 枚</span><small v-if="listing.sellerLabel?.startsWith('演示 · ')">本地模拟挂牌 · 不可真实交割</small><small>收款：{{ listing.paymentMethods?.map((method) => paymentMethodLabels[method]).join('、') }}</small><details v-if="(listing.paymentMethods?.length ?? 0) > 1" class="coin-market-method-select"><summary :aria-label="`选择${listing.sellerLabel}挂牌的付款方式`">付款方式：{{ paymentMethodLabels[selectedMethods[listing.listingId] ?? listing.paymentMethods?.[0] ?? 0] }} <span aria-hidden="true">⌄</span></summary><div role="radiogroup" aria-label="选择付款方式"><button v-for="method in listing.paymentMethods" :key="method" type="button" role="radio" :aria-checked="selectedMethods[listing.listingId] === method" @click="selectedMethods[listing.listingId] = method; ($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')">{{ paymentMethodLabels[method] }}<span v-if="selectedMethods[listing.listingId] === method" aria-hidden="true">✓</span></button></div></details><p v-else class="coin-market-single-method">付款方式：{{ paymentMethodLabels[listing.paymentMethods?.[0] ?? 0] ?? '暂不可用' }}</p><label class="coin-market-buy-quantity">本次购买 <span><input v-model="buyQuantities[listing.listingId]" inputmode="numeric" maxlength="19" :aria-label="`购买${listing.sellerLabel}的金币数量`" /> 金币</span></label><small class="coin-market-payable">预计支付 {{ validPurchaseQuantity(listing) ? formatRmb(payableAmount(listing)) : '请输入有效数量' }}</small></div>
        <button type="button" :disabled="!validPurchaseQuantity(listing)" @click="buy(listing)">买入</button>
      </article>
    </section>
    <section v-else-if="activeTab === 'mine'" id="coin-market-panel-mine" class="coin-market-tab-panel" role="tabpanel" aria-labelledby="coin-market-tab-mine" tabindex="0">
    <details class="coin-market-sell-panel">
      <summary><span><strong>我要转让金币</strong><small>发布前会冻结挂牌金币，未成交部分可撤销解冻。</small></span><span class="coin-market-disclosure-icon" aria-hidden="true">＋</span></summary>
      <p class="coin-market-wallet-note">当前可用 {{ BigInt(props.availableCoins).toLocaleString('zh-CN') }} 金币 · 待完成流水 {{ BigInt(props.turnoverRemaining).toLocaleString('zh-CN') }} 金币</p>
      <form class="coin-market-quote-form" @submit.prevent="requestQuote">
        <label>转让金币数量<input v-model="coins" inputmode="numeric" autocomplete="off" maxlength="19" aria-label="金币数量" /></label>
        <label>挂牌价（每 1000 金币，RMB）<span class="coin-market-price-input"><span aria-hidden="true">¥</span><input v-model="priceRmb" inputmode="decimal" autocomplete="off" maxlength="18" aria-label="每 1000 金币的人民币挂牌价" /></span></label>
        <button class="panel-primary" type="submit" :disabled="loading">{{ loading ? '计算中…' : '计算挂牌金额' }}</button>
      </form>
      <p v-if="error" class="coin-market-error" role="alert">{{ error }}</p>
      <dl v-if="quote" class="coin-market-quote-result" aria-live="polite">
        <div><dt>1000 金币参考价值</dt><dd>{{ formatRmb(quote.referenceCentsPer1000Coins) }}</dd></div>
        <div><dt>卖家挂牌价</dt><dd>{{ formatRmb(quote.priceCentsPer1000Coins) }}</dd></div>
        <div class="coin-market-total"><dt>{{ BigInt(quote.coins).toLocaleString('zh-CN') }} 金币报价</dt><dd>{{ formatRmb(quote.grossCents) }}</dd></div>
        <p>参考价值按当前金币兑换配置计算；成交金额以创建交易时锁定的挂牌价为准。</p>
      </dl>
      <div class="coin-market-payout-details">
        <fieldset class="coin-market-method-picker"><legend>可接受的收款方式</legend><label v-for="method in paymentMethodOptions" :key="method.value"><input v-model="selectedPaymentMethods" type="checkbox" :value="method.value" />{{ method.label }}</label></fieldset>
        <label>收款资料（仅接单买家可见）<textarea v-model="paymentInstructions" maxlength="2000" rows="3" placeholder="填写收款说明、账号或 USDT 地址；不要填写登录密码。" /></label>
      </div>
      <button v-if="quote" class="coin-market-create-listing" type="button" :disabled="listingBusy || BigInt(props.turnoverRemaining) > 0n || BigInt(props.availableCoins) < BigInt(quote.coins) || BigInt(quote.coins) < BigInt(quote.minimumListingCoins)" @click="createListing">{{ listingBusy ? '提交中…' : '冻结金币并发布挂牌' }}</button>
      <p v-if="listingMessage" class="coin-market-success" role="status">{{ listingMessage }}</p>
      <p v-if="listingError" class="coin-market-error" role="alert">{{ listingError }}</p>
    </details>
    <section class="coin-market-own-listings" aria-labelledby="coin-market-own-listings-title">
      <h4 id="coin-market-own-listings-title">挂牌管理</h4>
      <p v-if="listingsLoading">正在读取挂牌…</p>
      <p v-else-if="!listings.length">还没有发布挂牌。</p>
      <article v-for="listing in listings" :key="listing.listingId" class="coin-market-listing-row">
        <div><strong>{{ BigInt(listing.coins).toLocaleString('zh-CN') }} 金币</strong><span>{{ listing.sellerLabel?.startsWith('本机样例') ? '本机样例 · 非真实挂牌' : `¥${formatRmb(listing.priceCentsPer1000Coins).slice(1)} / 1000 枚 · 共 ${formatRmb(listing.totalCents)}` }}</span><small>{{ listing.sellerLabel?.startsWith('本机样例') ? '仅用于页面预览 · 不涉及资产冻结' : listing.status === CoinMarketListingStatus.ACTIVE ? '挂牌中 · 金币已冻结' : listing.status === CoinMarketListingStatus.CANCELLED ? '已撤销 · 未成交金币已解冻' : '状态已更新' }}</small></div>
        <button v-if="listing.status === CoinMarketListingStatus.ACTIVE && !listing.sellerLabel?.startsWith('本机样例')" type="button" @click="cancelListing(listing)">撤销挂牌</button>
      </article>
    </section>
    </section>
    <section v-else id="coin-market-panel-trades" class="coin-market-tab-panel coin-market-public coin-market-trades" role="tabpanel" aria-labelledby="coin-market-tab-trades" tabindex="0">
      <h4 id="coin-market-trades-title">我的成交</h4>
      <p>在这里跟进你买入和卖出的订单。挂牌本身属于商品，不会显示在成交列表。</p>
      <p v-if="tradeNotice" class="coin-market-success" role="status">{{ tradeNotice }}</p>
      <p v-if="!trades.length">还没有集市订单。</p>
      <article v-for="trade in trades" :key="trade.tradeId" class="coin-market-trade-row">
        <strong>{{ tradeStatus(trade.status) }} · {{ trade.coins }} 金币 · {{ formatRmb(trade.grossCents) }}</strong>
        <p>{{ trade.actorRole === 'BUYER' ? '买家订单' : '卖家订单' }}</p>
        <p>收款资料：{{ trade.paymentInstructions }}</p>
        <small>付款截止 {{ new Date(trade.paymentDeadlineAt).toLocaleString() }}<template v-if="trade.sellerDeadlineAt"> · 卖家确认截止 {{ new Date(trade.sellerDeadlineAt).toLocaleString() }}</template></small>
        <label v-if="needsTradeText(trade.status)" class="coin-market-trade-proof">付款凭证/补充说明<textarea v-model="tradeText[trade.tradeId]" rows="2" maxlength="2000" /></label>
        <div class="coin-market-trade-actions">
          <button v-if="trade.actorRole === 'BUYER' && trade.status === CoinMarketTradeStatus.PAYMENT_PENDING" type="button" @click="tradeAction(trade, 'paymentProof')">提交付款凭证说明</button>
          <button v-if="trade.actorRole === 'SELLER' && trade.status === CoinMarketTradeStatus.SELLER_CONFIRMATION_PENDING" type="button" @click="tradeAction(trade, 'confirmReceipt')">确认收到款并放币</button>
          <button v-if="trade.actorRole === 'SELLER' && trade.status === CoinMarketTradeStatus.SELLER_CONFIRMATION_PENDING" type="button" @click="tradeAction(trade, 'appeal')">申诉未收到款</button>
          <button v-if="trade.actorRole === 'BUYER' && trade.status === CoinMarketTradeStatus.DISPUTED" type="button" @click="tradeAction(trade, 'buyerEvidence')">提交买家补证</button>
          <button v-if="trade.actorRole === 'SELLER' && trade.status === CoinMarketTradeStatus.SELLER_EVIDENCE_PENDING" type="button" @click="tradeAction(trade, 'sellerEvidence')">提交卖家回应</button>
        </div>
      </article>
    </section>
  </section>
</template>
