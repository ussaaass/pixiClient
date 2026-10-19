<script setup lang="ts">
import { computed, ref } from 'vue';
import type { FriendLookupResponseDto } from '@gameing/contracts/social';
import type { WalletTransferQuoteDto } from '@gameing/contracts/wallet';
import type { SocialFriendsApplication } from '../platform/social/friends-application';
import type { WalletApplication } from '../platform/wallet/wallet-application';

const props = defineProps<{ wallet: WalletApplication; friends: SocialFriendsApplication; canTransfer: boolean; turnoverRemaining: string; availableCoins: string }>();
const emit = defineEmits<{ completed: [] }>();
const query = ref('');
const candidates = ref<FriendLookupResponseDto>([]);
const recipient = ref<FriendLookupResponseDto[number]>();
const coins = ref('');
const quote = ref<WalletTransferQuoteDto>();
const idempotencyKey = ref('');
const loading = ref(false);
const working = ref(false);
const error = ref('');
const feedback = ref('');
const showDemoRecipient = import.meta.env.DEV;
const parsedAmount = computed(() => /^[1-9][0-9]{0,18}$/.test(coins.value) ? BigInt(coins.value) : 0n);
const available = computed(() => BigInt(props.availableCoins || '0'));
const enoughAvailable = computed(() => parsedAmount.value > 0n && quote.value ? BigInt(quote.value.totalCoins) <= available.value : false);

function invalidateQuote(): void { quote.value = undefined; feedback.value = ''; }
async function findRecipient(): Promise<void> {
  const value = query.value.trim();
  if (value.length < 3) { error.value = '请输入至少 3 位好友码或完整用户名。'; return; }
  loading.value = true; error.value = ''; feedback.value = ''; candidates.value = []; recipient.value = undefined; invalidateQuote();
  try {
    candidates.value = await props.friends.lookup(value);
    if (candidates.value.length === 0) error.value = '没有找到匹配账号，请核对好友码或用户名。';
  } catch { error.value = '暂时无法查找账号，请重试。'; }
  finally { loading.value = false; }
}
function findDemoRecipient(): void {
  query.value = 'demo-transfer';
  void findRecipient();
}
function selectRecipient(candidate: FriendLookupResponseDto[number]): void {
  recipient.value = candidate; candidates.value = []; invalidateQuote(); error.value = '';
}
async function createQuote(): Promise<void> {
  if (!recipient.value || !parsedAmount.value) { error.value = '先选择收款账号并输入正整数金币。'; return; }
  loading.value = true; error.value = ''; feedback.value = '';
  try { quote.value = await props.wallet.quoteTransfer({ recipientUserId: recipient.value.userId, coins: parsedAmount.value.toString() }); idempotencyKey.value = crypto.randomUUID(); }
  catch (cause) { error.value = transferError(cause); }
  finally { loading.value = false; }
}
async function confirmTransfer(): Promise<void> {
  if (!quote.value || !enoughAvailable.value) return;
  working.value = true; error.value = ''; feedback.value = '';
  try {
    const result = await props.wallet.transferCoins({ quote: quote.value, idempotencyKey: idempotencyKey.value || (idempotencyKey.value = crypto.randomUUID()) });
    feedback.value = `已向 ${result.recipientDisplayName} 转账 ${result.coins} 金币，手续费 ${result.feeCoins} 金币。`;
    recipient.value = undefined; candidates.value = []; query.value = ''; coins.value = ''; quote.value = undefined; idempotencyKey.value = '';
    emit('completed');
  } catch (cause) {
    error.value = transferError(cause);
    if (['TRANSFER_QUOTE_EXPIRED', 'TRANSFER_QUOTE_CHANGED'].includes((cause as { code?: string })?.code ?? '')) { quote.value = undefined; idempotencyKey.value = ''; }
  } finally { working.value = false; }
}
function transferError(cause: unknown): string {
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
  switch (code) {
    case 'SELF_TRANSFER': return '不能向自己的账号转账。';
    case 'RECIPIENT_NOT_FOUND': return '收款账号不存在或不可用。';
    case 'INVALID_TRANSFER_AMOUNT': return '请输入有效的金币数量。';
    case 'TURNOVER_INCOMPLETE': return '有效下注流水未完成，暂时不能转出。';
    case 'INSUFFICIENT_AVAILABLE_BALANCE': return '可用金币不足以支付本金和手续费。';
    case 'TRANSFER_QUOTE_EXPIRED': return '转账预览已过期，请重新预览。';
    case 'TRANSFER_QUOTE_CHANGED': return '费率或收款信息已变化，请重新预览。';
    case 'IDEMPOTENCY_KEY_REUSED': return '转账请求冲突，请重新预览后提交。';
    default: return '转账暂时未完成，请稍后重试。';
  }
}
function formatExpiry(value: string): string { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)); }
</script>

