<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import {
  AdminUserDetailSection,
  AdminUserRewardType,
  AdminUserRoleType,
  AdminUserSource,
  AdminUserStatus,
  type AdminUserDetailSectionResponseDto,
  type AdminUserOverviewDto,
} from '@gameing/admin-contracts/admin-users';
import { localDemoAdminUserApplication } from '../platform/admin-users/composition';

const route = useRoute();
type DetailSection = (typeof AdminUserDetailSection)[keyof typeof AdminUserDetailSection];
const activeSection = ref<DetailSection>(AdminUserDetailSection.OVERVIEW);
const detail = ref<AdminUserDetailSectionResponseDto | null>(null);
const overview = ref<AdminUserOverviewDto | null>(null);
const loading = ref(false);
const error = ref('');
const notFound = ref(false);
let detailRequestSequence = 0;

const userId = computed(() => {
  const value = route.params.id;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) return undefined;
  const maximum = '18446744073709551615';
  if (value.length === maximum.length && value > maximum) return undefined;
  return value;
});

const sections: ReadonlyArray<{ id: DetailSection; title: string; permission: string; description: string }> = [
  { id: AdminUserDetailSection.OVERVIEW, title: '账号概览', permission: '用户摘要权限', description: '展示账号公开摘要与已掩码联系方式。' },
  { id: AdminUserDetailSection.SECURITY, title: '账号安全', permission: '账号安全读取权限', description: '仅显示 TOTP 开启状态、安全事件和设备数量；不返回密钥、指纹或恢复码。' },
  { id: AdminUserDetailSection.REFERRAL, title: '邀请关系', permission: '邀请关系读取权限', description: '展示直属上级至最多四级祖先；返点模式属于各自用户的上级属性。' },
  { id: AdminUserDetailSection.ASSETS, title: '资产记录', permission: '资产读取权限', description: '读取余额、冻结金额与不可变操作流水；本页没有调账入口。' },
  { id: AdminUserDetailSection.GAMES, title: '游戏记录', permission: '牌局历史读取权限', description: '显示已结算局摘要，不解释游戏专属 JSON。' },
  { id: AdminUserDetailSection.SOCIAL, title: '社交访问记录', permission: '社交审计读取权限', description: '仅显示审计元数据，不展示私聊正文。' },
];

const currentSection = computed(() => sections.find((section) => section.id === activeSection.value)!);
const currentData = computed(() => detail.value?.section === activeSection.value ? detail.value : null);
const currentSource = computed(() => {
  const response = detail.value;
  if (!response || response.section !== activeSection.value) return null;
  return response.section === AdminUserDetailSection.OVERVIEW ? response.data.user.source : response.data.source;
});
const statusLabel = (status: number) => status === AdminUserStatus.ACTIVE ? '正常' : status === AdminUserStatus.DISABLED ? '已停用' : '已关闭';
const rewardLabel = (type: number) => type === AdminUserRewardType.CUSTOMER_LOSS ? '客损返点' : '充值返点';

function formatCny(fen: string): string {
  const negative = fen.startsWith('-');
  const digits = negative ? fen.slice(1) : fen;
  const normalized = digits.padStart(3, '0');
  const amount = `${normalized.slice(0, -2)}.${normalized.slice(-2)}`;
  return `${negative ? '-' : ''}¥${amount}`;
}

async function loadSection(section = activeSection.value): Promise<void> {
  const sequence = ++detailRequestSequence;
  if (!userId.value) return;
  activeSection.value = section;
  loading.value = true;
  error.value = '';
  notFound.value = false;
  const result = await localDemoAdminUserApplication.detail(userId.value, section);
  if (sequence !== detailRequestSequence) return;
  loading.value = false;
  if (!result.ok) {
    detail.value = null;
    error.value = result.code === 'USER_NOT_FOUND' ? '' : result.code === 'INVALID_QUERY' ? '用户 ID 或详情分区无效。' : '本机用户详情暂时无法读取。';
    notFound.value = result.code === 'USER_NOT_FOUND';
    return;
  }
  detail.value = result.value;
  if (result.value.section === AdminUserDetailSection.OVERVIEW) overview.value = result.value.data;
}

watch(userId, (id) => {
  detailRequestSequence += 1;
  overview.value = null;
  detail.value = null;
  activeSection.value = AdminUserDetailSection.OVERVIEW;
  if (id) void loadSection(AdminUserDetailSection.OVERVIEW);
});
onMounted(() => { if (userId.value) void loadSection(AdminUserDetailSection.OVERVIEW); });
onBeforeUnmount(() => { detailRequestSequence += 1; });
</script>

