<script setup lang="ts">
import { ElSelect } from 'element-plus';
import AdminSelectOption from '../components/AdminSelectOption.vue';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import {
  AdminRoomStatus, AdminRoundStatus, AdminOperationsSource, AdminRoundSubmissionType,
  type AdminRoomDetailDto, type AdminRoomSummaryDto, type AdminRoundDetailDto, type AdminRoundSummaryDto,
} from '@gameing/admin-contracts/admin-game-operations';
import { AdminReferralBindingSource, AdminReferralMigrationStatus, AdminReferralRewardType, type AdminReferralDetailDto, type AdminReferralListItemDto, type AdminReferralPreviewDto } from '@gameing/admin-contracts/admin-referrals';
import { localDemoAdminGameOperationsApplication } from '../platform/game-operations/composition';
import { localDemoAdminReferralApplication } from '../platform/referrals/composition';

type OperationsPage = 'rooms' | 'rounds' | 'referrals';
type OperationsDetail = AdminRoomDetailDto | AdminRoundDetailDto;
const route = useRoute();
const selectedGuide = ref(false);
const guideTrigger = ref<HTMLButtonElement | null>(null);
const guideClose = ref<HTMLButtonElement | null>(null);
const page = computed<OperationsPage>(() => route.path === '/admin/rooms' ? 'rooms' : route.path === '/admin/rounds' ? 'rounds' : 'referrals');
const copy = computed(() => ({
  rooms: { eyebrow: '游戏运营 / 实时运行', title: '房间观察', intro: '按游戏、难度和房间状态观察运行中的房间。列表为明确标记的本机合成快照。', filters: ['房间号 / Room ID', '游戏', '难度厅', '房间状态'], empty: '暂无房间记录', details: '房间详情展示规则版本、成员座位、当前阶段、心跳和游戏进程标识。热状态由 Redis 提供，SQL 中的 room 与 room_membership 用于生命周期及恢复。', table: ['房间', '游戏 / 难度', '状态 / 阶段', '人数', '等待时长', '规则版本', '最近变化'] },
  rounds: { eyebrow: '游戏运营 / 历史结果', title: '战绩 / 回放', intro: '查询牌局及其结算证据。本页面不推导游戏专属结果，handler 专有内容只显示受控摘要。', filters: ['Round Key / Room ID', '玩家 ID', '游戏', '起始日期', '结束日期'], empty: '暂无牌局记录', details: '详情并列展示 round 生命周期摘要、handler_version、封存输入摘要和关联 asset_operation。未知 handler 版本只显示服务端提供的脱敏摘要，不猜测字段含义。', table: ['Round Key', '房间 / 局号', '游戏 / Handler', '参与人数', '结算时间', '结算状态', '结果摘要'] },
  referrals: { eyebrow: '用户与代理 / 邀请归因', title: '邀请关系', intro: '查看当前最多四级上级链和返点分配记录。换绑只由 Admin 发起，并须通过 TOTP、影响预览及审计。', filters: ['用户 ID / 邀请码', '直属上级 ID', '绑定来源', '绑定时间'], empty: '暂无邀请关系记录', details: '关系结果按 parent_1_user_id 至 parent_4_user_id 展示；各级已发返点以历史 ancestry_snapshot 为准。换绑需预览受影响下线、社交迁移目标域及任务结果。', table: ['用户', '直属上级', '二级上级', '三级上级', '四级上级', '绑定来源', '当前关系收益'] },
} as const)[page.value]);

