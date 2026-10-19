<script setup lang="ts">
import { ElSelect } from 'element-plus';
import AdminSelectOption from '../components/AdminSelectOption.vue';
import { computed, onMounted, ref } from 'vue';
import {
  PaymentChannelStatus,
  PaymentMethod,
  PaymentProviderType,
  type PaymentChannelChangeDto,
  type PaymentChannelDto,
} from '@gameing/contracts/payment-channel';
import PageHelpOverlay from '../components/PageHelpOverlay.vue';
import { localPaymentChannelApplication } from '../platform/payment-channels/composition';
import type { PaymentChannelApplication } from '../platform/payment-channels/payment-channel-application';

const props = defineProps<{ application?: PaymentChannelApplication }>();
const application = props.application ?? localPaymentChannelApplication;
const isDevelopmentBuild = import.meta.env.DEV;
const methodOptions = [
  { value: PaymentMethod.ALIPAY, label: '支付宝' },
  { value: PaymentMethod.WECHAT, label: '微信' },
  { value: PaymentMethod.BANK_TRANSFER, label: '银行卡转账' },
  { value: PaymentMethod.UNIONPAY_QR, label: '银联二维码' },
  { value: PaymentMethod.DIGITAL_CNY, label: '数字人民币' },
  { value: PaymentMethod.USDT_TRON, label: 'USDT · TRON / TRC-20' },
] as const;
const statusOptions = [
  { value: PaymentChannelStatus.ACTIVE, label: '已启用' },
  { value: PaymentChannelStatus.DISABLED, label: '已停用' },
  { value: PaymentChannelStatus.MAINTENANCE, label: '维护中' },
] as const;
const records = ref<PaymentChannelDto[]>([]);
const changes = ref<PaymentChannelChangeDto[]>([]);
const keyword = ref('');
const methodFilter = ref<PaymentChannelDto['paymentMethod'] | ''>('');
const statusFilter = ref<PaymentChannelDto['status'] | ''>('');
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const notice = ref('');
const fieldError = ref('');
const createOpen = ref(false);
const editorOpen = ref(false);
const historyOpen = ref(false);
const selected = ref<PaymentChannelDto | null>(null);
const createForm = ref<{ providerCode: string; providerName: string; providerType: PaymentChannelDto['providerType']; paymentMethod: PaymentChannelDto['paymentMethod']; sortOrder: number; reason: string }>({ providerCode: '', providerName: '', providerType: PaymentProviderType.AGGREGATOR, paymentMethod: PaymentMethod.ALIPAY, sortOrder: 10, reason: '' });
const editForm = ref<{ providerName: string; sortOrder: number; status: PaymentChannelDto['status']; reason: string }>({ providerName: '', sortOrder: 0, status: PaymentChannelStatus.ACTIVE, reason: '' });
let pendingRequest: { signature: string; requestKey: string } | undefined;

const visibleRecords = computed(() => records.value);
const methodLabel = (method: PaymentChannelDto['paymentMethod']) => methodOptions.find((item) => item.value === method)?.label ?? '未知方式';
const statusLabel = (status: PaymentChannelDto['status']) => statusOptions.find((item) => item.value === status)?.label ?? '未知状态';
const providerTypeLabel = (type: PaymentChannelDto['providerType']) => type === PaymentProviderType.TRON_SELF_HOSTED ? '自建 · TRON' : '支付代理商';

function requestKey(signature: string): string {
  if (!pendingRequest || pendingRequest.signature !== signature) pendingRequest = { signature, requestKey: crypto.randomUUID() };
  return pendingRequest.requestKey;
}

