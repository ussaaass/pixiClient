<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WalletExchangeQuoteDto } from '@gameing/contracts/wallet';
import type { WalletApplication } from '../platform/wallet/wallet-application';

const props = defineProps<{ wallet: WalletApplication; canExchange: boolean; turnoverRemaining: string; availableCoins: string }>();
const emit = defineEmits<{ completed: [] }>();
const coins = ref('');
const quote = ref<WalletExchangeQuoteDto>();
const idempotencyKey = ref('');
const loading = ref(false);
const working = ref(false);
const error = ref('');
const feedback = ref('');
const amount = computed(() => /^[1-9][0-9]{0,18}$/.test(coins.value) ? BigInt(coins.value) : 0n);
const sufficient = computed(() => amount.value > 0n && amount.value <= BigInt(props.availableCoins || '0'));

function clearQuote(): void { quote.value = undefined; idempotencyKey.value = ''; feedback.value = ''; }
async function preview(): Promise<void> {
  if (!amount.value || !sufficient.value) { error.value = '请输入不超过可用余额的正整数金币。'; return; }
  loading.value = true; error.value = ''; feedback.value = '';
  try { quote.value = await props.wallet.quoteExchange({ coins: amount.value.toString() }); idempotencyKey.value = crypto.randomUUID(); }
  catch (cause) { error.value = exchangeError(cause); }
  finally { loading.value = false; }
}
async function confirm(): Promise<void> {
  if (!quote.value || !sufficient.value || !props.canExchange) return;
  working.value = true; error.value = ''; feedback.value = '';
  try {
    const result = await props.wallet.exchangeCoins({ quote: quote.value, idempotencyKey: idempotencyKey.value || (idempotencyKey.value = crypto.randomUUID()) });
    feedback.value = `已兑换 ${result.coins} 金币，余额增加 ¥${formatFen(result.cnyFen)}。`;
    coins.value = ''; quote.value = undefined; idempotencyKey.value = ''; emit('completed');
  } catch (cause) {
    error.value = exchangeError(cause);
    if (['EXCHANGE_QUOTE_EXPIRED', 'EXCHANGE_QUOTE_CHANGED'].includes((cause as { code?: string })?.code ?? '')) clearQuote();
  } finally { working.value = false; }
}
function exchangeError(cause: unknown): string {
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
  switch (code) {
    case 'TURNOVER_INCOMPLETE': return `有效下注流水还差 ${props.turnoverRemaining} 金币，完成后即可兑换。`;
    case 'INSUFFICIENT_EXCHANGE_BALANCE': return '可用金币不足以完成兑换。';
    case 'EXCHANGE_NOT_AVAILABLE': return '当前直属代理模式或系统可用余额暂不支持平台兑换。';
    case 'EXCHANGE_QUOTE_EXPIRED': return '兑换预览已过期，请重新预览。';
    case 'EXCHANGE_QUOTE_CHANGED': return '兑换比例已变化，请重新预览。';
    case 'INVALID_EXCHANGE_AMOUNT': return '请输入有效的金币兑换数量。';
    case 'IDEMPOTENCY_KEY_REUSED': return '兑换请求冲突，请重新预览后提交。';
    default: return '兑换暂时未完成，请稍后重试。';
  }
}
function formatFen(value: string): string { const fen = BigInt(value); return `${fen / 100n}.${(fen % 100n).toString().padStart(2, '0')}`; }
</script>

<template>
  <section class="player-exchange-workspace" aria-label="金币兑换余额">
    <h3>金币兑换余额</h3>
    <p>按当前配置比例兑换至人民币余额；不足 1 分的部分向下取整。兑换前会显示确认金额。</p>
    <form class="player-exchange-form" @submit.prevent="preview">
      <label><span>兑换金币</span><input v-model="coins" inputmode="numeric" autocomplete="off" maxlength="19" placeholder="输入正整数金币" :disabled="loading || working" @input="clearQuote" /></label>
      <small>可用 {{ availableCoins }} 金币 · 默认 10 金币兑 ¥1.00</small>
      <button type="submit" :disabled="loading || working || !canExchange || !sufficient">{{ loading ? '计算中…' : '预览兑换' }}</button>
    </form>
    <div v-if="!canExchange" class="player-transfer-gate" role="status">{{ turnoverRemaining === '0' ? '当前暂不可兑换，请检查账户模式及系统可用余额。' : `有效下注流水还差 ${turnoverRemaining} 金币，完成后即可兑换。` }}</div>
    <div v-if="quote" class="player-transfer-quote" aria-label="兑换金额预览">
      <div><span>扣除金币</span><strong>{{ quote.coins }} 金币</strong></div>
      <div><span>兑换比例</span><strong>{{ quote.rateCoinUnits }} 金币 / ¥{{ formatFen(quote.rateCashFen) }}</strong></div>
      <div class="total"><span>余额增加</span><strong>¥{{ formatFen(quote.cnyFen) }}</strong></div>
      <small>预览有效 60 秒；比例变更时需要重新确认。</small>
      <button type="button" :disabled="working || !sufficient || !canExchange" @click="confirm">{{ working ? '提交中…' : '确认兑换' }}</button>
      <small v-if="!sufficient" class="player-transfer-error">可用金币不足。</small>
    </div>
    <p v-if="error" class="player-transfer-error" role="alert">{{ error }}</p>
    <p v-if="feedback" class="player-transfer-feedback" role="status">{{ feedback }}</p>
  </section>
</template>