const roomKeyword = ref(''); const roomGame = ref(''); const roomTier = ref(''); const roomStatus = ref<number | ''>('');
const roundKeyword = ref(''); const roundPlayerId = ref(''); const roundGame = ref(''); const fromDate = ref(''); const toDate = ref('');
const referralKeyword = ref(''); const referralParent = ref(''); const referralSource = ref<number | ''>(''); const referralRewardType = ref<number | ''>('');
const referrals = ref<AdminReferralListItemDto[]>([]); const referralDetail = ref<AdminReferralDetailDto | null>(null); const referralPreview = ref<AdminReferralPreviewDto | null>(null);
const referralSelectedId = ref(''); const referralNewParent = ref(''); const referralReason = ref(''); const referralTotp = ref(''); const referralFeedback = ref(''); const referralBusy = ref(false);
const rooms = ref<AdminRoomSummaryDto[]>([]); const rounds = ref<AdminRoundSummaryDto[]>([]);
const total = ref(0); const nextCursor = ref<string | null>(null); const loading = ref(false); const error = ref(''); const searched = ref(false);
const detail = ref<OperationsDetail | null>(null); const detailLoading = ref(false); const detailError = ref('');
let listRequestSequence = 0; let detailRequestSequence = 0;
const guideTitle = computed(() => copy.value.title + ' · 数据与权限');
const headers = computed(() => copy.value.table);
const statusOptions = [{ value: AdminRoomStatus.WAITING, label: '等待中' }, { value: AdminRoomStatus.PLAYING, label: '进行中' }, { value: AdminRoomStatus.SETTLING, label: '结算中' }, { value: AdminRoomStatus.CLOSED, label: '已关闭' }];
const roomStatusLabel = (value: number) => statusOptions.find((item) => item.value === value)?.label ?? '未知状态';
const roundStatusLabel = (value: number) => value === AdminRoundStatus.SETTLED ? '已结算' : '已取消';
function formatDate(value: string | null): string { return value ? new Date(value).toLocaleString() : '—'; }

async function runQuery(cursor?: string): Promise<void> {
  if (page.value === 'referrals') {
    loading.value = true; error.value = ''; searched.value = true;
    try {
      const result = await localDemoAdminReferralApplication.list({ ...(referralKeyword.value.trim() ? { keyword: referralKeyword.value.trim() } : {}), ...(referralParent.value ? { parent1UserId: referralParent.value } : {}), ...(referralSource.value ? { bindingSource: referralSource.value as AdminReferralListItemDto['bindingSource'] } : {}), ...(referralRewardType.value ? { rewardType: referralRewardType.value as AdminReferralListItemDto['rewardType'] } : {}), ...(cursor ? { cursor } : {}), pageSize: 10 });
      referrals.value = cursor ? [...referrals.value, ...result.items] : result.items; total.value = result.total; nextCursor.value = result.nextCursor;
    } catch { referrals.value = []; error.value = '邀请关系演练数据读取失败，请重试。'; }
    finally { loading.value = false; }
    return;
  }
  const requestSequence = ++listRequestSequence;
  loading.value = true; error.value = ''; searched.value = true; detail.value = null; detailError.value = '';
  if (page.value === 'rooms') {
    const result = await localDemoAdminGameOperationsApplication.rooms({
      ...(roomKeyword.value.trim() ? { keyword: roomKeyword.value.trim() } : {}),
      ...(roomGame.value ? { gameKey: roomGame.value } : {}), ...(roomTier.value ? { tierKey: roomTier.value } : {}),
      ...(roomStatus.value ? { status: Number(roomStatus.value) } : {}), ...(cursor ? { cursor } : {}), pageSize: 2,
    });
    if (requestSequence !== listRequestSequence) return;
    loading.value = false;
    if (!result.ok) { rooms.value = []; total.value = 0; nextCursor.value = null; error.value = result.code === 'INVALID_QUERY' ? '查询条件无效，请检查房间筛选。' : '房间快照读取失败，请重试。'; return; }
    rooms.value = cursor ? [...rooms.value, ...result.value.items] : result.value.items; total.value = result.value.total; nextCursor.value = result.value.nextCursor;
    return;
  }
  const playerId = roundPlayerId.value.trim();
  const dateRange = (value: string, end = false) => value ? `${value}T${end ? '23:59:59' : '00:00:00'}.000Z` : undefined;
  const result = await localDemoAdminGameOperationsApplication.rounds({
    ...(roundKeyword.value.trim() ? { keyword: roundKeyword.value.trim() } : {}), ...(playerId ? { playerUserId: playerId } : {}),
    ...(roundGame.value ? { gameKey: roundGame.value } : {}), ...(dateRange(fromDate.value) ? { fromCreatedAt: dateRange(fromDate.value)! } : {}),
    ...(dateRange(toDate.value, true) ? { toCreatedAt: dateRange(toDate.value, true)! } : {}), ...(cursor ? { cursor } : {}), pageSize: 2,
  });
  if (requestSequence !== listRequestSequence) return;
  loading.value = false;
  if (!result.ok) { rounds.value = []; total.value = 0; nextCursor.value = null; error.value = result.code === 'INVALID_QUERY' ? '查询条件无效，请检查玩家 ID 和日期范围。' : '牌局记录读取失败，请重试。'; return; }
  rounds.value = cursor ? [...rounds.value, ...result.value.items] : result.value.items; total.value = result.value.total; nextCursor.value = result.value.nextCursor;
}

