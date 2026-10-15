<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  MockPaymentEventOutcome,
  MockPaymentOrderStatus,
  MockPaymentScenario,
  type MockPaymentEventDto,
  type MockPaymentOrderDto,
} from '@gameing/contracts/mock-payment';
import PageHelpOverlay from '../components/PageHelpOverlay.vue';
import { localMockPaymentApplication } from '../platform/mock-payment/composition';
import { PaymentChannelStatus, PaymentMethod, type PaymentChannelDto } from '@gameing/contracts/payment-channel';
import { localPaymentChannelApplication } from '../platform/payment-channels/composition';
import { useRoute } from 'vue-router';

const route = useRoute();
const scenarios = [
  { key: MockPaymentScenario.SUCCESS, title: '成功回调', expected: '本机订单进入模拟成功态，不执行支付或金币履约。', checks: '订单状态迁移 · 幂等请求' },
  { key: MockPaymentScenario.FAILURE, title: '失败回调', expected: '本机订单进入模拟失败态；不创建资产分录。', checks: '失败终态 · 重复提交保护' },
  { key: MockPaymentScenario.TIMEOUT, title: '超时', expected: '本机订单进入模拟超时态；不推断支付成功。', checks: '超时状态 · 查询恢复' },
  { key: MockPaymentScenario.DUPLICATE, title: '重复回调', expected: '重放同一 provider event ID；只记录一次状态迁移。', checks: 'provider event 去重 · 幂等' },
  { key: MockPaymentScenario.AMOUNT_MISMATCH, title: '金额错配', expected: '金额不符进入本机复核态，不产生资产履约。', checks: '币种/金额核对 · 复核状态' },
] as const;
const localOnlyHelp = [
  { heading: '演练范围', body: '订单与事件仅保存在当前浏览器进程内存，刷新或关闭页面后清空。场景 handler 只改变本机测试投影，不访问支付服务商、订单 API、钱包、数据库或 Redis。' },
  { heading: '成功场景', body: '“成功回调”表示本机测试订单进入模拟成功态，不是支付到账，不触发金币发放、返点、余额变化或账本写入。' },
  { heading: '正式环境', body: '正式订单只能由服务端验证 provider 事件并调用支付/履约用例。生产构建不注册此路由，生产服务端必须拒绝 Mock 命令。' },
];

const orders = ref<MockPaymentOrderDto[]>([]);
const events = ref<MockPaymentEventDto[]>([]);
const selectedOrderId = ref('');
const amountCny = ref('');
const channels = ref<PaymentChannelDto[]>([]);
const selectedChannelId = ref('');
const message = ref('');
const error = ref('');
const busy = ref(false);
const selectedOrder = computed(() => orders.value.find((order) => order.orderId === selectedOrderId.value) ?? null);
const selectedEvents = computed(() => events.value.filter((event) => event.orderId === selectedOrderId.value));
const originalOrderId = computed(() => typeof route.query.orderId === 'string' ? route.query.orderId : '');
const requestedChannelId = computed(() => typeof route.query.channelId === 'string' ? route.query.channelId : '');

function requestKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function orderStatusLabel(status: number): string {
  return ({
    [MockPaymentOrderStatus.PENDING]: '待模拟',
    [MockPaymentOrderStatus.SIMULATED_SUCCESS]: '模拟成功',
    [MockPaymentOrderStatus.SIMULATED_FAILURE]: '模拟失败',
    [MockPaymentOrderStatus.SIMULATED_TIMEOUT]: '模拟超时',
    [MockPaymentOrderStatus.REVIEW_REQUIRED]: '需复核',
  } as Record<number, string>)[status] ?? '未知状态';
}

function eventOutcomeLabel(outcome: MockPaymentEventDto['outcome']): string {
  return ({
    [MockPaymentEventOutcome.APPLIED_TO_LOCAL_ORDER]: '已作用于本机订单',
    [MockPaymentEventOutcome.DUPLICATE_IGNORED]: '重复事件已忽略',
    [MockPaymentEventOutcome.REVIEW_REQUIRED]: '进入复核态',
  })[outcome];
}

function scenarioTitle(scenario: MockPaymentEventDto['scenario']): string {
  return scenarios.find((item) => item.key === scenario)?.title ?? '模拟事件';
}

function paymentMethodLabel(method: PaymentChannelDto['paymentMethod']): string {
  return ({
    [PaymentMethod.ALIPAY]: '支付宝', [PaymentMethod.WECHAT]: '微信', [PaymentMethod.BANK_TRANSFER]: '银行卡转账',
    [PaymentMethod.UNIONPAY_QR]: '银联二维码', [PaymentMethod.DIGITAL_CNY]: '数字人民币', [PaymentMethod.USDT_TRON]: 'USDT · TRON',
  } as const)[method];
}

