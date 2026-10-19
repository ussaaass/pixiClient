<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { FundingOrderStatus, type FundingChannelDto, type FundingOrderDto } from '@gameing/contracts/wallet-funding';
import type { WalletFundingApplication } from '../wallet-funding/wallet-funding-application';

const props = defineProps<{ application: WalletFundingApplication; view?: 'all' | 'purchase' | 'orders' }>();
const emit = defineEmits<{ completed: []; contactSupport: [] }>();
const channels = ref<FundingChannelDto[]>([]);
const orders = ref<FundingOrderDto[]>([]);
const channelId = ref('');
const amountYuan = ref('');
const loading = ref(true);
const workingOrderId = ref('');
const error = ref('');
const notice = ref('');
const paymentEventKeys = new Map<string, string>();

function formatFen(fen: string): string {
  const value = BigInt(fen);
  return `${(value / 100n).toString()}.${(value % 100n).toString().padStart(2, '0')}`;
}
function amountToFen(value: string): string | undefined {
  if (!/^[1-9][0-9]{0,8}(?:\.[0-9]{1,2})?$/.test(value.trim())) return undefined;
  const [yuan, fraction = ''] = value.trim().split('.');
  return (BigInt(yuan!) * 100n + BigInt((fraction + '00').slice(0, 2))).toString();
}
function statusLabel(status: FundingOrderDto['status']): string {
  switch (status) {
    case FundingOrderStatus.PENDING_PAYMENT: return '待支付';
    case FundingOrderStatus.PAID: return '已支付 · 金币已入账';
    case FundingOrderStatus.FAILED: return '支付失败';
    case FundingOrderStatus.CANCELLED: return '已关闭';
    case FundingOrderStatus.EXPIRED: return '已超时 · 请联系客服';
  }
}
function errorMessage(code: string): string {
  if (code === 'INVALID_ORDER_AMOUNT') return '金额无法按当前兑换比例换算为整数金币，请调整金额。';
  if (code === 'FUNDING_CHANNEL_UNAVAILABLE') return '支付渠道暂不可用，请刷新后重试。';
  if (code === 'FUNDING_ORDER_AMOUNT_MISMATCH') return '支付金额与订单不一致，金币没有入账。';
  if (code === 'FUNDING_ORDER_NOT_PAYABLE') return '订单已结束，刷新订单状态后继续。';
  if (code === 'FUNDING_ORDER_EXPIRED') return 'USDT 订单已超时，请联系客服处理或重新下单。';
  if (code === 'USDT_INVOICE_CAPACITY_REACHED') return '当前金额的订单较多，请稍后重试或调整充值金额。';
  return '操作没有完成，请重试。';
}
async function reload(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [availableChannels, currentOrders] = await Promise.all([props.application.listChannels(), props.application.listOrders()]);
    channels.value = availableChannels.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
    orders.value = currentOrders;
    if (!channelId.value && channels.value[0]) channelId.value = channels.value[0].channelId;
  } catch (cause) {
    error.value = errorMessage(cause instanceof Error ? cause.message : 'UNKNOWN');
  } finally {
    loading.value = false;
  }
}
async function createOrder(): Promise<void> {
  error.value = '';
  notice.value = '';
  const amountCnyFen = amountToFen(amountYuan.value);
  if (!channelId.value || !amountCnyFen) {
    error.value = '请输入有效金额，并选择支付方式。';
    return;
  }
  workingOrderId.value = 'creating';
  try {
    const order = await props.application.createOrder({ channelId: channelId.value, amountCnyFen, idempotencyKey: crypto.randomUUID() });
    amountYuan.value = '';
    notice.value = `订单已创建：${formatFen(order.amountCnyFen)} 元，支付成功后将入账 ${order.creditCoins} 金币。`;
    await reload();
  } catch (cause) {
    error.value = errorMessage(cause instanceof Error ? cause.message : 'UNKNOWN');
  } finally {
    workingOrderId.value = '';
  }
}
async function simulatePayment(order: FundingOrderDto): Promise<void> {
  error.value = '';
  notice.value = '';
  workingOrderId.value = order.orderId;
  let eventId = paymentEventKeys.get(order.orderId);
  if (!eventId) {
    eventId = crypto.randomUUID();
    paymentEventKeys.set(order.orderId, eventId);
  }
  try {
    const paid = await props.application.simulatePayment(order.usdtInvoice
      ? { orderId: order.orderId, paidAmountUsdtMilli: order.usdtInvoice.amountUsdtMilli, paymentEventId: eventId }
      : { orderId: order.orderId, paidAmountCnyFen: order.amountCnyFen, paymentEventId: eventId });
    notice.value = `本机模拟支付完成，${paid.creditCoins} 金币已写入本地账本。`;
    paymentEventKeys.delete(order.orderId);
    await reload();
    emit('completed');
  } catch (cause) {
    error.value = errorMessage(cause instanceof Error ? cause.message : 'UNKNOWN');
  } finally {
    workingOrderId.value = '';
  }
}

