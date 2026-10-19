<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { PayoutChannelType, WithdrawalStatus, type CreatePayoutAccountRequestDto, type PayoutAccountDto, type WithdrawalDto, type WithdrawalQuoteDto } from '@gameing/contracts/wallet';
import PlayerAppSelect from './PlayerAppSelect.vue';
import type { WalletApplication } from '../platform/wallet/wallet-application';

const props = defineProps<{ wallet: WalletApplication; turnoverRemaining: string; availableCnyFen: string; view?: 'all' | 'withdraw' | 'history' | 'accounts' }>();
const emit = defineEmits<{ completed: []; manageAccounts: [] }>();
const channels = [
  { value: PayoutChannelType.ALIPAY, label: '支付宝' }, { value: PayoutChannelType.WECHAT_PAY, label: '微信支付' },
  { value: PayoutChannelType.BANK_TRANSFER, label: '银行卡转账' }, { value: PayoutChannelType.UNIONPAY_QR, label: '银联二维码' },
  { value: PayoutChannelType.DIGITAL_CNY, label: '数字人民币' },
];
const channelOptions = channels.map(({ value, label }) => ({ value, label }));
const accounts = ref<PayoutAccountDto[]>([]);
const withdrawals = ref<WithdrawalDto[]>([]);
const channelType = ref<number>(PayoutChannelType.ALIPAY);
const accountLabel = ref('');
const accountReference = ref('');
const amountYuan = ref('');
const selectedAccountId = ref('');
const commonAccountsOpen = ref(false);
const quote = ref<WithdrawalQuoteDto>();
const busy = ref(false);
const error = ref('');
const feedback = ref('');
const phase = ref<'idle' | 'quote' | 'confirm'>('idle');
const turnoverDialogOpen = ref(false);
const remainingTurnover = ref(props.turnoverRemaining);
watch(() => props.turnoverRemaining, (value) => { remainingTurnover.value = value; });
const channelName = (value: number) => channels.find((item) => item.value === value)?.label ?? '收款方式';
const selectedAccount = computed(() => accounts.value.find((item) => item.payoutAccountId === selectedAccountId.value));
const recipientName = (account: PayoutAccountDto) => account.accountLabel.split(' · ').slice(1).join(' · ') || account.accountLabel;
const turnoverRemainingLabel = () => /^\d+$/.test(remainingTurnover.value) ? BigInt(remainingTurnover.value).toLocaleString('zh-CN') : '—';
const statusName = (status: number) => ({
  [WithdrawalStatus.REQUESTED]: '待审核', [WithdrawalStatus.REVIEWING]: '审核中', [WithdrawalStatus.APPROVED]: '已通过',
  [WithdrawalStatus.PAYING]: '出款中', [WithdrawalStatus.SUCCEEDED]: '已完成', [WithdrawalStatus.REJECTED]: '已拒绝',
  [WithdrawalStatus.CANCELLED]: '已取消', [WithdrawalStatus.PAYMENT_UNKNOWN]: '结果待核实', [WithdrawalStatus.FAILED]: '出款失败',
} as Record<number, string>)[status] ?? '处理中';
function yuanToFen(value: string): string | null {
  const normalized = value.trim();
  if (!/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  return (BigInt(whole!) * 100n + BigInt((fraction + '00').slice(0, 2))).toString();
}
function fen(value: string): string {
  const amount = BigInt(value);
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}
async function load(): Promise<void> {
  try {
    const [accountList, withdrawalList] = await Promise.all([props.wallet.listPayoutAccounts(), props.wallet.listWithdrawals()]);
    accounts.value = accountList; withdrawals.value = withdrawalList;
    if (!selectedAccountId.value) selectedAccountId.value = accountList.find((item) => item.isDefault)?.payoutAccountId ?? accountList[0]?.payoutAccountId ?? '';
  } catch { error.value = '提现资料暂时无法读取，请重试。'; }
}
async function addAccount(): Promise<void> {
  error.value = ''; feedback.value = '';
  const label = accountLabel.value.trim(); const reference = accountReference.value.trim();
  if (!label || !/^[A-Za-z0-9_-]{4,64}$/.test(reference)) { error.value = '请填写收款人名称，并填写 4–64 位演示账号标识（英文字母、数字、下划线或短横线）。'; return; }
  busy.value = true;
  try {
    const request: CreatePayoutAccountRequestDto = { channelType: channelType.value as CreatePayoutAccountRequestDto['channelType'], accountLabel: label, accountReference: reference, idempotencyKey: crypto.randomUUID() };
    const saved = await props.wallet.createPayoutAccount(request); accounts.value = await props.wallet.listPayoutAccounts(); selectedAccountId.value = saved.payoutAccountId;
    accountLabel.value = ''; accountReference.value = ''; feedback.value = '常用收款方式已保存到本机演示列表，仅显示账号末四位。';
  } catch { error.value = '收款方式没有保存，请检查后重试。'; }
  finally { busy.value = false; }
}
async function removeAccount(account: PayoutAccountDto): Promise<void> {
  busy.value = true; error.value = '';
  try { await props.wallet.deletePayoutAccount(account.payoutAccountId); selectedAccountId.value = ''; accounts.value = await props.wallet.listPayoutAccounts(); selectedAccountId.value = accounts.value[0]?.payoutAccountId ?? ''; quote.value = undefined; phase.value = 'idle'; }
  catch { error.value = '该收款方式正在提现流程中，暂时不能删除。'; }
  finally { busy.value = false; }
}
function chooseAccount(account: PayoutAccountDto): void {
  selectedAccountId.value = account.payoutAccountId;
  commonAccountsOpen.value = false;
  quote.value = undefined;
  phase.value = 'idle';
  error.value = '';
}
async function requestQuote(): Promise<void> {
  const amount = yuanToFen(amountYuan.value);
  if (!selectedAccountId.value) { error.value = '请先添加并选择收款方式。'; return; }
  if (!amount) { error.value = '请输入有效的人民币金额，最多两位小数。'; return; }
  error.value = ''; feedback.value = ''; busy.value = true;
  try { quote.value = await props.wallet.quoteWithdrawal({ payoutAccountId: selectedAccountId.value, netCnyFen: amount }); phase.value = 'quote'; }
  catch (cause) {
    const code = (cause as { code?: string })?.code;
    error.value = code === 'INSUFFICIENT_AVAILABLE_BALANCE' ? '余额不足以覆盖到账金额和手续费。' : code === 'WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID' ? '提现金额必须达到最低金额，且为最低金额的整数倍。' : code === 'WITHDRAWAL_IDENTITY_REQUIRED' ? '请先绑定并验证邮箱或手机，或设置用户名和密码。' : '暂时无法生成提现报价，请检查账户和金额后重试。';
  } finally { busy.value = false; }
}
async function submit(): Promise<void> {
  if (!quote.value) return;
  busy.value = true; error.value = ''; feedback.value = '';
  try {
    const created = await props.wallet.createWithdrawal({ quote: quote.value, idempotencyKey: crypto.randomUUID() });
    withdrawals.value = [created, ...(await props.wallet.listWithdrawals()).filter((item) => item.withdrawalId !== created.withdrawalId)];
    quote.value = undefined; phase.value = 'idle'; amountYuan.value = ''; feedback.value = `申请已提交，${created.payoutNotBeforeAt.slice(0, 10)} 后才可进入线下出款流程。`; emit('completed');
  } catch (cause) {
    if ((cause as { code?: string })?.code === 'TURNOVER_INCOMPLETE') {
      try { remainingTurnover.value = (await props.wallet.getSummary()).turnover.remainingCoins; } catch { /* Keep the last summary if the refresh is offline. */ }
      turnoverDialogOpen.value = true;
    } else error.value = '申请没有提交，余额和申请状态未改变。请刷新报价后重试。';
  }
  finally { busy.value = false; }
}
async function cancel(withdrawal: WithdrawalDto): Promise<void> {
  busy.value = true; error.value = '';
  try { await props.wallet.cancelWithdrawal(withdrawal.withdrawalId); withdrawals.value = await props.wallet.listWithdrawals(); feedback.value = '提现申请已取消，冻结余额已释放。'; emit('completed'); }
  catch { error.value = '当前申请状态不能取消，请刷新状态。'; }
  finally { busy.value = false; }
}
onMounted(() => { void load(); });
</script>

<template>
  <section class="player-withdrawal-workspace" aria-label="提现与收款方式">
      <p v-if="props.view === 'accounts' || !props.view || props.view === 'all'" class="player-withdrawal-local-note">这是浏览器本机演示账户，不连接支付渠道，也不会实际打款。请勿填写真实收款账号。</p>
      <p class="player-withdrawal-balance">当前可用余额：¥{{ fen(availableCnyFen) }}</p>
      <div v-if="props.view === 'accounts' || !props.view || props.view === 'all'" class="player-withdrawal-account-form">
        <label>收款方式<PlayerAppSelect v-model="channelType" label="收款方式" :options="channelOptions" /></label>
        <label>收款人名称<input v-model="accountLabel" maxlength="48" placeholder="请输入收款人姓名" /></label>
        <label>演示账号标识（仅本机）<input v-model="accountReference" maxlength="64" autocomplete="off" placeholder="填写任意测试值，不要填真实账号" /></label>
        <button type="button" :disabled="busy" @click="addAccount">保存常用收款方式</button>
      </div>
      <ul v-if="accounts.length && (props.view === 'accounts' || !props.view || props.view === 'all')" class="player-withdrawal-accounts"><li v-for="account in accounts" :key="account.payoutAccountId"><label><input v-model="selectedAccountId" type="radio" name="withdrawal-account" :value="account.payoutAccountId" /><span><strong>{{ channelName(account.channelType) }} · {{ recipientName(account) }}</strong><small>{{ account.maskedAccount }}{{ account.isDefault ? ' · 默认' : '' }}</small></span></label><button v-if="props.view === 'accounts' || !props.view" type="button" :disabled="busy" :aria-label="`删除${account.accountLabel}`" @click="removeAccount(account)">删除</button></li></ul>
      <div v-if="props.view === 'withdraw'" class="player-withdrawal-recipient">
        <div class="player-withdrawal-recipient-fields"><label>收款方式<input readonly :value="selectedAccount ? channelName(selectedAccount.channelType) : ''" placeholder="请选择常用收款方式" /></label><label>收款人名称<input readonly :value="selectedAccount ? recipientName(selectedAccount) : ''" placeholder="选择后自动填入" /></label></div>
        <button type="button" class="player-withdrawal-common-picker" :disabled="!accounts.length" @click="commonAccountsOpen = true">常用收款方式 <span>{{ selectedAccount ? '更换' : '请选择' }}</span></button>
        <p v-if="!accounts.length" class="player-withdrawal-empty">还没有常用收款方式。请先到收款账户设置添加。</p>
      </div>
      <p v-if="(props.view === 'accounts' || !props.view || props.view === 'all') && !accounts.length" class="player-withdrawal-empty">尚未保存常用收款方式。</p>
      <div v-if="props.view === 'withdraw' || !props.view || props.view === 'all'" class="player-withdrawal-request">
        <label>净到账金额（元）<input v-model="amountYuan" inputmode="decimal" autocomplete="off" placeholder="例如 100" :disabled="!selectedAccount" /></label>
        <button type="button" :disabled="busy || !selectedAccount" @click="requestQuote">{{ busy ? '处理中…' : '计算到账与手续费' }}</button>
      </div>
      <section v-if="quote && phase === 'quote'" class="player-withdrawal-quote" aria-label="提现确认摘要">
        <h3>确认提现申请</h3><dl><div><dt>收款方式</dt><dd>{{ quote.payoutAccountLabel }} · {{ quote.maskedAccount }}</dd></div><div><dt>实际到账</dt><dd>¥{{ fen(quote.netCnyFen) }}</dd></div><div><dt>手续费（{{ quote.feeRateBps / 100 }}%）</dt><dd>¥{{ fen(quote.feeCnyFen) }}</dd></div><div><dt>冻结总额</dt><dd>¥{{ fen(quote.debitCnyFen) }}</dd></div><div><dt>可申请时间</dt><dd>{{ new Date(quote.payoutNotBeforeAt).toLocaleString('zh-CN') }}</dd></div><div><dt>报价有效至</dt><dd>{{ new Date(quote.expiresAt).toLocaleTimeString('zh-CN') }}</dd></div></dl>
        <div class="player-withdrawal-confirm"><button type="button" @click="phase = 'idle'; quote = undefined">返回修改</button><button type="button" :disabled="busy" @click="submit">确认申请并冻结余额</button></div>
      </section>
      <p v-if="feedback" class="player-withdrawal-feedback" role="status">{{ feedback }}</p><p v-if="error" class="player-withdrawal-error" role="alert">{{ error }}</p>
      <section v-if="withdrawals.length && (props.view === 'history' || props.view === 'withdraw' || !props.view || props.view === 'all')" class="player-withdrawal-history"><h3>{{ props.view === 'history' ? '提现记录' : '最近申请' }}</h3><article v-for="item in withdrawals" :key="item.withdrawalId"><div><strong>¥{{ fen(item.netCnyFen) }} 到账 · {{ statusName(item.status) }}</strong><small>{{ item.payoutAccountLabel }} · {{ item.maskedAccount }} · 冻结 ¥{{ fen(item.debitCnyFen) }}</small></div><button v-if="item.status === WithdrawalStatus.REQUESTED && props.view !== 'history'" type="button" :disabled="busy" @click="cancel(item)">取消申请</button></article></section>
      <p v-else-if="props.view === 'history'" class="player-withdrawal-empty">暂无提现记录。</p>
      <Teleport to="body"><div v-if="commonAccountsOpen" class="player-withdrawal-picker-scrim" role="presentation" @click.self="commonAccountsOpen = false"><section class="player-withdrawal-picker" role="dialog" aria-modal="true" aria-labelledby="player-withdrawal-picker-title"><header><h3 id="player-withdrawal-picker-title">选择常用收款方式</h3><button type="button" aria-label="关闭收款方式列表" @click="commonAccountsOpen = false">×</button></header><button v-for="account in accounts" :key="account.payoutAccountId" type="button" class="player-withdrawal-account-option" :class="{ selected: account.payoutAccountId === selectedAccountId }" @click="chooseAccount(account)"><span class="player-withdrawal-account-option-icon">{{ channelName(account.channelType).slice(0, 1) }}</span><span><strong>{{ channelName(account.channelType) }}</strong><small>{{ recipientName(account) }} · {{ account.maskedAccount }}{{ account.isDefault ? ' · 默认' : '' }}</small></span><span aria-hidden="true">{{ account.payoutAccountId === selectedAccountId ? '✓' : '›' }}</span></button><button type="button" class="player-withdrawal-manage-link" @click="commonAccountsOpen = false; emit('manageAccounts')">收款账户设置</button></section></div></Teleport>
      <Teleport to="body"><div v-if="turnoverDialogOpen" class="player-withdrawal-turnover-scrim" role="presentation" @click.self="turnoverDialogOpen = false"><section class="player-withdrawal-turnover-dialog" role="alertdialog" aria-modal="true" aria-labelledby="player-withdrawal-turnover-title" aria-describedby="player-withdrawal-turnover-copy"><span aria-hidden="true">⌛</span><h3 id="player-withdrawal-turnover-title">暂时无法提交提现</h3><p id="player-withdrawal-turnover-copy">有效下注流水还差 <strong>{{ turnoverRemainingLabel() }}</strong> 金币。完成后可以重新申请。</p><button type="button" @click="turnoverDialogOpen = false">知道了</button></section></div></Teleport>
  </section>
</template>