function resetQuery(): void {
  roomKeyword.value = ''; roomGame.value = ''; roomTier.value = ''; roomStatus.value = '';
  roundKeyword.value = ''; roundPlayerId.value = ''; roundGame.value = ''; fromDate.value = ''; toDate.value = '';
  void runQuery();
}
async function openDetail(id: string): Promise<void> {
  if (page.value === 'referrals') {
    referralSelectedId.value = id; referralDetail.value = null; referralPreview.value = null; referralFeedback.value = '';
    try { referralDetail.value = await localDemoAdminReferralApplication.detail(id); referralNewParent.value = ''; referralReason.value = ''; referralTotp.value = ''; }
    catch { error.value = '邀请关系详情读取失败。'; }
    return;
  }
  const requestSequence = ++detailRequestSequence;
  detail.value = null; detailError.value = ''; detailLoading.value = true;
  const result = page.value === 'rooms'
    ? await localDemoAdminGameOperationsApplication.room(id)
    : await localDemoAdminGameOperationsApplication.round(id);
  if (requestSequence !== detailRequestSequence) return;
  detailLoading.value = false;
  if (!result.ok) { detailError.value = result.code === 'NOT_FOUND' ? '本机演练目录中没有这条记录。' : '详情读取失败，请重试。'; return; }
  detail.value = result.value;
}
function closeDetail(): void { detailRequestSequence += 1; detailLoading.value = false; detail.value = null; detailError.value = ''; referralDetail.value = null; referralPreview.value = null; referralSelectedId.value = ''; }
async function previewReferralRebind(): Promise<void> {
  if (!referralSelectedId.value || !referralNewParent.value) return;
  referralFeedback.value = '';
  try { referralPreview.value = await localDemoAdminReferralApplication.preview(referralSelectedId.value, referralNewParent.value); }
  catch (cause) { referralPreview.value = null; referralFeedback.value = cause instanceof Error ? referralErrorMessage(cause.message) : '无法生成换绑预览。'; }
}
async function submitReferralRebind(): Promise<void> {
  if (!referralPreview.value) return;
  referralBusy.value = true; referralFeedback.value = '';
  try {
    await localDemoAdminReferralApplication.rebind({ requestKey: `demo-rebind-${Date.now()}`, previewKey: referralPreview.value.previewKey, workspaceRevision: referralPreview.value.workspaceRevision, userId: referralPreview.value.userId, newParent1UserId: referralPreview.value.newParent1UserId, reason: referralReason.value, totpCode: referralTotp.value });
    referralFeedback.value = '本机演练换绑已提交；历史返点快照未改写。待处理社交迁移已建立。'; referralPreview.value = null;
    referralDetail.value = await localDemoAdminReferralApplication.detail(referralSelectedId.value); await runQuery();
  } catch (cause) { referralFeedback.value = cause instanceof Error ? referralErrorMessage(cause.message) : '换绑失败。'; }
  finally { referralBusy.value = false; }
}
async function processReferralMigration(taskId: string): Promise<void> {
  try { await localDemoAdminReferralApplication.processMigration(taskId); referralDetail.value = await localDemoAdminReferralApplication.detail(referralSelectedId.value); referralFeedback.value = '演练迁移任务已完成。该操作只更新本机合成任务，不迁移真实社交数据。'; await runQuery(); }
  catch (cause) { referralFeedback.value = cause instanceof Error ? referralErrorMessage(cause.message) : '迁移任务处理失败。'; }
}
function referralErrorMessage(code: string): string { return ({ TOTP_INVALID: '演练 TOTP 不正确。', PREVIEW_STALE: '关系数据已变化，请重新生成预览。', REFERRAL_CYCLE: '新关系会形成循环，无法提交。', SELF_PARENT: '用户不能绑定自己为直属上级。', MIGRATION_PENDING: '该用户已有待处理的社交迁移。', NO_CHANGE: '新直属上级与当前关系相同。', NOT_FOUND: '未找到用户或直属上级。', INVALID_REQUEST: '请填写有效原因，并输入 6 位演练码。' } as Record<string, string>)[code] ?? '当前操作未完成，请检查输入后重试。'; }
async function openGuide(event: MouseEvent): Promise<void> { guideTrigger.value = event.currentTarget as HTMLButtonElement; selectedGuide.value = true; await nextTick(); guideClose.value?.focus(); }
async function closeGuide(): Promise<void> { selectedGuide.value = false; await nextTick(); guideTrigger.value?.focus(); }
watch(page, () => { closeDetail(); void runQuery(); });
onMounted(() => { void runQuery(); });
</script>