function failureMessage(code: string): string {
  return ({
    INVALID_REQUEST: '提交内容不符合模拟协议，请检查后重试。',
    INVALID_AMOUNT: '金额请填写 0.01 至 1,000,000.00 之间的两位小数。',
    CHANNEL_UNAVAILABLE: '所选渠道不存在或已停用；请重新选择可用渠道。',
    ORDER_NOT_FOUND: '本机测试单已不存在，请重新创建。',
    ORDER_TERMINAL: '该订单已进入终态；可重放已有事件，但不能再次模拟状态迁移。',
    DUPLICATE_SOURCE_MISSING: '当前订单还没有原始 provider event，暂时不能重放。',
    REQUEST_KEY_REUSED: '本次请求标识已用于其他操作，请重试。',
  } as Record<string, string>)[code] ?? '本机模拟操作未完成，请重试。';
}

async function reloadProjection(): Promise<void> {
  const [orderResult, eventResult] = await Promise.all([
    localMockPaymentApplication.listOrders(),
    localMockPaymentApplication.listEvents(),
  ]);
  if (!orderResult.ok || !eventResult.ok) {
    error.value = '本机测试记录暂时无法读取。';
    return;
  }
  orders.value = orderResult.value;
  events.value = eventResult.value;
  if (!orders.value.some((order) => order.orderId === selectedOrderId.value)) {
    selectedOrderId.value = orders.value.at(-1)?.orderId ?? '';
  }
}

async function reloadChannels(): Promise<void> {
  const result = await localPaymentChannelApplication.list({ status: PaymentChannelStatus.ACTIVE });
  if (!result.ok) { error.value = '支付渠道目录暂时无法读取，请重试。'; return; }
  channels.value = result.value.items;
  const requested = channels.value.find((channel) => channel.channelId === requestedChannelId.value);
  if (requested) selectedChannelId.value = requested.channelId;
  else if (!channels.value.some((channel) => channel.channelId === selectedChannelId.value)) selectedChannelId.value = channels.value[0]?.channelId ?? '';
  if (requestedChannelId.value && !requested) message.value = '链接中的渠道不存在或已停用，请选择其他可用渠道。';
}

async function selectOrderFromRoute(orderId: string): Promise<void> {
  await reloadProjection();
  if (!orderId) return;
  if (orders.value.some((order) => order.orderId === orderId)) {
    selectedOrderId.value = orderId;
    message.value = '';
    return;
  }
  message.value = '链接中的订单不属于当前本机测试会话；请创建或选择本机测试单。';
}

async function createTestOrder(): Promise<void> {
  if (busy.value || !selectedChannelId.value) return;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    const result = await localMockPaymentApplication.createOrder({ amountCny: amountCny.value.trim(), paymentChannelId: selectedChannelId.value, requestKey: requestKey() });
    if (!result.ok) {
      error.value = failureMessage(result.code);
      return;
    }
    selectedOrderId.value = result.value.orderId;
    message.value = `已创建本机测试单 ${result.value.orderId}，金额 ¥${result.value.amountCny}。`;
    await reloadProjection();
  } catch {
    error.value = '本机测试单未创建，请保留金额后重试。';
  } finally {
    busy.value = false;
  }
}

async function runScenario(scenario: typeof scenarios[number]['key']): Promise<void> {
  if (!selectedOrder.value || busy.value) return;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    const result = await localMockPaymentApplication.applyScenario({ orderId: selectedOrder.value.orderId, scenario, requestKey: requestKey() });
    if (!result.ok) {
      error.value = failureMessage(result.code);
      return;
    }
    message.value = `${scenarioTitle(result.value.event.scenario)}：${eventOutcomeLabel(result.value.event.outcome)}。仅更新本机测试投影。`;
    await reloadProjection();
  } catch {
    error.value = '本机模拟事件未保存，请重试。';
  } finally {
    busy.value = false;
  }
}

function canRunScenario(scenario: typeof scenarios[number]['key']): boolean {
  if (!selectedOrder.value || busy.value) return false;
  if (scenario === MockPaymentScenario.DUPLICATE) return selectedEvents.value.some((event) => event.outcome !== MockPaymentEventOutcome.DUPLICATE_IGNORED);
  return selectedOrder.value.status === MockPaymentOrderStatus.PENDING;
}

onMounted(() => { void reloadChannels(); void selectOrderFromRoute(originalOrderId.value); });
watch(originalOrderId, (orderId) => { void selectOrderFromRoute(orderId); });
watch(requestedChannelId, () => { void reloadChannels(); });
</script>