<template>
  <section class="domain-page user-detail-page">
    <RouterLink to="/admin/users" class="back-link">← 返回用户列表</RouterLink>
    <div class="user-detail-heading"><div><p class="eyebrow">用户与代理 / 用户详情</p><h1>用户详情</h1><p>分区读取用户、关系、资产与业务审计摘要；不会跨权限合并敏感数据。</p></div><span class="unverified-user-id">{{ userId ? `用户 ${userId}` : '用户 ID 格式无效' }}</span></div>

    <p v-if="!userId" class="user-detail-invalid-id" role="alert">用户 ID 必须是非零、且不超过 BIGINT UNSIGNED 最大值的十进制字符串。<RouterLink to="/admin/users">返回用户查询</RouterLink></p>
    <section v-else-if="loading && !overview" class="user-detail-status" role="status"><span class="service-dot"></span><div><strong>正在读取用户摘要…</strong><p>详情数据按分区加载。</p></div></section>
    <section v-else-if="notFound" class="user-detail-empty"><span class="user-empty-icon">⌕</span><strong>演练目录中没有此用户</strong><p>当前离线版本只提供标记为 LOCAL_DEMO 的账号。生产环境由 Admin API 按用户读取权限返回记录。</p><RouterLink to="/admin/users" class="user-row-detail">返回用户查询</RouterLink></section>
    <section v-else-if="error && !overview" class="user-detail-empty" role="alert"><strong>用户摘要读取失败</strong><p>{{ error }}</p><button type="button" @click="loadSection(AdminUserDetailSection.OVERVIEW)">重试</button></section>

    <template v-else-if="overview">
      <section class="user-detail-status"><span class="service-dot"></span><div><strong>{{ overview.user.nickname }} · {{ statusLabel(overview.user.status) }} · 本机演练账号</strong><p>账号分区按需读取；联系方式仅显示掩码，不提供封禁、换绑或调账等写操作。</p></div><span class="local-demo-tag">{{ overview.user.source === AdminUserSource.LOCAL_DEMO ? 'LOCAL_DEMO' : 'SERVER' }}</span></section>
      <nav class="user-detail-sections" aria-label="用户详情分区">
        <button v-for="section in sections" :key="section.id" type="button" :aria-pressed="activeSection === section.id" :class="{ active: activeSection === section.id }" @click="loadSection(section.id)">{{ section.title }}</button>
      </nav>
      <section class="user-detail-section" :aria-labelledby="`section-title-${currentSection.id}`">
        <div class="user-detail-section-heading"><div><p class="eyebrow">{{ currentSection.permission }}</p><h2 :id="`section-title-${currentSection.id}`">{{ currentSection.title }}</h2></div><button type="button" class="user-section-refresh" :disabled="loading" @click="loadSection()">{{ loading ? '读取中…' : '刷新分区' }}</button></div>
        <p v-if="error" class="user-query-error" role="alert">{{ error }} <button type="button" @click="loadSection()">重试</button></p>
        <div v-else-if="loading" class="user-detail-empty" role="status"><strong>正在读取{{ currentSection.title }}…</strong><p>{{ currentSection.description }}</p></div>
        <template v-else-if="currentData">
          <template v-if="currentData.section === AdminUserDetailSection.OVERVIEW">
            <div class="user-detail-data-grid"><article><small>公开昵称</small><strong>{{ currentData.data.user.nickname }}</strong></article><article><small>用户名</small><strong>{{ currentData.data.user.username ?? '未设置' }}</strong></article><article><small>角色 / 状态</small><strong>{{ currentData.data.user.roleType === AdminUserRoleType.PLAYER_AGENT ? '玩家 / 代理' : '普通玩家' }} · {{ statusLabel(currentData.data.user.status) }}</strong></article><article><small>直属上级</small><strong>{{ currentData.data.user.parent1UserId ?? '无' }}</strong></article><article><small>该用户作为上级时的返点模式</small><strong>{{ rewardLabel(currentData.data.rewardType) }}</strong></article><article><small>公开好友码</small><strong>{{ currentData.data.publicCode }}</strong></article><article><small>邮箱</small><strong>{{ currentData.data.emailMasked ?? '未绑定' }} · {{ currentData.data.emailVerified ? '已验证' : '未验证' }}</strong></article><article><small>手机</small><strong>{{ currentData.data.phoneMasked ?? '未绑定' }} · {{ currentData.data.phoneVerified ? '已验证' : '未验证' }}</strong></article><article><small>创建时间</small><strong>{{ new Date(currentData.data.user.createdAt).toLocaleString() }}</strong></article><article><small>最近登录</small><strong>{{ currentData.data.lastLoginAt ? new Date(currentData.data.lastLoginAt).toLocaleString() : '暂无记录' }}</strong></article></div>
          </template>
          <template v-else-if="currentData.section === AdminUserDetailSection.SECURITY">
            <div class="user-detail-metric-grid"><article><small>TOTP</small><strong>{{ currentData.data.totpEnabled ? '已启用' : '未启用' }}</strong></article><article><small>登记设备数量</small><strong>{{ currentData.data.deviceCount }}</strong></article><article><small>安全事件</small><strong>{{ currentData.data.securityEvents.length }} 条</strong></article></div>
            <div v-if="currentData.data.securityEvents.length" class="user-detail-record-list"><article v-for="(event,index) in currentData.data.securityEvents" :key="`${event.createdAt}-${index}`"><strong>{{ event.action }}</strong><span>{{ event.result }}</span><time>{{ new Date(event.createdAt).toLocaleString() }}</time></article></div>
            <div v-else class="user-detail-empty"><strong>没有本机演练安全事件</strong><p>{{ currentSection.description }}</p></div>
          </template>
          <template v-else-if="currentData.section === AdminUserDetailSection.REFERRAL">
            <p class="user-section-note">当前用户自身的返点模式：<strong>{{ rewardLabel(currentData.data.rewardType) }}</strong>。祖先链最多展示直属至第四级。</p>
            <div v-if="currentData.data.ancestors.length" class="user-detail-record-list"><article v-for="ancestor in currentData.data.ancestors" :key="ancestor.level"><strong>第 {{ ancestor.level }} 级 · {{ ancestor.nickname }}</strong><span>user_id {{ ancestor.userId }}</span><small>作为上级时：{{ rewardLabel(ancestor.rewardType) }}</small></article></div>
            <div v-else class="user-detail-empty"><strong>该演练账号没有上级</strong><p>换绑与邀请归因由独立流程管理，本详情页只读关系快照。</p></div>
          </template>
          <template v-else-if="currentData.section === AdminUserDetailSection.ASSETS">
            <div v-if="currentData.data.accounts.length" class="user-detail-table-wrap"><table><thead><tr><th>资产</th><th>币种</th><th>可用 / 余额</th><th>冻结</th></tr></thead><tbody><tr v-for="account in currentData.data.accounts" :key="`${account.assetType}-${account.currency}`"><td>{{ account.assetType === 'COIN' ? '金币' : '余额' }}</td><td>{{ account.currency }}</td><td>{{ account.assetType === 'CNY_BALANCE' ? formatCny(account.available) : `${account.available} 枚` }}</td><td>{{ account.assetType === 'CNY_BALANCE' ? formatCny(account.frozen) : `${account.frozen} 枚` }}</td></tr></tbody></table></div>
            <div v-if="currentData.data.operations.length" class="user-detail-record-list"><article v-for="operation in currentData.data.operations" :key="operation.operationId"><strong>{{ operation.operationType }} · {{ operation.assetType === 'COIN' ? '金币' : '余额' }} {{ operation.amount }}</strong><span>操作 {{ operation.operationId }}</span><time>{{ new Date(operation.createdAt).toLocaleString() }}</time></article></div>
            <div v-if="!currentData.data.accounts.length && !currentData.data.operations.length" class="user-detail-empty"><strong>该演练账号没有资产样例</strong><p>未从其他业务域拼接或推测账务数据；生产账本由 Asset API 权限校验后返回。</p></div>
          </template>
          <template v-else-if="currentData.section === AdminUserDetailSection.GAMES">
            <div v-if="currentData.data.rounds.length" class="user-detail-table-wrap"><table><thead><tr><th>牌局 ID</th><th>游戏 handler</th><th>状态</th><th>有效下注</th><th>净输赢</th><th>时间</th></tr></thead><tbody><tr v-for="round in currentData.data.rounds" :key="round.roundId"><td>{{ round.roundId }}</td><td>{{ round.gameKey }}</td><td>{{ round.status }}</td><td>{{ round.wagerCoins }}</td><td>{{ round.netCoins }}</td><td>{{ new Date(round.createdAt).toLocaleString() }}</td></tr></tbody></table></div>
            <div v-else class="user-detail-empty"><strong>没有本机演练牌局记录</strong><p>{{ currentSection.description }}</p></div>
          </template>
          <template v-else-if="currentData.section === AdminUserDetailSection.SOCIAL">
            <div v-if="currentData.data.events.length" class="user-detail-record-list"><article v-for="event in currentData.data.events" :key="event.auditId"><strong>{{ event.actionCode }}</strong><span>{{ event.resourceType }} · {{ event.auditId }}</span><time>{{ new Date(event.createdAt).toLocaleString() }}</time></article></div>
            <div v-else class="user-detail-empty"><strong>没有本机演练社交访问记录</strong><p>不会在用户详情中展示私聊正文或帖子内容。</p></div>
          </template>
          <footer v-if="currentSource !== null" class="user-detail-source-note">{{ currentSource === AdminUserSource.LOCAL_DEMO ? 'LOCAL_DEMO：此分区仅为合成演练数据，不代表生产记录。' : 'SERVER：此分区数据由服务端返回。' }}</footer>
        </template>
      </section>
    </template>
  </section>
</template>