<template>
  <section class="domain-page ops-monitor-page">
    <nav class="ops-monitor-tabs" aria-label="游戏运营与邀请关系">
      <RouterLink to="/admin/rooms" :class="{ active: page === 'rooms' }">房间观察</RouterLink><RouterLink to="/admin/rounds" :class="{ active: page === 'rounds' }">战绩 / 回放</RouterLink><RouterLink to="/admin/referrals" :class="{ active: page === 'referrals' }">邀请关系</RouterLink>
    </nav>
    <header class="ops-monitor-heading"><div><p class="eyebrow">{{ copy.eyebrow }}</p><h1>{{ copy.title }}</h1><p>{{ copy.intro }}</p></div><button ref="guideTrigger" class="ops-monitor-guide-trigger" type="button" aria-label="查看数据边界说明" @click="openGuide">?</button></header>

    <section class="ops-monitor-panel" aria-labelledby="ops-filter-title">
      <div class="agent-domain-section-heading"><div><h2 id="ops-filter-title">查询条件</h2><p>筛选只作用于当前演练快照；清空可恢复全部样例。</p></div><span class="local-demo-pill">LOCAL_DEMO</span></div>
      <form v-if="page === 'rooms'" class="ops-monitor-filters" @submit.prevent="runQuery()">
        <label><span>房间号 / Room ID</span><input v-model="roomKeyword" maxlength="64" placeholder="房号或 ID"></label>
        <label><span>游戏</span><el-select v-model="roomGame"><AdminSelectOption value="">全部游戏</AdminSelectOption><AdminSelectOption value="shisanshui">十三张</AdminSelectOption><AdminSelectOption value="slot5">跳高高</AdminSelectOption></el-select></label>
        <label><span>难度厅</span><el-select v-model="roomTier"><AdminSelectOption value="">全部难度</AdminSelectOption><AdminSelectOption value="bronze">青铜厅</AdminSelectOption><AdminSelectOption value="gold">黄金厅</AdminSelectOption><AdminSelectOption value="classic">经典厅</AdminSelectOption></el-select></label>
        <label><span>房间状态</span><el-select v-model="roomStatus"><AdminSelectOption value="">全部状态</AdminSelectOption><AdminSelectOption v-for="item in statusOptions" :key="item.value" :value="String(item.value)">{{ item.label }}</AdminSelectOption></el-select></label>
        <button type="submit" :disabled="loading">{{ loading ? '查询中…' : '查询' }}</button><button class="secondary" type="button" :disabled="loading" @click="resetQuery">重置</button>
      </form>
      <form v-else-if="page === 'rounds'" class="ops-monitor-filters rounds-filters" @submit.prevent="runQuery()">
        <label><span>Round Key / Room ID</span><input v-model="roundKeyword" maxlength="64" placeholder="局号、房号或 ID"></label><label><span>玩家 ID</span><input v-model="roundPlayerId" maxlength="20" inputmode="numeric" placeholder="完整用户 ID"></label>
        <label><span>游戏</span><el-select v-model="roundGame"><AdminSelectOption value="">全部游戏</AdminSelectOption><AdminSelectOption value="shisanshui">十三张</AdminSelectOption><AdminSelectOption value="slot5">跳高高</AdminSelectOption></el-select></label><label><span>起始日期</span><input v-model="fromDate" type="date"></label><label><span>结束日期</span><input v-model="toDate" type="date"></label>
        <button type="submit" :disabled="loading">{{ loading ? '查询中…' : '查询' }}</button><button class="secondary" type="button" :disabled="loading" @click="resetQuery">重置</button>
      </form>
      <form v-else class="ops-monitor-filters" @submit.prevent="runQuery()"><label><span>用户 ID / 昵称 / 用户名</span><input v-model="referralKeyword" maxlength="64" placeholder="输入用户关键词"></label><label><span>直属上级 user ID</span><input v-model="referralParent" maxlength="20" inputmode="numeric" placeholder="例如 94002"></label><label><span>绑定来源</span><el-select v-model="referralSource"><AdminSelectOption value="">全部来源</AdminSelectOption><AdminSelectOption :value="AdminReferralBindingSource.IP_ATTRIBUTION">IP 归因</AdminSelectOption><AdminSelectOption :value="AdminReferralBindingSource.INVITE_CODE">邀请码</AdminSelectOption><AdminSelectOption :value="AdminReferralBindingSource.ADMIN">Admin 换绑</AdminSelectOption></el-select></label><label><span>返点模式</span><el-select v-model="referralRewardType"><AdminSelectOption value="">全部模式</AdminSelectOption><AdminSelectOption :value="AdminReferralRewardType.RECHARGE">充值返点</AdminSelectOption><AdminSelectOption :value="AdminReferralRewardType.CUSTOMER_LOSS">客损（线下）</AdminSelectOption></el-select></label><button type="submit" :disabled="loading">{{ loading ? '查询中…' : '查询' }}</button><button class="secondary" type="button" :disabled="loading" @click="referralKeyword=''; referralParent=''; referralSource=''; referralRewardType=''; runQuery()">重置</button></form>
    </section>

    <section class="ops-monitor-panel ops-monitor-results" :aria-labelledby="`ops-${page}-results`">
      <div class="agent-domain-section-heading"><div><h2 :id="`ops-${page}-results`">{{ page === 'rooms' ? '房间列表' : page === 'rounds' ? '牌局记录' : '关系与返佣记录' }}</h2><p>{{ page === 'rooms' ? '只读快照；强制结束属于另一个受授权的服务端命令。' : page === 'rounds' ? '已结算结果不可修改；游戏专属 JSON 只由对应 handler 版本解释。' : '换绑会重算当前四级关系并保留返点快照；社交迁移作为待处理任务。' }}</p></div><span class="record-count">{{ loading ? '读取中…' : `${total} 条 ${searched ? '匹配记录' : '本机演练样例'}` }}</span></div>
      <template v-if="page === 'referrals'">
        <p v-if="error" class="user-query-error" role="alert">{{ error }} <button type="button" @click="runQuery()">重试</button></p>
        <div v-else-if="!referrals.length" class="ops-monitor-empty" role="status"><strong>暂无邀请关系记录</strong><p>调整筛选条件，或重置查询。</p></div>
        <div v-else class="ops-monitor-table-wrap"><table><caption>邀请关系查询结果</caption><thead><tr><th>用户</th><th>直属上级</th><th>二级</th><th>三级</th><th>四级</th><th>模式 / 来源</th><th>当前返点</th><th>操作</th></tr></thead><tbody><tr v-for="row in referrals" :key="row.userId"><td><strong>{{ row.nickname }}</strong><small>ID {{ row.userId }}</small></td><td>{{ row.ancestors.parent1UserId ?? '—' }}</td><td>{{ row.ancestors.parent2UserId ?? '—' }}</td><td>{{ row.ancestors.parent3UserId ?? '—' }}</td><td>{{ row.ancestors.parent4UserId ?? '—' }}</td><td>{{ row.rewardType === AdminReferralRewardType.RECHARGE ? '充值返点' : '客损·线下' }} / {{ row.bindingSource === AdminReferralBindingSource.ADMIN ? 'Admin' : row.bindingSource === AdminReferralBindingSource.IP_ATTRIBUTION ? 'IP 归因' : '邀请码' }}</td><td>{{ row.benefitsCents.parent1Cents }} / {{ row.benefitsCents.parent2Cents }} / {{ row.benefitsCents.parent3Cents }} / {{ row.benefitsCents.parent4Cents }} 分</td><td><button class="ops-row-detail" type="button" @click="openDetail(row.userId)">查看 / 换绑</button></td></tr></tbody></table></div>
        <div class="ops-monitor-pagination"><span>{{ referrals.length }} / {{ total }} 条 · 本机演练</span><button v-if="nextCursor" type="button" :disabled="loading" @click="runQuery(nextCursor ?? undefined)">加载更多</button><span v-else>已显示全部记录</span></div>
      </template>
      <template v-else>
      <p v-if="error" class="user-query-error" role="alert">{{ error }} <button type="button" @click="runQuery()">重试</button></p>
      <div v-else-if="loading && !rooms.length && !rounds.length" class="ops-monitor-empty" role="status">正在读取演练快照…</div>
      <div v-else-if="page === 'rooms' && !rooms.length || page === 'rounds' && !rounds.length" class="ops-monitor-empty" role="status"><span class="user-empty-icon" aria-hidden="true">⌕</span><strong>{{ copy.empty }}</strong><p>{{ searched ? '调整查询条件或重置筛选。' : '当前没有可以展示的演练记录。' }}</p><button v-if="searched" type="button" @click="resetQuery">重置筛选</button></div>
      <template v-else>
        <div class="ops-monitor-table-wrap"><table><caption>{{ copy.title }}查询结果</caption><thead><tr><th v-for="header in headers" :key="header" scope="col">{{ header }}</th><th scope="col">详情</th></tr></thead>
          <tbody v-if="page === 'rooms'"><tr v-for="room in rooms" :key="room.roomId"><td><strong>{{ room.roomKey }}</strong><small>ID {{ room.roomId }}</small></td><td>{{ room.gameTitle }} / {{ room.tierTitle }}</td><td><span :class="['user-status-pill', { inactive: room.status === AdminRoomStatus.CLOSED }]">{{ roomStatusLabel(room.status) }} / {{ room.phase }}</span></td><td>{{ room.playerCount }} / {{ room.capacity }}</td><td>{{ room.waitSeconds }} 秒</td><td>{{ room.rulesVersion }}</td><td>{{ formatDate(room.lastChangedAt) }}</td><td><button class="ops-row-detail" type="button" @click="openDetail(room.roomId)">查看</button></td></tr></tbody>
          <tbody v-else-if="page === 'rounds'"><tr v-for="round in rounds" :key="round.roundId"><td><strong>{{ round.roundKey }}</strong><small>ID {{ round.roundId }}</small></td><td>{{ round.roomKey }} / #{{ round.roundNo }}</td><td>{{ round.gameTitle }} / {{ round.handlerVersion }}</td><td>{{ round.participantCount }}</td><td>{{ formatDate(round.settledAt) }}</td><td><span class="user-status-pill">{{ roundStatusLabel(round.status) }}</span></td><td>{{ round.resultSummary }}</td><td><button class="ops-row-detail" type="button" @click="openDetail(round.roundId)">查看</button></td></tr></tbody>
          <tbody v-else><tr><td :colspan="headers.length + 1"><div class="ops-monitor-empty"><strong>{{ copy.empty }}</strong></div></td></tr></tbody>
        </table></div>
        <div class="ops-monitor-pagination"><span>当前显示 {{ page === 'rooms' ? rooms.length : rounds.length }} / {{ total }} 条 · LOCAL_DEMO</span><button v-if="nextCursor" type="button" :disabled="loading" @click="runQuery(nextCursor ?? undefined)">{{ loading ? '加载中…' : '加载更多' }}</button><span v-else>已显示全部记录</span></div>
      </template>
      </template>
    </section>

    <section v-if="page === 'referrals'" class="ops-monitor-panel"><div class="agent-domain-section-heading"><div><h2>社交迁移队列</h2><p>演练任务展示域迁移闭环；真实会话与内容迁移仍需服务端 outbox worker。</p></div></div><div v-if="!referralDetail?.migrationTasks.length" class="ops-referral-task-empty">选择关系查看用户迁移任务。</div><ol v-else class="ops-referral-tasks"><li v-for="task in referralDetail.migrationTasks" :key="task.taskId"><span><strong>{{ task.nickname }} · {{ task.sourceDomainName ?? '无域' }} → {{ task.targetDomainName ?? '无域' }}</strong><small>{{ task.status === AdminReferralMigrationStatus.PENDING ? '待处理' : task.status === AdminReferralMigrationStatus.COMPLETED ? '已完成' : '失败' }} · 帖子 {{ task.contentCounts.posts }} / 回复 {{ task.contentCounts.replies }} / 私聊 {{ task.contentCounts.messages }}</small></span><button v-if="task.status === AdminReferralMigrationStatus.PENDING" type="button" @click="processReferralMigration(task.taskId)">处理演练任务</button></li></ol></section>

    <div v-if="selectedGuide" class="ops-monitor-modal-backdrop" @click.self="closeGuide"><section class="ops-monitor-modal" role="dialog" aria-modal="true" aria-labelledby="ops-monitor-modal-title" tabindex="-1" @keydown.esc="closeGuide"><button ref="guideClose" class="ops-monitor-modal-close" type="button" aria-label="关闭说明" @click="closeGuide">×</button><p class="eyebrow">页面引导</p><h2 id="ops-monitor-modal-title">{{ guideTitle }}</h2><p>{{ copy.details }}</p><p v-if="page === 'referrals'" class="ops-monitor-modal-note">固定链字段为 parent_1_user_id 至 parent_4_user_id；返佣明细需按权限、币种精度和分页游标读取。</p><button type="button" @click="closeGuide">知道了</button></section></div>

    <div v-if="detail || detailLoading || detailError || referralDetail" class="ops-monitor-modal-backdrop" @click.self="closeDetail"><section class="ops-monitor-detail" role="dialog" aria-modal="true" aria-labelledby="ops-detail-title" @keydown.esc="closeDetail"><button class="ops-monitor-modal-close" type="button" aria-label="关闭详情" @click="closeDetail">×</button>
      <template v-if="detailLoading"><p class="eyebrow">只读详情</p><h2 id="ops-detail-title">正在读取…</h2><p role="status">正在加载所选记录的详情。</p></template>
      <template v-else-if="detailError"><p class="eyebrow">详情未读取</p><h2 id="ops-detail-title">无法读取记录</h2><p role="alert">{{ detailError }}</p><button type="button" @click="closeDetail">关闭</button></template>
      <template v-else-if="page === 'referrals' && referralDetail"><p class="eyebrow">邀请关系 · LOCAL_DEMO</p><h2 id="ops-detail-title">{{ referralDetail.binding.nickname }}</h2><p>user {{ referralDetail.binding.userId }} · {{ referralDetail.binding.rewardType === AdminReferralRewardType.RECHARGE ? '充值返点' : '客损由代理线下结算' }} · 当前域 {{ referralDetail.binding.currentDomainName ?? '未归属' }}</p><div class="ops-detail-grid"><article v-for="ancestor in referralDetail.ancestors" :key="ancestor.userId"><small>上级 {{ ancestor.level }}</small><strong>{{ ancestor.nickname }} · {{ ancestor.userId }}</strong></article></div><h3>换绑预览</h3><div class="ops-referral-rebind"><label><span>新直属上级 user ID</span><input v-model="referralNewParent" inputmode="numeric" maxlength="20" placeholder="例如 94100"></label><button type="button" :disabled="!referralNewParent" @click="previewReferralRebind">生成影响预览</button><p class="ops-demo-disclaimer">演练 TOTP：{{ localDemoAdminReferralApplication.demoTotp }}（只在本机生效，不代表服务端验证）</p></div><section v-if="referralPreview" class="ops-referral-preview"><h3>预览：{{ referralPreview.affectedUsers.length }} 个关系行受影响</h3><p>{{ referralPreview.targetNickname }}：{{ referralPreview.previousAncestors.parent1UserId }} → {{ referralPreview.newParentNickname }}。历史返点分配记录保持不变。</p><div class="ops-referral-preview-list"><article v-for="affected in referralPreview.affectedUsers" :key="affected.userId"><strong>{{ affected.nickname }} · {{ affected.userId }}</strong><span>{{ affected.sourceDomainName ?? '无域' }} → {{ affected.targetDomainName ?? '无域' }} · 社交内容 {{ affected.socialCounts.posts }} 帖 / {{ affected.socialCounts.messages }} 条私聊</span></article></div><label><span>换绑原因</span><textarea v-model="referralReason" maxlength="500" minlength="3" rows="2" placeholder="填写审核原因"></textarea></label><label><span>本机演练 TOTP</span><input v-model="referralTotp" inputmode="numeric" maxlength="6" placeholder="6 位数字"></label><button type="button" :disabled="referralBusy || referralReason.trim().length < 3 || referralTotp.length !== 6" @click="submitReferralRebind">{{ referralBusy ? '提交中…' : '确认换绑' }}</button></section><p v-if="referralFeedback" class="user-query-error" role="status">{{ referralFeedback }}</p><h3>历史返点分配（不可变）</h3><div class="ops-detail-list"><article v-for="allocation in referralDetail.allocations" :key="allocation.allocationId"><strong>{{ allocation.rewardCents }} 分 · {{ allocation.rewardStatus === 1 ? '已发放' : '未发放' }}</strong><span>订单 {{ allocation.orderId }} · 受益人 {{ allocation.beneficiaryNickname }} · {{ allocation.ancestorDepth }} 级</span><span>归因快照直属上级 {{ allocation.ancestrySnapshot.parent1UserId ?? '—' }} · {{ formatDate(allocation.createdAt) }}</span></article><p v-if="!referralDetail.allocations.length">暂无返佣分配样例。</p></div><h3>换绑审计事件</h3><div class="ops-detail-list"><article v-for="event in referralDetail.events" :key="event.eventId"><strong>{{ event.reason }}</strong><span>Admin {{ event.adminUserId }} · {{ formatDate(event.createdAt) }}</span><span>{{ event.previousAncestors.parent1UserId ?? '—' }} → {{ event.nextAncestors.parent1UserId ?? '—' }}</span></article><p v-if="!referralDetail.events.length">暂无换绑事件。</p></div><small class="ops-demo-disclaimer">仅本机合成数据。提交不会更改真实用户、返佣账务或社交内容。</small></template>
      <template v-else-if="page === 'rooms' && detail && 'members' in detail"><p class="eyebrow">房间观察 / 本机快照</p><h2 id="ops-detail-title">{{ detail.summary.roomKey }}</h2><p>{{ detail.summary.gameTitle }} · {{ detail.summary.tierTitle }} · {{ roomStatusLabel(detail.summary.status) }} / {{ detail.summary.phase }}</p><div class="ops-detail-grid"><article><small>规则版本</small><strong>{{ detail.summary.rulesVersion }}</strong></article><article><small>房间版本</small><strong>{{ detail.checkpointVersion }}</strong></article><article><small>最近心跳</small><strong>{{ formatDate(detail.heartbeatAt) }}</strong></article><article><small>游戏进程 owner</small><strong>{{ detail.ownerKey ?? '无' }}</strong></article></div><h3>成员与座位</h3><div class="ops-detail-list"><article v-for="member in detail.members" :key="member.userId"><strong>{{ member.nickname }}</strong><span>座位 {{ member.seatNo }} · user {{ member.userId }}</span><span>{{ member.connected ? '在线' : '断线' }} · 加入 {{ formatDate(member.joinedAt) }}</span></article><p v-if="!detail.members.length">当前房间没有成员快照。</p></div><small class="ops-demo-disclaimer">{{ detail.source === AdminOperationsSource.LOCAL_DEMO ? 'LOCAL_DEMO：合成快照，不代表真实房间。' : 'SERVER：服务端实时快照。' }}</small></template>
      <template v-else-if="page === 'rounds' && detail && 'players' in detail"><p class="eyebrow">战绩 / 回放 · 本机样例</p><h2 id="ops-detail-title">{{ detail.summary.roundKey }}</h2><p>{{ detail.summary.gameTitle }} · 房间 {{ detail.summary.roomKey }} · 第 {{ detail.summary.roundNo }} 局 · {{ roundStatusLabel(detail.summary.status) }}</p><div class="ops-detail-grid"><article><small>Handler 版本</small><strong>{{ detail.summary.handlerVersion }}</strong></article><article><small>Fencing Token</small><strong>{{ detail.fencingToken }}</strong></article><article><small>Rules Hash</small><strong>{{ detail.rulesHash }}</strong></article><article><small>Settlement Input Hash</small><strong>{{ detail.settlementInputHash ?? '未封存' }}</strong></article></div><h3>通用参局 / 结算字段</h3><div class="ops-detail-list"><article v-for="player in detail.players" :key="player.userId"><strong>{{ player.nickname }} · 座位 {{ player.seatNo }}</strong><span>下注 {{ player.wagerCoins }} · 净变化 {{ player.netCoinDelta ?? '未结算' }}</span><span>提交类型 {{ player.submissionType === AdminRoundSubmissionType.MANUAL ? '手动' : player.submissionType === AdminRoundSubmissionType.TIMEOUT_AUTO ? '超时托管' : '无' }}</span></article><p v-if="!detail.players.length">本机样例不包含该局参与人摘要。</p></div><h3>Handler 安全摘要</h3><pre class="ops-handler-summary">{{ detail.safeHandlerSummary ?? '未知或无摘要版本；平台不解析游戏私有结果 JSON。' }}</pre><h3>关联资产操作</h3><p class="ops-asset-links">{{ detail.assetOperationIds.length ? detail.assetOperationIds.map((id) => `asset_operation ${id}`).join(' · ') : '无关联操作样例' }}</p><small class="ops-demo-disclaimer">{{ detail.source === AdminOperationsSource.LOCAL_DEMO ? 'LOCAL_DEMO：此结算证据是合成样例，不是账本事实。' : 'SERVER：来自授权服务端查询。' }}</small></template>
    </section></div>
  </section>
</template>