<template>
  <section class="domain-page mock-payment-page">
    <RouterLink to="/admin/payments/channels" class="back-link">← 返回支付渠道</RouterLink>
    <div class="mock-page-heading">
      <div class="domain-heading">
        <p class="eyebrow">支付与商品 / 开发测试工具</p>
        <h1>Mock 支付控制台</h1>
        <p>创建隔离的本机测试订单，演练事件状态转换和幂等结果。</p>
      </div>
      <div class="mock-page-heading-actions"><span class="mock-local-pill">本机测试</span><PageHelpOverlay title="Mock 支付控制台使用说明" trigger-label="查看 Mock 支付控制台使用说明" :sections="localOnlyHelp" /></div>
    </div>

    <section class="mock-order-context" aria-labelledby="mock-order-context-title">
      <div class="agent-domain-section-heading"><div><h2 id="mock-order-context-title">本机测试订单</h2><p>订单只存在于当前页面会话；刷新后清空。</p></div><span class="record-count">{{ orders.length }} 个</span></div>
      <form class="mock-order-query" @submit.prevent="createTestOrder">
        <label><span>模拟订单金额（CNY）</span><input v-model="amountCny" inputmode="decimal" autocomplete="off" maxlength="11" placeholder="例如 200.00" /></label>
        <label><span>关联可用支付渠道</span><select v-model="selectedChannelId"><option value="">请选择渠道</option><option v-for="channel in channels" :key="channel.channelId" :value="channel.channelId">{{ channel.providerName }} · {{ paymentMethodLabel(channel.paymentMethod) }}</option></select></label>
        <button class="mock-create-order" type="submit" :disabled="busy || !selectedChannelId">{{ busy ? '处理中…' : '创建本机测试单' }}</button>
      </form>
      <p v-if="!channels.length" class="mock-order-empty">没有已启用的本机渠道。<RouterLink to="/admin/payments/channels">返回渠道目录并添加渠道</RouterLink></p>
      <div v-if="orders.length" class="mock-order-selection">
        <label for="mock-order-select">选择测试订单</label>
        <select id="mock-order-select" v-model="selectedOrderId" @change="message = ''; error = ''">
          <option v-for="order in orders" :key="order.orderId" :value="order.orderId">{{ order.orderId }} · ¥{{ order.amountCny }} · {{ orderStatusLabel(order.status) }}</option>
        </select>
      </div>
      <dl v-if="selectedOrder" class="mock-selected-order">
        <div><dt>订单 ID</dt><dd>{{ selectedOrder.orderId }}</dd></div>
        <div><dt>金额</dt><dd>¥{{ selectedOrder.amountCny }} CNY</dd></div>
        <div><dt>渠道快照</dt><dd>{{ selectedOrder.paymentChannel.providerName }} · {{ paymentMethodLabel(selectedOrder.paymentChannel.paymentMethod) }} · {{ selectedOrder.paymentChannel.providerCode }}</dd></div>
        <div><dt>状态</dt><dd>{{ orderStatusLabel(selectedOrder.status) }}</dd></div>
      </dl>
      <div v-else class="mock-order-empty"><strong>暂无本机测试单</strong></div>
    </section>

    <p v-if="message" class="mock-local-result" role="status">{{ message }}</p>
    <p v-if="error" class="mock-local-error" role="alert">{{ error }}</p>

    <section class="mock-scenario-panel" aria-labelledby="mock-scenarios-title">
      <div class="agent-domain-section-heading"><div><h2 id="mock-scenarios-title">支付事件场景</h2><p>场景只转移本机测试订单状态，不执行实际支付或资产履约。</p></div><span class="record-count">{{ scenarios.length }} 个场景</span></div>
      <div class="mock-page-scenarios">
        <article v-for="scenario in scenarios" :key="scenario.key" class="mock-page-scenario">
          <div class="mock-page-scenario-heading"><span class="mock-scenario-mark" aria-hidden="true">{{ scenario.key === MockPaymentScenario.SUCCESS ? '✓' : scenario.key === MockPaymentScenario.DUPLICATE ? '↻' : scenario.key === MockPaymentScenario.AMOUNT_MISMATCH ? '!' : '…' }}</span><div><h3>{{ scenario.title }}</h3><p>{{ scenario.expected }}</p></div></div>
          <div class="mock-page-check"><span>覆盖校验</span><strong>{{ scenario.checks }}</strong></div>
          <button type="button" :disabled="!canRunScenario(scenario.key)" @click="runScenario(scenario.key)">{{ busy ? '处理中…' : scenario.key === MockPaymentScenario.DUPLICATE ? '重放原事件' : '模拟此场景' }}</button>
        </article>
      </div>
    </section>

    <section class="mock-event-log" aria-labelledby="mock-event-log-title">
      <div class="agent-domain-section-heading"><div><h2 id="mock-event-log-title">本机模拟事件记录</h2><p>按事件 ID 与订单关联查看处理结果；全部内容属于当前浏览器会话。</p></div><span class="record-count">{{ selectedEvents.length }} 条</span></div>
      <div v-if="selectedEvents.length" class="mock-event-list">
        <article v-for="event in [...selectedEvents].reverse()" :key="event.eventId" class="mock-event-row">
          <div><strong>{{ scenarioTitle(event.scenario) }}</strong><small>{{ event.eventId }} · provider {{ event.providerEventId }}</small></div>
          <div><span>{{ eventOutcomeLabel(event.outcome) }}</span><small>实收模拟值 ¥{{ event.receivedAmountCny }}</small></div>
          <p>{{ event.message }}</p>
        </article>
      </div>
      <div v-else class="mock-event-empty" role="status"><span aria-hidden="true">⌕</span><strong>暂无模拟事件</strong><p>选择本机测试单后运行任一事件场景。</p></div>
    </section>
  </section>
</template>