onMounted(() => void reload());
</script>

<template>
  <section class="player-wallet-funding" aria-label="充值购买金币">
    <div class="player-wallet-section-heading"><div><h3>充值购买金币</h3><p>按系统兑换比例购买；本页渠道与支付完成动作仅用于本机离线演练。</p></div><button type="button" :disabled="loading" @click="reload">刷新</button></div>
    <p v-if="error" class="player-wallet-flow-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="player-wallet-flow-notice" role="status">{{ notice }}</p>
    <p v-if="loading" class="player-wallet-flow-empty" aria-busy="true">正在读取支付方式和订单…</p>
    <template v-else>
      <form v-if="(props.view ?? 'all') !== 'orders'" class="player-wallet-funding-form" @submit.prevent="createOrder">
        <fieldset class="player-wallet-channel-picker"><legend>选择充值方式</legend><label v-for="channel in channels" :key="channel.channelId" :class="{ selected: channelId === channel.channelId }"><input v-model="channelId" type="radio" name="funding-channel" :value="channel.channelId" :disabled="workingOrderId !== ''" /><span><strong>{{ channel.displayName.replace(/ · .*/, '') }}</strong><small>{{ channel.displayName.includes('本机') || channel.displayName.includes('演练') ? '本机演练' : '官方渠道' }}</small></span></label></fieldset>
        <label><span>支付金额（元）</span><input v-model="amountYuan" inputmode="decimal" autocomplete="off" maxlength="12" placeholder="例如 10 或 10.50" :disabled="workingOrderId !== ''" /></label>
        <button class="panel-primary" type="submit" :disabled="workingOrderId !== '' || !channels.length">{{ workingOrderId === 'creating' ? '正在创建…' : '创建充值订单' }}</button>
      </form>
      <p v-if="!channels.length && (props.view ?? 'all') !== 'orders'" class="player-wallet-flow-empty">当前没有启用的支付方式。请刷新重试，若仍为空表示 API 尚未提供可用渠道。</p>
      <section v-if="(props.view ?? 'all') !== 'purchase'" class="player-wallet-funding-orders" aria-label="最近充值订单">
        <h4>最近订单</h4>
        <p v-if="!orders.length" class="player-wallet-flow-empty">还没有充值订单。创建订单后，可在本机完成一次明确标注的模拟支付。</p>
        <ol v-else>
          <li v-for="order in orders" :key="order.orderId">
            <div class="player-wallet-order-main"><strong>{{ order.channelName }} · ¥{{ formatFen(order.amountCnyFen) }}</strong><small>{{ order.orderNo }} · {{ new Date(order.createdAt).toLocaleString('zh-CN') }}</small><small v-if="order.usdtInvoice">应付 {{ order.usdtInvoice.displayAmountUsdt }} USDT · 汇率 ¥{{ order.usdtInvoice.rateCnyPerUsdt }}/USDT</small><small v-if="order.usdtInvoice">{{ order.usdtInvoice.depositAddress }}（本机演练标识，非 TRON 地址）</small><small v-if="order.usdtInvoice">有效至 {{ new Date(order.usdtInvoice.expiresAt).toLocaleString('zh-CN') }}；错额或超时请联系客服</small><small v-else>支付成功入账 {{ order.creditCoins }} 金币</small><small>{{ statusLabel(order.status) }}</small></div>
            <button v-if="order.status === FundingOrderStatus.PENDING_PAYMENT" type="button" class="player-wallet-simulate-payment" :disabled="workingOrderId !== ''" @click="simulatePayment(order)">{{ workingOrderId === order.orderId ? '正在确认…' : order.usdtInvoice ? '本机模拟链上到账' : '本机模拟支付成功' }}</button>
            <button v-if="order.usdtInvoice && order.status === FundingOrderStatus.EXPIRED" type="button" class="player-wallet-simulate-payment" @click="emit('contactSupport')">联系客服处理</button>
          </li>
        </ol>
      </section>
    </template>
    <small v-if="(props.view ?? 'all') !== 'orders'" class="player-wallet-local-note">本机模拟不会请求代理支付渠道或 TRON 网络。USDT 订单使用配置汇率快照，并在有效窗口内分配递增的 0.001 尾数；页面显示的演练标识不是可收款地址。只有生产收款服务创建的真实地址才可转账。</small>
  </section>
</template>