function synchronizeProviderType(): void {
  createForm.value.providerType = createForm.value.paymentMethod === PaymentMethod.USDT_TRON
    ? PaymentProviderType.TRON_SELF_HOSTED
    : PaymentProviderType.AGGREGATOR;
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const normalizedKeyword = keyword.value.trim();
    const query = {
      ...(normalizedKeyword ? { keyword: normalizedKeyword } : {}),
      ...(methodFilter.value === '' ? {} : { paymentMethod: methodFilter.value }),
      ...(statusFilter.value === '' ? {} : { status: statusFilter.value }),
    };
    const result = await application.list(query);
    if (!result.ok) { error.value = '支付渠道数据不符合共享契约，请调整筛选后重试。'; return; }
    records.value = result.value.items;
  } catch {
    error.value = '本机渠道演练数据暂时无法读取，请重试。';
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  createForm.value = { providerCode: '', providerName: '', providerType: PaymentProviderType.AGGREGATOR, paymentMethod: PaymentMethod.ALIPAY, sortOrder: Math.max(0, ...records.value.map((item) => item.sortOrder)) + 10, reason: '' };
  fieldError.value = '';
  createOpen.value = true;
}

async function createChannel(): Promise<void> {
  if (saving.value) return;
  const signature = JSON.stringify(createForm.value);
  saving.value = true;
  fieldError.value = '';
  try {
    const result = await application.create({ requestKey: requestKey(signature), ...createForm.value });
    if (!result.ok) {
      fieldError.value = {
        INVALID_REQUEST: '请检查服务商代码、名称、展示顺序和必填原因。',
        CHANNEL_NOT_FOUND: '渠道已不存在，请刷新后重试。',
        PROVIDER_METHOD_TAKEN: '此服务商已配置该支付方式；不同服务商可重复提供同一方式。',
        PROVIDER_DETAILS_CONFLICT: '该服务商代码已存在；同一服务商的名称和接入类型必须保持一致。',
        PROVIDER_METHOD_TYPE_MISMATCH: 'USDT 必须选择自建 TRON；其余支付方式由支付代理公司提供。',
        REQUEST_KEY_REUSED: '请求编号已用于其他操作，请重新打开表单。',
      }[result.code];
      return;
    }
    pendingRequest = undefined;
    notice.value = `已在本机演练中创建 ${result.value.providerName} · ${methodLabel(result.value.paymentMethod)}。`;
    createOpen.value = false;
    keyword.value = result.value.providerCode;
    methodFilter.value = '';
    statusFilter.value = '';
    await refresh();
  } catch {
    fieldError.value = '保存状态尚未确认；保持内容后重试会复用同一请求编号。';
  } finally {
    saving.value = false;
  }
}

function openEditor(channel: PaymentChannelDto): void {
  selected.value = channel;
  editForm.value = { providerName: channel.providerName, sortOrder: channel.sortOrder, status: channel.status, reason: '' };
  fieldError.value = '';
  editorOpen.value = true;
}

async function saveEdit(): Promise<void> {
  if (!selected.value || saving.value) return;
  const signature = JSON.stringify([selected.value.channelId, editForm.value]);
  saving.value = true;
  fieldError.value = '';
  try {
    const result = await application.update({ requestKey: requestKey(signature), channelId: selected.value.channelId, ...editForm.value });
    if (!result.ok) {
      fieldError.value = {
        INVALID_REQUEST: '请检查名称、顺序和必填变更原因。',
        CHANNEL_NOT_FOUND: '渠道已不存在，请重新查询。',
        PROVIDER_METHOD_TAKEN: '此服务商已配置该支付方式。',
        PROVIDER_DETAILS_CONFLICT: '该服务商代码已存在；名称和接入类型不能单独修改。',
        PROVIDER_METHOD_TYPE_MISMATCH: '接入类型与支付方式不匹配。',
        REQUEST_KEY_REUSED: '请求编号已对应其他修改，请重新打开编辑。',
      }[result.code];
      return;
    }
    pendingRequest = undefined;
    notice.value = `已更新本机渠道「${result.value.providerName}」；生产列表尚未改变。`;
    editorOpen.value = false;
    await refresh();
  } catch {
    fieldError.value = '更新状态尚未确认；保留内容重试会复用原请求编号。';
  } finally {
    saving.value = false;
  }
}

async function openHistory(channel: PaymentChannelDto): Promise<void> {
  selected.value = channel;
  changes.value = [];
  fieldError.value = '';
  historyOpen.value = true;
  try {
    const result = await application.listChanges(channel.channelId);
    if (!result.ok) { error.value = '渠道变更审计暂时无法读取。'; return; }
    changes.value = result.value;
  } catch {
    error.value = '渠道变更审计暂时无法读取。';
  }
}