<template>
  <section class="player-transfer-workspace" aria-label="金币转账">
    <h3>金币转账</h3>
    <p class="player-transfer-intro">通过好友码或用户名查找收款人；发送方额外支付 5% 手续费。</p>
    <aside v-if="showDemoRecipient" class="player-transfer-demo-recipient" aria-label="本机转账测试用户">
      <div><strong>本机样例用户：转账练习号</strong><small>用户名 demo-transfer · 好友码 ZQ8M4K2D9P</small><small>仅用于本浏览器演练，收到的金币不代表真实资产。</small></div>
      <button type="button" :disabled="loading || working" @click="findDemoRecipient">查找样例用户</button>
    </aside>
    <form class="player-transfer-search" @submit.prevent="findRecipient">
      <label><span>好友码 / 用户名</span><input v-model="query" autocomplete="off" maxlength="64" placeholder="输入好友码或用户名" :disabled="loading || working" /></label>
      <button type="submit" :disabled="loading || working">{{ loading ? '查找中…' : '查找' }}</button>
    </form>
    <ul v-if="candidates.length" class="player-transfer-candidates" aria-label="匹配账号">
      <li v-for="candidate in candidates" :key="candidate.userId"><span><strong>{{ candidate.displayName }}</strong><small>好友码 {{ candidate.friendCode }}</small></span><button type="button" :disabled="working" @click="selectRecipient(candidate)">选为收款人</button></li>
    </ul>
    <div v-if="recipient" class="player-transfer-recipient"><span>收款人</span><strong>{{ recipient.displayName }}</strong><small>好友码 {{ recipient.friendCode }}</small><button type="button" aria-label="更换收款人" @click="recipient = undefined; invalidateQuote()">更换</button></div>
    <form v-if="recipient" class="player-transfer-amount" @submit.prevent="createQuote">
      <label><span>到账金币</span><input v-model="coins" inputmode="numeric" autocomplete="off" maxlength="19" placeholder="输入正整数" @input="invalidateQuote" /></label>
      <small>当前可用 {{ availableCoins }} 金币</small>
      <button type="submit" :disabled="loading || working || !canTransfer || !parsedAmount">{{ loading ? '计算中…' : '预览转账' }}</button>
    </form>
    <div v-if="!canTransfer" class="player-transfer-gate" role="status">有效下注流水还差 {{ turnoverRemaining }} 金币，完成后即可转出。</div>
    <div v-if="quote" class="player-transfer-quote" aria-label="转账金额预览">
      <div><span>收款人到账</span><strong>{{ quote.coins }} 金币</strong></div>
      <div><span>手续费（{{ (quote.feeRateBps / 100).toFixed(2) }}%）</span><strong>{{ quote.feeCoins }} 金币</strong></div>
      <div class="total"><span>发送方共扣</span><strong>{{ quote.totalCoins }} 金币</strong></div>
      <small>预览有效至 {{ formatExpiry(quote.expiresAt) }}；费率变化时需重新确认。</small>
      <button type="button" :disabled="working || !enoughAvailable" @click="confirmTransfer">{{ working ? '提交中…' : '确认转账' }}</button>
      <small v-if="!enoughAvailable" class="player-transfer-error">可用金币不足以支付本金和手续费。</small>
    </div>
    <p v-if="error" class="player-transfer-error" role="alert">{{ error }}</p>
    <p v-if="feedback" class="player-transfer-feedback" role="status">{{ feedback }}</p>
  </section>
</template>