onMounted(() => { void refresh(); });
</script>

<template>
  <section class="domain-page payment-channels-page">
    <div class="domain-heading"><p class="eyebrow">支付与商品 / 商户接入</p><h1>支付渠道</h1><p>配置用户可选方式、服务商展示顺序和渠道状态。真实商户凭证只由服务端密钥管理，页面不接收或回显密码、私钥与签名密钥。</p></div>

    <section class="payment-methods-panel" aria-labelledby="payment-methods-title">
      <div class="agent-domain-section-heading"><div><h2 id="payment-methods-title">支持的支付方式</h2><p>同一方式可有多家服务商；用户创建订单时选择一个可用渠道，订单固定所选渠道。</p></div><PageHelpOverlay title="支付渠道范围说明" trigger-label="查看支付渠道说明" :sections="[{ heading: '代理商通道', body: '支付宝、微信、银行卡转账、银联二维码与数字人民币由支付代理公司提供，不表示平台直连这些支付体系。' }, { heading: 'USDT', body: '首期自建 TRON/TRC-20 收款监测；该渠道设置不会开放私钥，也不会产生链上地址或订单。' }, { heading: '本机演练', body: '本页仅把渠道目录和变更审计保存到当前浏览器 IndexedDB。创建、排序或停用均不会改变生产配置或玩家可用通道。' } ]" /></div>
      <div class="payment-method-chips"><span v-for="method in methodOptions" :key="method.value">{{ method.label }}</span></div>
      <p class="payment-method-help">渠道排序只影响可选列表的展示顺序；已创建订单仍固定原渠道。Mock 支付回调请进入开发环境的关联控制台。</p>
    </section>

    <p class="payment-channel-demo-banner" aria-label="本机演练范围"><strong>LOCAL_DEMO / 仅当前浏览器</strong><span>变更不发布到玩家大厅；凭证输入框和真实支付动作均不提供。</span></p>
    <p v-if="notice" class="payment-channel-feedback" role="status">{{ notice }}</p>
    <p v-if="error" class="payment-channel-error" role="alert">{{ error }} <button type="button" @click="refresh">重试</button></p>

    <section class="payment-channel-panel" aria-labelledby="payment-channel-title">
      <div class="agent-domain-section-heading"><div><h2 id="payment-channel-title">渠道目录</h2><p>按服务商代码/名称搜索。顺序越小越先显示；变更必须填写原因并保留审计快照。</p></div><span class="record-count">{{ visibleRecords.length }} 项</span></div>
      <form class="payment-channel-filters" @submit.prevent="refresh">
        <label><span>服务商 / Code</span><input v-model="keyword" type="search" placeholder="搜索当前本机渠道" /></label>
        <label><span>支付方式</span><el-select v-model="methodFilter"><AdminSelectOption value="">全部方式</AdminSelectOption><AdminSelectOption v-for="method in methodOptions" :key="method.value" :value="method.value">{{ method.label }}</AdminSelectOption></el-select></label>
        <label><span>状态</span><el-select v-model="statusFilter"><AdminSelectOption value="">全部状态</AdminSelectOption><AdminSelectOption v-for="status in statusOptions" :key="status.value" :value="status.value">{{ status.label }}</AdminSelectOption></el-select></label>
        <button type="submit" :disabled="loading">{{ loading ? '查询中…' : '查询' }}</button>
        <button class="payment-add-button" type="button" @click="openCreate">＋ 添加本机渠道</button>
      </form>
      <div class="payment-channel-table-wrap">
        <table><caption>本机演练支付渠道及操作</caption><thead><tr><th scope="col">服务商</th><th scope="col">方式</th><th scope="col">接入类型</th><th scope="col">排序</th><th scope="col">状态</th><th scope="col">环境</th><th scope="col">操作</th></tr></thead>
          <tbody>
            <tr v-if="loading"><td colspan="7"><div class="payment-channel-empty" role="status">正在读取本机渠道…</div></td></tr>
            <tr v-else-if="!visibleRecords.length"><td colspan="7"><div class="payment-channel-empty" role="status"><span class="user-empty-icon" aria-hidden="true">⌕</span><strong>暂无本机渠道</strong><p>添加渠道以演练方式、排序和状态维护；真实订单/支付不会因此启用。</p><button type="button" @click="openCreate">添加本机渠道</button></div></td></tr>
          <template v-else><tr v-for="channel in visibleRecords" :key="channel.channelId"><td><strong>{{ channel.providerName }}</strong><small class="payment-channel-subtitle"><code>{{ channel.providerCode }}</code></small></td><td>{{ methodLabel(channel.paymentMethod) }}</td><td>{{ providerTypeLabel(channel.providerType) }}</td><td>{{ channel.sortOrder }}</td><td><span class="payment-channel-status" :class="`status-${channel.status}`">{{ statusLabel(channel.status) }}</span></td><td><span class="local-channel-tag">LOCAL_DEMO</span></td><td><div class="catalog-row-actions"><button type="button" @click="openEditor(channel)">编辑</button><button type="button" @click="openHistory(channel)">历史</button><RouterLink v-if="channel.status === PaymentChannelStatus.ACTIVE && isDevelopmentBuild" class="payment-channel-mock-link" :to="{ path: '/admin/payments/mock', query: { channelId: channel.channelId } }">模拟</RouterLink></div></td></tr></template>
          </tbody>
        </table>
      </div>
      <div v-if="visibleRecords.length" class="payment-channel-mobile-list"><article v-for="channel in visibleRecords" :key="channel.channelId" class="payment-channel-mobile-card"><div><span class="payment-channel-status" :class="`status-${channel.status}`">{{ statusLabel(channel.status) }}</span><h3>{{ channel.providerName }}</h3><code>{{ channel.providerCode }}</code></div><p>{{ methodLabel(channel.paymentMethod) }} · {{ providerTypeLabel(channel.providerType) }}</p><small>排序 {{ channel.sortOrder }} · LOCAL_DEMO</small><div class="catalog-row-actions"><button type="button" @click="openEditor(channel)">编辑</button><button type="button" @click="openHistory(channel)">历史</button><RouterLink v-if="channel.status === PaymentChannelStatus.ACTIVE && isDevelopmentBuild" class="payment-channel-mock-link" :to="{ path: '/admin/payments/mock', query: { channelId: channel.channelId } }">模拟此渠道</RouterLink></div></article></div>
    </section>

    <section v-if="isDevelopmentBuild" class="mock-console-panel" aria-labelledby="mock-console-title"><div class="mock-console-heading"><div><p class="eyebrow">DEVELOPMENT / TEST ONLY</p><h2 id="mock-console-title">关联 Mock 支付演练</h2><p>模拟订单和回调由隔离的本机工作流处理，不调用真实通道，也不做资产履约。</p></div><span class="mock-console-lock">仅开发环境</span></div><RouterLink class="mock-console-link" to="/admin/payments/mock">打开本机演练控制台　›</RouterLink><p class="mock-safety-note">本机渠道配置不自动生成订单；Mock 成功只代表测试投影发生变化。</p></section>

    <Teleport to="body">
      <div v-if="createOpen" class="payment-channel-dialog-backdrop" @click.self="createOpen = false"><section class="payment-channel-dialog" role="dialog" aria-modal="true" aria-labelledby="payment-create-title">
        <header><div><p class="eyebrow">LOCAL_DEMO / 新增</p><h2 id="payment-create-title">添加本机支付渠道</h2><p>仅登记可选渠道信息，不连接服务商。</p></div><button type="button" aria-label="关闭" :disabled="saving" @click="createOpen = false">×</button></header>
        <div class="payment-channel-form-grid"><label>服务商稳定代码<input v-model="createForm.providerCode" maxlength="48" placeholder="mock-aggregator" /></label><label>服务商名称<input v-model="createForm.providerName" maxlength="80" placeholder="示例支付服务商" /></label><label>支付方式<el-select v-model.number="createForm.paymentMethod" @change="synchronizeProviderType"><AdminSelectOption v-for="method in methodOptions" :key="method.value" :value="method.value">{{ method.label }}</AdminSelectOption></el-select></label><label>接入类型<el-select v-model.number="createForm.providerType"><AdminSelectOption :value="PaymentProviderType.AGGREGATOR">支付代理公司</AdminSelectOption><AdminSelectOption :value="PaymentProviderType.TRON_SELF_HOSTED">自建 TRON</AdminSelectOption></el-select></label><label>展示顺序<input v-model.number="createForm.sortOrder" type="number" min="0" max="1000000" step="1" /></label><label class="payment-channel-reason">新增原因<textarea v-model="createForm.reason" minlength="3" maxlength="500" rows="2" placeholder="填写至少 3 个字符的原因" /></label></div>
        <p v-if="fieldError" class="payment-channel-error" role="alert">{{ fieldError }}</p><footer><button type="button" :disabled="saving" @click="createOpen = false">取消</button><button type="button" class="payment-channel-primary" :disabled="saving" @click="createChannel">{{ saving ? '保存中…' : '保存本机版本' }}</button></footer>
      </section></div>

      <div v-if="editorOpen && selected" class="payment-channel-dialog-backdrop" @click.self="editorOpen = false"><section class="payment-channel-dialog" role="dialog" aria-modal="true" aria-labelledby="payment-edit-title">
        <header><div><p class="eyebrow">LOCAL_DEMO / 目录编辑</p><h2 id="payment-edit-title">编辑 {{ selected.providerName }}</h2><p>{{ selected.providerCode }} · {{ methodLabel(selected.paymentMethod) }}</p></div><button type="button" aria-label="关闭" :disabled="saving" @click="editorOpen = false">×</button></header>
        <div class="payment-channel-form-grid"><label>服务商展示名<input v-model="editForm.providerName" maxlength="80" /></label><label>展示顺序<input v-model.number="editForm.sortOrder" type="number" min="0" max="1000000" step="1" /></label><label>渠道状态<el-select v-model.number="editForm.status"><AdminSelectOption v-for="status in statusOptions" :key="status.value" :value="status.value">{{ status.label }}</AdminSelectOption></el-select></label><label class="payment-channel-reason">变更原因<textarea v-model="editForm.reason" minlength="3" maxlength="500" rows="2" placeholder="填写至少 3 个字符的原因" /></label></div>
        <p v-if="fieldError" class="payment-channel-error" role="alert">{{ fieldError }}</p><footer><button type="button" :disabled="saving" @click="editorOpen = false">取消</button><button type="button" class="payment-channel-primary" :disabled="saving" @click="saveEdit">{{ saving ? '保存中…' : '保存本机版本' }}</button></footer>
      </section></div>

      <div v-if="historyOpen && selected" class="payment-channel-dialog-backdrop" @click.self="historyOpen = false"><section class="payment-channel-dialog payment-channel-history-dialog" role="dialog" aria-modal="true" aria-labelledby="payment-history-title">
        <header><div><p class="eyebrow">LOCAL_DEMO / APPEND-ONLY</p><h2 id="payment-history-title">{{ selected.providerName }} · 变更历史</h2><p>{{ selected.providerCode }} · {{ methodLabel(selected.paymentMethod) }}</p></div><button type="button" aria-label="关闭历史" @click="historyOpen = false">×</button></header>
        <div v-if="changes.length" class="payment-channel-history-list"><article v-for="change in changes" :key="change.changeId"><strong>{{ change.previous ? '渠道更新' : '新增渠道' }}</strong><small>{{ new Date(change.createdAt).toLocaleString() }} · {{ change.reason }}</small><p>{{ change.previous ? `${statusLabel(change.previous.status)} → ` : '' }}{{ statusLabel(change.next.status) }} · 顺序 {{ change.next.sortOrder }}</p></article></div><p v-else class="payment-channel-history-empty">暂无变更记录。</p>
        <footer><button type="button" @click="historyOpen = false">关闭</button></footer>
      </section></div>
    </Teleport>
  </section>
</template>
