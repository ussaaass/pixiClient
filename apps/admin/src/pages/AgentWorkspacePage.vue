<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, toRaw, watch } from 'vue';
import { useRoute } from 'vue-router';
import { AgentAuditResultType, type AgentAuditEventDto, type AgentAuditQueryDto } from '@gameing/contracts/agent-audit';
import { AgentDownlinePurpose, AgentDownlineStatus, type AgentDownlineDetailDto, type AgentDownlineDetailReadRequestDto, type AgentDownlineDto, type AgentDownlineQueryDto } from '@gameing/contracts/agent-downlines';
import { type AgentGameConfigScopeDto, type AgentShisanshuiScoringDto, type AgentGameConfigSimulationResponseDto, type AgentGameConfigWorkspaceDto } from '@gameing/contracts/agent-game-config';
import { AgentAnnouncementSource, AgentAnnouncementStatus, type AgentAnnouncementDto } from '@gameing/contracts/agent-announcements';
import { CLASSIC_V1_SCORING, SHISANSHUI_MATH_MODEL_VERSION } from '@gameing/shisanshui-rules';
import PageHelpOverlay from '../components/PageHelpOverlay.vue';
import { agentAuditReadApplication, agentDownlineReadApplication } from '../platform/agent-downlines/composition';
import { agentGameConfigApplication } from '../platform/agent-game-config/composition';
import { agentAnnouncementApplication } from '../platform/agent-announcements/composition';
import { isSafeAgentAnnouncementText } from '../platform/agent-announcements/agent-announcement-domain';

const route = useRoute();
const sections = [
  { path: '/agent/downlines', title: '下线管理' },
  { path: '/agent/games', title: '域级游戏配置' },
  { path: '/agent/announcements', title: '域内广播' },
  { path: '/agent/social', title: '社区与私聊' },
  { path: '/agent/audit', title: '代理操作记录' },
];
const page = computed(() => {
  if (route.meta.agentPage === 'expectation') return { path: '/agent/games', title: '域级期望计算器' };
  if (route.meta.agentPage === 'config') return { path: '/agent/games', title: '域级游戏配置' };
  return sections.find((item) => item.path === route.path) ?? sections[0]!;
});
const isDownlines = computed(() => page.value.path === '/agent/downlines');
const isGames = computed(() => page.value.path === '/agent/games' && route.meta.agentPage !== 'expectation');
const isGameConfig = computed(() => route.meta.agentPage === 'config');
const isExpectation = computed(() => route.meta.agentPage === 'expectation');
const isAnnouncements = computed(() => page.value.path === '/agent/announcements');
const isSocial = computed(() => page.value.path === '/agent/social');
const isAudit = computed(() => page.value.path === '/agent/audit');
const downlineHelp = [
  { heading: '代理域数据隔离', body: '需要 AGENT_DOWNLINE_READ。父代理只查看授权的子代理层级及脱敏汇总，不能读取子代理域明细。客户端筛选和 URL 参数不能扩大服务端授权范围。' },
  { heading: '可读内容', body: '授权范围可包含金币/余额、冻结、账务流水、充值/提现、牌局/投注、返佣和流水要求。密码、TOTP 秘钥、恢复码、设备认证秘密和收款密钥永不提供。导出需要单独 capability、审计和限流。' },
];
const gameConfigHelp = [
  { heading: '平台基准', body: '平台基准值及允许上下界由服务端提供，代理不能编辑。' },
  { heading: '域级参数', body: '只允许修改游戏 handler 登记的 key；不开放任意 JSON、用户级或输赢驱动参数。读取平台继承值、Admin 硬边界和 math model/schema 版本后才能创建参数 diff。' },
  { heading: '发布边界', body: '发布须通过模拟校验并具备 AGENT_GAME_CONFIG_PUBLISH。新版本只影响新局，发布记录进入不可变代理审计。' },
];
const publishHelp = [{ heading: '模拟与发布分离', body: '模拟权限不等于发布权限。提交时服务端重新校验平台硬边界与 capability；配置和代理审计需在同一事务中写入。' }];
const announcementHelp = [
  { heading: '展示范围', body: '公告固定属于当前代理域，不能选择平台全局范围。' },
  { heading: '公告真实性', body: '只有数学模型和有效活动配置确认生效时，公告才能说明概率或派奖变化；纯播报必须明确标为“仅事件播报”。' },
];
const socialHelp = [
  { heading: '权限分区', body: '公开内容管理和私聊读取分别校验 capability；客服 IM 始终属于独立 support 权限。' },
  { heading: '换绑与域可见性', body: '换绑时整段社交内容迁移到新域，旧域成员立即失去会话读取权；迁移期间由服务端暂停相关社交读写。' },
];

const downlineItems = ref<AgentDownlineDto[]>([]);
const downlineTotal = ref(0);
const downlineNextCursor = ref<string | null>(null);
const downlineKeyword = ref('');
const downlineStatus = ref('');
const downlineLoading = ref(false);
const downlineError = ref('');
const selectedDownline = ref<AgentDownlineDetailDto | null>(null);
const selectedDownlineId = ref<string | null>(null);
const downlineDetailTrigger = ref<HTMLElement | null>(null);
const detailLoading = ref(false);
const detailError = ref('');
const detailPurposeOpen = ref(false);
const pendingDownlineId = ref<string | null>(null);
const detailPurposeCode = ref<AgentDownlineDetailReadRequestDto['purposeCode']>(AgentDownlinePurpose.ROUTINE_OPERATIONS_REVIEW);
const detailCaseReference = ref('');
const activeDetailReadRequest = ref<AgentDownlineDetailReadRequestDto | null>(null);
const auditItems = ref<AgentAuditEventDto[]>([]);
const auditTotal = ref(0);
const auditNextCursor = ref<string | null>(null);
const auditKeyword = ref('');
const auditResultType = ref('');
const auditLoading = ref(false);
const auditError = ref('');
const demoScope: AgentGameConfigScopeDto = { agentDomainId: '92001', gameKey: 'shisanshui', difficultyKey: 'practice' };
const candidateConfig = ref<AgentShisanshuiScoringDto>(structuredClone(CLASSIC_V1_SCORING));
const configWorkspace = ref<AgentGameConfigWorkspaceDto | null>(null);
const simulation = ref<AgentGameConfigSimulationResponseDto | null>(null);
const simulationRuns = ref<1000 | 10000>(1000);
const simulationSeed = ref(crypto.randomUUID());
const simulationProgress = ref(0);
const simulationBusy = ref(false);
const configLoading = ref(false);
const configFeedback = ref('');
const configError = ref('');
const publishDialogOpen = ref(false);
const publishReason = ref('');
const publishBusy = ref(false);
const announcements = ref<AgentAnnouncementDto[]>([]);
const announcementsLoading = ref(false);
const announcementsError = ref('');
const announcementDialog = ref<'create' | 'publish' | 'retract' | null>(null);
const announcementDialogTarget = ref<AgentAnnouncementDto | null>(null);
const announcementTitle = ref('');
const announcementBody = ref('');
const announcementReason = ref('');
const announcementStartDelay = ref(0);
const announcementDurationHours = ref(24);
const announcementBusy = ref(false);
const announcementFeedback = ref('');
const featureFields = [
  ['frontThreeOfAKind', '头墩三条奖励'], ['middleFullHouse', '中墩葫芦奖励'], ['middleFourOfAKind', '中墩铁支奖励'],
  ['middleStraightFlush', '中墩同花顺奖励'], ['backFourOfAKind', '底墩铁支奖励'], ['backStraightFlush', '底墩同花顺奖励'],
  ['slam', '打枪倍数'], ['homeRun', '全垒打倍数'], ['foulPayout', '相公赔付'],
] as const;
const payoutFields = [
  ['frontThreeOfAKind', '头墩三条'], ['middleFullHouse', '中墩葫芦'], ['middleFourOfAKind', '中墩铁支'],
  ['middleStraightFlush', '中墩同花顺'], ['backFourOfAKind', '底墩铁支'], ['backStraightFlush', '底墩同花顺'], ['foul', '相公赔付'],
] as const;
const isSupportedGame = computed(() => !isGameConfig.value && !isExpectation.value || (route.params.gameKey === 'shisanshui' && route.params.difficultyKey === 'practice'));
const configTitle = computed(() => route.params.gameKey === 'shisanshui' && route.params.difficultyKey === 'practice' ? '十三张 · 练习厅' : `${String(route.params.gameKey ?? '')} · 当前档位未登记`);
const hasCurrentSimulation = computed(() => !!simulation.value && JSON.stringify(simulation.value.config) === JSON.stringify(candidateConfig.value));
const candidateDirty = computed(() => !!configWorkspace.value && JSON.stringify(configWorkspace.value.effectiveConfig) !== JSON.stringify(candidateConfig.value));
const reportMetrics = computed(() => {
  const report = simulation.value?.report;
  if (!report) return [];
  return [
    ['理论 RTP', '不适用', '十三张是玩家对战水分模型，不是单人返奖游戏'],
    ['固定策略胜率', formatRate(report.winRate), '当前固定理牌策略下净水大于 0'],
    ['轮空率 / 净水为零', formatRate(report.zeroNetRate), '四名玩家桌级模拟'],
    ['相公率', formatRate(report.foulRate), '固定策略分墩违规率'],
    ['打枪率', formatRate(report.slamRate), '至少对一名对手赢下三墩'],
    ['全垒打率', formatRate(report.homeRunRate), '同局清扫其余三名对手'],
    ['期望净水', report.meanNetScore.toFixed(2), '95% 区间 ' + report.meanNetScore95Ci.map((value) => value.toFixed(2)).join(' 至 ')],
    ['净水方差', report.variance.toFixed(2), '标准差 ' + report.standardDeviation.toFixed(2)],
  ];
});
const configDifferences = computed(() => {
  const baseline = configWorkspace.value?.platformConfig;
  if (!baseline) return [];
  const differences: Array<{ key: string; label: string; baseline: string; candidate: string }> = [];
  for (const [key, label] of featureFields) if (candidateConfig.value.features[key] !== baseline.features[key]) differences.push({ key: `feature.${key}`, label, baseline: baseline.features[key] ? '开启' : '关闭', candidate: candidateConfig.value.features[key] ? '开启' : '关闭' });
  for (const [key, label] of payoutFields) if (candidateConfig.value.payouts[key] !== baseline.payouts[key]) differences.push({ key: `payout.${key}`, label, baseline: String(baseline.payouts[key]), candidate: String(candidateConfig.value.payouts[key]) });
  if (candidateConfig.value.slamMultiplier !== baseline.slamMultiplier) differences.push({ key: 'slamMultiplier', label: '打枪倍数', baseline: String(baseline.slamMultiplier), candidate: String(candidateConfig.value.slamMultiplier) });
  if (candidateConfig.value.homeRunMultiplier !== baseline.homeRunMultiplier) differences.push({ key: 'homeRunMultiplier', label: '全垒打倍数', baseline: String(baseline.homeRunMultiplier), candidate: String(candidateConfig.value.homeRunMultiplier) });
  return differences;
});
const maxDistributionCount = computed(() => Math.max(1, ...(simulation.value?.report.distribution.map((item) => item.count) ?? [])));
function formatRate(value: number): string { return `${(value * 100).toFixed(2)}%`; }
let previousBodyOverflow = '';

const detailModalOpen = computed(() => detailPurposeOpen.value || !!selectedDownlineId.value);
watch(detailModalOpen, (open) => {
  if (open) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  } else {
    document.body.style.overflow = previousBodyOverflow;
  }
});
onBeforeUnmount(() => { document.body.style.overflow = previousBodyOverflow; });

watch(() => route.path, (path) => {
  if (path === '/agent/downlines' && !downlineItems.value.length) void loadDownlines();
  if (path === '/agent/audit') void loadAuditEvents();
  if (path === '/agent/announcements') void loadAgentAnnouncements();
  if ((route.meta.agentPage === 'config' || route.meta.agentPage === 'expectation') && route.params.gameKey === 'shisanshui') void loadAgentGameConfig();
  if (path !== '/agent/downlines' && (selectedDownlineId.value || detailPurposeOpen.value)) closeDownline();
}, { immediate: true });

async function loadAgentGameConfig(): Promise<void> {
  configLoading.value = true;
  configError.value = '';
  const result = await agentGameConfigApplication.read({ target: { gameKey: demoScope.gameKey, difficultyKey: demoScope.difficultyKey } });
  if (!result.ok) configError.value = '域级配置读取失败，请重试。';
  else {
    configWorkspace.value = result.value;
    if (!candidateDirty.value) candidateConfig.value = structuredClone(result.value.effectiveConfig);
  }
  configLoading.value = false;
}

async function loadAgentAnnouncements(): Promise<void> {
  announcementsLoading.value = true;
  announcementsError.value = '';
  const result = await agentAnnouncementApplication.list({});
  if (!result.ok) announcementsError.value = '公告读取失败，请重试。';
  else announcements.value = result.value.items;
  announcementsLoading.value = false;
}

function openAnnouncementCreate(): void {
  announcementTitle.value = '';
  announcementBody.value = '';
  announcementReason.value = '';
  announcementStartDelay.value = 0;
  announcementDurationHours.value = 24;
  announcementDialogTarget.value = null;
  announcementDialog.value = 'create';
}

function openAnnouncementAction(action: 'publish' | 'retract', announcement: AgentAnnouncementDto): void {
  announcementDialogTarget.value = announcement;
  announcementReason.value = '';
  announcementDialog.value = action;
}

async function submitAgentAnnouncement(): Promise<void> {
  if (announcementBusy.value || announcementReason.value.trim().length < 3) return;
  announcementBusy.value = true;
  let result: Awaited<ReturnType<typeof agentAnnouncementApplication.create>> | Awaited<ReturnType<typeof agentAnnouncementApplication.publish>> | Awaited<ReturnType<typeof agentAnnouncementApplication.retract>>;
  if (announcementDialog.value === 'create') {
    result = await agentAnnouncementApplication.create({ title: announcementTitle.value, body: announcementBody.value, reason: announcementReason.value, requestKey: crypto.randomUUID() });
  } else if (announcementDialog.value === 'publish' && announcementDialogTarget.value) {
    const starts = new Date(Date.now() + announcementStartDelay.value * 60 * 60 * 1000);
    const ends = new Date(starts.getTime() + announcementDurationHours.value * 60 * 60 * 1000);
    result = await agentAnnouncementApplication.publish({ announcementId: announcementDialogTarget.value.announcementId, startsAt: starts.toISOString(), expiresAt: ends.toISOString(), reason: announcementReason.value, requestKey: crypto.randomUUID() });
  } else if (announcementDialog.value === 'retract' && announcementDialogTarget.value) {
    result = await agentAnnouncementApplication.retract({ announcementId: announcementDialogTarget.value.announcementId, reason: announcementReason.value, requestKey: crypto.randomUUID() });
  } else { announcementBusy.value = false; return; }
  if (!result.ok) {
    announcementsError.value = result.code === 'INVALID_REQUEST' ? '公告内容或有效期不符合规则，请检查后重试。' : result.code === 'INVALID_STATE' ? '公告状态已变化，请刷新列表后重试。' : '操作未完成，请重试。';
  } else {
    const verb = announcementDialog.value === 'create' ? '已保存草稿' : announcementDialog.value === 'publish' ? '已发布公告' : '已撤回公告';
    announcementFeedback.value = `${verb}。当前为浏览器本机演练，未投递到玩家大厅。`;
    announcementDialog.value = null;
    announcementDialogTarget.value = null;
    await loadAgentAnnouncements();
  }
  announcementBusy.value = false;
}

function announcementStatusLabel(status: AgentAnnouncementDto['status']): string {
  return status === AgentAnnouncementStatus.DRAFT ? '草稿' : status === AgentAnnouncementStatus.SCHEDULED ? '定时中' : status === AgentAnnouncementStatus.ACTIVE ? '展示中' : status === AgentAnnouncementStatus.RETRACTED ? '已撤回' : '已过期';
}

async function simulateAgentConfig(): Promise<void> {
  if (simulationBusy.value || !configWorkspace.value) return;
  simulationBusy.value = true;
  simulation.value = null;
  simulationProgress.value = 0;
  configFeedback.value = '正在本机浏览器内存模拟，不扣款、不创建真实牌局，也不写业务数据。';
  const result = await agentGameConfigApplication.simulate({ target: { gameKey: demoScope.gameKey, difficultyKey: demoScope.difficultyKey }, runs: simulationRuns.value, seed: simulationSeed.value.trim() || crypto.randomUUID(), config: structuredClone(toRaw(candidateConfig.value)), reason: '代理域配置效果预览', requestKey: crypto.randomUUID() }, (completed, total) => { simulationProgress.value = Math.floor(completed / total * 100); }, () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  if (!result.ok) configFeedback.value = '模拟失败，请检查候选参数并重试。';
  else {
    simulation.value = result.value;
    simulationProgress.value = 100;
    configFeedback.value = `${result.value.report.runs.toLocaleString()} 局模拟完成；报告只对当前配置、策略和 seed 有效。`;
  }
  simulationBusy.value = false;
}

async function publishAgentConfig(): Promise<void> {
  if (!configWorkspace.value || !simulation.value || !hasCurrentSimulation.value || publishReason.value.trim().length < 3 || publishBusy.value) return;
  publishBusy.value = true;
  const result = await agentGameConfigApplication.publish({ target: { gameKey: demoScope.gameKey, difficultyKey: demoScope.difficultyKey }, config: structuredClone(toRaw(candidateConfig.value)), simulation: simulation.value, reason: publishReason.value.trim(), requestKey: crypto.randomUUID() });
  if (!result.ok) configFeedback.value = '发布失败：候选或模拟报告已失效，重新模拟后再试。';
  else {
    configWorkspace.value = result.value.workspace;
    candidateConfig.value = structuredClone(result.value.workspace.effectiveConfig);
    configFeedback.value = `本机演练发布成功，审计编号 ${result.value.auditId}。仅对本浏览器演练数据生效。`;
    publishDialogOpen.value = false;
    publishReason.value = '';
  }
  publishBusy.value = false;
}

function resetConfigCandidate(): void {
  if (!configWorkspace.value) return;
  candidateConfig.value = structuredClone(configWorkspace.value.effectiveConfig);
  simulation.value = null;
  configFeedback.value = '已恢复当前域有效配置。';
}

async function loadAuditEvents(cursor?: string): Promise<void> {
  auditLoading.value = true;
  auditError.value = '';
  try {
    const resultType = parseAuditResultType(auditResultType.value);
    const query: AgentAuditQueryDto = {
      ...(auditKeyword.value.trim() ? { keyword: auditKeyword.value.trim() } : {}),
      ...(resultType !== undefined ? { resultType } : {}),
      ...(cursor ? { cursor } : {}),
      pageSize: 20,
    };
    const result = await agentAuditReadApplication.list(query);
    if (!result.ok) throw new Error(result.code);
    auditItems.value = cursor ? [...auditItems.value, ...result.value.items] : result.value.items;
    auditTotal.value = result.value.total;
    auditNextCursor.value = result.value.nextCursor;
  } catch {
    auditError.value = '操作记录读取失败，请重试。';
  } finally {
    auditLoading.value = false;
  }
}

async function loadDownlines(cursor?: string): Promise<void> {
  downlineLoading.value = true;
  downlineError.value = '';
  try {
    const status = parseDownlineStatus(downlineStatus.value);
    const query: AgentDownlineQueryDto = {
      ...(downlineKeyword.value.trim() ? { keyword: downlineKeyword.value.trim() } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(cursor ? { cursor } : {}),
      pageSize: 20,
    };
    const result = await agentDownlineReadApplication.list(query);
    if (!result.ok) throw new Error(result.code);
    downlineItems.value = cursor ? [...downlineItems.value, ...result.value.items] : result.value.items;
    downlineTotal.value = result.value.total;
    downlineNextCursor.value = result.value.nextCursor;
  } catch {
    downlineError.value = '下线资料读取失败，请重试。';
  } finally {
    downlineLoading.value = false;
  }
}

type AgentDownlineStatusValue = typeof AgentDownlineStatus[keyof typeof AgentDownlineStatus];

function parseDownlineStatus(value: string): AgentDownlineStatusValue | undefined {
  if (value === String(AgentDownlineStatus.ACTIVE)) return AgentDownlineStatus.ACTIVE;
  if (value === String(AgentDownlineStatus.SUSPENDED)) return AgentDownlineStatus.SUSPENDED;
  if (value === String(AgentDownlineStatus.CLOSED)) return AgentDownlineStatus.CLOSED;
  return undefined;
}

function parseAuditResultType(value: string): typeof AgentAuditResultType[keyof typeof AgentAuditResultType] | undefined {
  if (value === String(AgentAuditResultType.SUCCESS)) return AgentAuditResultType.SUCCESS;
  if (value === String(AgentAuditResultType.DENIED)) return AgentAuditResultType.DENIED;
  if (value === String(AgentAuditResultType.FAILED)) return AgentAuditResultType.FAILED;
  return undefined;
}

async function openDownline(userId: string, event?: MouseEvent): Promise<void> {
  downlineDetailTrigger.value = event?.currentTarget instanceof HTMLElement ? event.currentTarget : downlineDetailTrigger.value;
  pendingDownlineId.value = userId;
  detailPurposeOpen.value = true;
  detailPurposeCode.value = AgentDownlinePurpose.ROUTINE_OPERATIONS_REVIEW;
  detailCaseReference.value = '';
  activeDetailReadRequest.value = null;
  await nextTick();
  document.querySelector<HTMLSelectElement>('.agent-downline-purpose-dialog select')?.focus();
}

async function submitDownlineDetailRead(): Promise<void> {
  const userId = pendingDownlineId.value;
  if (!userId) return;
  if (detailPurposeCode.value === AgentDownlinePurpose.SUPPORT_CASE && detailCaseReference.value.trim().length < 3) {
    detailError.value = '客服工单号至少填写 3 个字符。';
    return;
  }
  const request = activeDetailReadRequest.value ??= {
    purposeCode: detailPurposeCode.value,
    ...(detailPurposeCode.value === AgentDownlinePurpose.SUPPORT_CASE ? { caseReference: detailCaseReference.value.trim() } : {}),
    requestKey: crypto.randomUUID(),
  };
  selectedDownlineId.value = userId;
  selectedDownline.value = null;
  detailPurposeOpen.value = false;
  detailError.value = '';
  detailLoading.value = true;
  try {
    const result = await agentDownlineReadApplication.detail(userId, request);
    if (!result.ok) throw new Error(result.code);
    selectedDownline.value = result.value;
    await nextTick();
    document.querySelector<HTMLButtonElement>('.agent-downline-drawer header button')?.focus();
  } catch {
    detailError.value = '用户明细暂时读取失败，请关闭后重试。';
  } finally {
    detailLoading.value = false;
  }
}

function closeDownline(): void {
  selectedDownline.value = null;
  selectedDownlineId.value = null;
  detailPurposeOpen.value = false;
  pendingDownlineId.value = null;
  detailError.value = '';
  activeDetailReadRequest.value = null;
  void nextTick(() => downlineDetailTrigger.value?.focus());
}

function cancelDownlineRead(): void {
  detailPurposeOpen.value = false;
  pendingDownlineId.value = null;
  detailError.value = '';
  void nextTick(() => downlineDetailTrigger.value?.focus());
}

function trapDetailDrawerTab(event: KeyboardEvent): void {
  const drawer = document.querySelector<HTMLElement>('.agent-downline-drawer');
  if (!drawer) return;
  const items = [...drawer.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')];
  const activeIndex = items.indexOf(document.activeElement as HTMLElement);
  if (event.shiftKey && activeIndex === 0) { event.preventDefault(); items.at(-1)?.focus(); }
  else if (!event.shiftKey && activeIndex === items.length - 1) { event.preventDefault(); items[0]?.focus(); }
}

function trapPurposeDialogTab(event: KeyboardEvent): void {
  const dialog = document.querySelector<HTMLElement>('.agent-downline-purpose-dialog');
  if (!dialog) return;
  const items = [...dialog.querySelectorAll<HTMLElement>('select:not(:disabled), input:not(:disabled), button:not(:disabled)')];
  const activeIndex = items.indexOf(document.activeElement as HTMLElement);
  if (event.shiftKey && activeIndex === 0) { event.preventDefault(); items.at(-1)?.focus(); }
  else if (!event.shiftKey && activeIndex === items.length - 1) { event.preventDefault(); items[0]?.focus(); }
}

function statusText(status: AgentDownlineStatusValue): string {
  return status === AgentDownlineStatus.ACTIVE ? '正常' : status === AgentDownlineStatus.SUSPENDED ? '暂停' : '已关闭';
}
function cny(fen: string): string {
  const value = BigInt(fen);
  const negative = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${negative}¥${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
function activityAmount(activity: AgentDownlineDetailDto['recentActivities'][number]): string {
  return activity.asset === 'COIN' ? `${activity.amount} 金币` : activity.asset === 'CNY_FEN' ? cny(activity.amount) : '—';
}
function auditResultText(result: AgentAuditEventDto['resultType']): string {
  return result === AgentAuditResultType.SUCCESS ? '成功' : result === AgentAuditResultType.DENIED ? '拒绝' : '失败';
}
</script>

<template>
  <section class="agent-operations-page">
    <div class="agent-operations-heading">
      <div><p class="eyebrow">AGENT DOMAIN</p><h1>{{ isExpectation ? '域级期望计算器' : page.title }}</h1><p>查看当前代理域的授权运营数据。</p></div>
    </div>
    <nav v-if="!isExpectation" class="agent-operations-tabs" aria-label="代理域业务页面">
      <RouterLink v-for="section in sections" :key="section.path" :to="section.path" :class="{ active: page.path === section.path }">{{ section.title }}</RouterLink>
    </nav>
    <RouterLink v-else to="/agent/games" class="back-link">← 返回域级游戏配置</RouterLink>

    <template v-if="isDownlines">
      <section class="agent-operations-panel">
        <div class="agent-operations-panel-heading"><div><h2>授权范围内的下线</h2><p>只显示获准访问的直接管理范围及允许的父域汇总。</p></div><div class="agent-operations-panel-tools"><PageHelpOverlay title="下线数据范围" trigger-label="查看下线数据范围说明" :sections="downlineHelp" /></div></div>
        <form class="agent-downline-filters" @submit.prevent="loadDownlines()"><label>用户名 / user ID<input v-model="downlineKeyword" maxlength="64" placeholder="搜索当前管理范围"></label><label>用户状态<select v-model="downlineStatus"><option value="">全部状态</option><option :value="String(AgentDownlineStatus.ACTIVE)">正常</option><option :value="String(AgentDownlineStatus.SUSPENDED)">暂停</option><option :value="String(AgentDownlineStatus.CLOSED)">已关闭</option></select></label><div class="agent-downline-scope"><small>关系范围</small><span>仅当前授权管理范围</span></div><button type="submit" :disabled="downlineLoading">{{ downlineLoading ? '正在查询…' : '查询下线' }}</button></form>
        <p class="agent-downline-demo-note">开发预览 · 使用隔离的本机演练资料，不代表真实用户或线上授权数据。</p>
        <p v-if="downlineError" class="agent-downline-error" role="alert">{{ downlineError }} <button type="button" @click="loadDownlines()">重试</button></p>
        <div v-else-if="downlineLoading && !downlineItems.length" class="agent-operations-empty" role="status">正在读取下线资料…</div>
        <div v-else-if="!downlineItems.length" class="agent-operations-empty"><span>♙</span><strong>没有符合条件的下线</strong><p>试试更短的用户名或调整状态筛选。</p></div>
        <template v-else>
          <div class="agent-downline-table-wrap"><table class="agent-downline-table"><thead><tr><th>用户</th><th>状态</th><th>可用资产</th><th>冻结资产</th><th>直属下线</th><th>最近活跃</th><th></th></tr></thead><tbody><tr v-for="item in downlineItems" :key="item.userId"><td><strong>{{ item.displayName }}</strong><small>ID {{ item.userId }}</small></td><td><span class="agent-downline-status" :data-status="item.userStatus">{{ statusText(item.userStatus) }}</span></td><td>{{ item.coinAvailable }} 币 · {{ cny(item.cnyAvailableFen) }}</td><td>{{ item.coinFrozen }} 币 · {{ cny(item.cnyFrozenFen) }}</td><td>{{ item.directDownlineCount }}</td><td>{{ item.lastActiveAt ? new Date(item.lastActiveAt).toLocaleString('zh-CN') : '—' }}</td><td><button type="button" @click="openDownline(item.userId, $event)">查看明细</button></td></tr></tbody></table></div>
          <div class="agent-downline-pagination"><span>共 {{ downlineTotal }} 位用户</span><button v-if="downlineNextCursor" type="button" :disabled="downlineLoading" @click="loadDownlines(downlineNextCursor)">{{ downlineLoading ? '正在读取…' : '加载更多' }}</button></div>
        </template>
      </section>
    </template>

    <template v-else-if="isGames">
      <section class="agent-operations-panel">
        <template v-if="!isGameConfig">
          <div class="agent-operations-panel-heading"><div><h2>本域可配置游戏</h2><p>只展示已登记配置 schema、规则 handler 与数学模型的游戏。</p></div><div class="agent-operations-panel-tools"><PageHelpOverlay title="域级游戏配置说明" trigger-label="查看域级游戏配置说明" :sections="gameConfigHelp" /></div></div>
          <p class="agent-demo-note">开发演练 · 使用固定代理域样例和浏览器本机数据，不能代表线上授权或线上生效配置。</p>
          <RouterLink class="agent-config-game-card" to="/agent/games/shisanshui/difficulties/practice/config"><span class="agent-config-game-icon">♠</span><span><strong>十三张</strong><small>练习厅 · classic_v1 · 固定策略模拟器已登记</small></span><b>打开配置 →</b></RouterLink>
          <div class="agent-config-unavailable-grid"><article v-for="game in ['跳高高', '夺宝奇侠', '麻将胡了', '麻将胡了2', '捕鱼', '赏金女王', '3快']" :key="game"><strong>{{ game }}</strong><small>数学模型 / 配置边界未登记</small><span>暂不可配置</span></article></div>
        </template>
        <template v-else-if="!isSupportedGame">
          <div class="agent-operations-empty"><strong>该游戏的数学模型尚未登记</strong><p>不会展示或保存未经过对应 handler 和模型校验的参数。返回列表选择已登记游戏。</p><RouterLink to="/agent/games">返回游戏配置</RouterLink></div>
        </template>
        <template v-else>
          <div class="agent-operations-panel-heading"><div><h2>{{ configTitle }}</h2><p>只修改此游戏 handler 登记的计分项；保存为候选后进入期望计算器。</p></div><div class="agent-operations-panel-tools"><PageHelpOverlay title="域级游戏配置说明" trigger-label="查看域级游戏配置说明" :sections="gameConfigHelp" /><span>本机演练</span></div></div>
          <p class="agent-demo-note">LOCAL_DEMO · 代理域 {{ configWorkspace?.scope.agentDomainId ?? '读取中' }} · 平台基准 {{ configWorkspace?.configVersion ?? '读取中' }} · 数学模型 {{ SHISANSHUI_MATH_MODEL_VERSION }}</p>
          <p v-if="configError" class="agent-downline-error" role="alert">{{ configError }} <button type="button" @click="loadAgentGameConfig">重试</button></p>
          <div v-else-if="configLoading" class="agent-operations-empty" role="status">正在读取域级配置…</div>
          <template v-else>
            <div class="agent-config-editor">
              <fieldset><legend>玩法计分开关</legend><label v-for="[key, label] in featureFields" :key="key"><input v-model="candidateConfig.features[key]" type="checkbox">{{ label }}</label></fieldset>
              <fieldset><legend>水值与倍数（平台硬范围：1–1000）</legend><label v-for="[key, label] in payoutFields" :key="key">{{ label }}<input v-model.number="candidateConfig.payouts[key]" type="number" min="1" max="1000" step="1"></label><label>打枪倍数<input v-model.number="candidateConfig.slamMultiplier" type="number" min="1" max="1000" step="1"></label><label>全垒打倍数<input v-model.number="candidateConfig.homeRunMultiplier" type="number" min="1" max="1000" step="1"></label></fieldset>
            </div>
            <div class="agent-config-diff"><div class="agent-config-diff-heading"><strong>与平台基准的差异</strong><span>{{ configDifferences.length }} 项</span></div><p v-if="!configDifferences.length">当前候选与平台值一致。</p><ul v-else><li v-for="item in configDifferences" :key="item.key"><span>{{ item.label }}</span><b>{{ item.baseline }} <i>→</i> {{ item.candidate }}</b></li></ul></div>
            <div class="agent-config-effective"><span>当前有效配置</span><strong>{{ configWorkspace?.publishedAt ? `域配置已发布 · ${new Date(configWorkspace.publishedAt).toLocaleString('zh-CN')}` : '继承平台基准' }}</strong><small>有效版本 {{ configWorkspace?.configVersion }}。新开局读取新值；已经开始的局保持原快照。</small></div>
            <div class="agent-config-actions"><button type="button" @click="resetConfigCandidate">恢复有效值</button><RouterLink class="agent-config-primary" to="/agent/games/shisanshui/difficulties/practice/expectation">检查候选并试算 →</RouterLink></div>
          </template>
          <p v-if="configFeedback" class="agent-downline-demo-note" role="status">{{ configFeedback }}</p>
        </template>
      </section>
    </template>

    <template v-else-if="isExpectation">
      <section class="agent-operations-panel">
        <div class="agent-operations-panel-heading"><div><h2>{{ configTitle }} · 固定策略期望计算器</h2><p>运行同一纯规则结算逻辑的桌级虚拟对局；不扣钱、不读取真实玩家输赢、不写牌局或账务数据。</p></div><PageHelpOverlay title="模拟与发布边界" trigger-label="查看计算器说明" :sections="publishHelp" /></div>
        <p v-if="!isSupportedGame" class="agent-demo-note">此游戏尚无数学模型。请返回游戏配置列表；本页不会用其它游戏的模型代替。</p>
        <template v-else>
          <div class="agent-simulation-context"><span>代理域</span><strong>{{ configWorkspace?.scope.agentDomainId ?? '正在解析' }}</strong><span>游戏 / 难度</span><strong>十三张 / 练习厅</strong><span>候选水值</span><strong>{{ candidateConfig.payouts.frontThreeOfAKind }} · {{ candidateConfig.payouts.middleFullHouse }} · {{ candidateConfig.payouts.middleFourOfAKind }} …</strong></div>
          <div class="agent-simulation-controls"><label>模拟局数<select v-model.number="simulationRuns"><option :value="1000">1000 局 · 快速预览</option><option :value="10000">10000 局 · 扩大样本</option></select></label><label>随机种子<input v-model="simulationSeed" maxlength="128"></label><button type="button" :disabled="simulationBusy || !configWorkspace" @click="simulateAgentConfig">{{ simulationBusy ? `模拟中 ${simulationProgress}%` : '开始模拟' }}</button></div>
          <progress v-if="simulationBusy" class="agent-simulation-progress" max="100" :value="simulationProgress" aria-label="模拟进度"></progress>
          <p v-if="configFeedback" class="agent-downline-demo-note" role="status">{{ configFeedback }}</p>
          <div v-if="simulation" class="agent-simulation-report"><div class="agent-simulation-report-heading"><strong>模拟结果 · {{ simulation.report.runs.toLocaleString() }} 局</strong><span>{{ simulation.report.strategyKey }} · {{ simulation.report.modelVersion }} · seed {{ simulation.report.seed }}</span></div><div class="agent-simulation-metrics"><article v-for="[label, value, note] in reportMetrics" :key="label"><small>{{ label }}</small><strong>{{ value }}</strong><p>{{ note }}</p></article></div><div class="agent-simulation-distribution"><h3>净水分布</h3><div v-for="item in simulation.report.distribution" :key="item.netScore" class="agent-distribution-row"><span>{{ item.netScore > 0 ? '+' : '' }}{{ item.netScore }} 水</span><div><i :style="{ width: `${Math.max(item.count / maxDistributionCount * 100, 1)}%` }"></i></div><b>{{ item.count }} 局 · {{ formatRate(item.share) }}</b></div></div><p v-if="simulation.report.warnings.length" class="agent-simulation-warning">{{ simulation.report.warnings.join('；') }}</p></div>
          <div v-else class="agent-operations-empty"><strong>还没有模拟报告</strong><p>候选值采用十三张固定排序策略；RTP 不适用，报告展示胜率、轮空/净分为零、大奖率、净水分布、方差和区间。</p></div>
          <div class="agent-config-actions"><RouterLink class="agent-config-secondary" to="/agent/games/shisanshui/difficulties/practice/config">返回调整候选</RouterLink><button class="agent-config-primary" type="button" :disabled="!hasCurrentSimulation" @click="publishDialogOpen = true">{{ hasCurrentSimulation ? '应用候选并发布本域配置' : '完成当前候选模拟后发布' }}</button></div>
        </template>
      </section>
    </template>

    <template v-else-if="isAnnouncements">
      <section class="agent-operations-panel">
        <div class="agent-operations-panel-heading"><div><h2>本代理域公告</h2><p>公告仅属于当前代理域；文字、有效期和每次操作原因都会留在本机演练记录中。</p></div><div class="agent-operations-panel-tools"><PageHelpOverlay title="代理域公告说明" trigger-label="查看代理域公告说明" :sections="announcementHelp" /><button type="button" @click="openAnnouncementCreate">＋ 新建公告</button></div></div>
        <p class="agent-local-demo-note">LOCAL_DEMO · 需要 `AGENT_ANNOUNCEMENT_MANAGE`。预览和发布只写入此浏览器，不会推送到玩家端；禁止填写概率、赔率、派奖变化或外部链接。</p>
        <p v-if="announcementFeedback" class="agent-downline-demo-note" role="status">{{ announcementFeedback }}</p>
        <p v-if="announcementsError" class="agent-downline-error" role="alert">{{ announcementsError }} <button type="button" @click="loadAgentAnnouncements">重试</button></p>
        <div v-else-if="announcementsLoading && !announcements.length" class="agent-operations-empty" role="status">正在读取域内公告…</div>
        <div v-else-if="!announcements.length" class="agent-operations-empty"><span>◉</span><strong>还没有域内公告</strong><p>创建一条纯文字公告后，可预览、立即发布或安排一小时后展示，并在有效期内撤回。</p><button type="button" @click="openAnnouncementCreate">创建第一条公告</button></div>
        <div v-else class="agent-announcement-list"><article v-for="announcement in announcements" :key="announcement.announcementId" class="agent-announcement-card"><header><div><span class="agent-announcement-status" :data-status="announcement.status">{{ announcementStatusLabel(announcement.status) }}</span><small>{{ announcement.source === AgentAnnouncementSource.LOCAL_DEMO ? '本机演练' : '服务端' }} · 域 {{ announcement.agentDomainId }}</small></div><time>{{ new Date(announcement.createdAt).toLocaleString('zh-CN') }}</time></header><h3>{{ announcement.title }}</h3><p>{{ announcement.body }}</p><div v-if="announcement.startsAt" class="agent-announcement-period"><span>{{ announcement.status === AgentAnnouncementStatus.SCHEDULED ? '计划展示' : '开始展示' }}：{{ new Date(announcement.startsAt).toLocaleString('zh-CN') }}</span><span>结束：{{ new Date(announcement.expiresAt!).toLocaleString('zh-CN') }}</span></div><footer><button v-if="announcement.status === AgentAnnouncementStatus.DRAFT" type="button" @click="openAnnouncementAction('publish', announcement)">预览并发布</button><button v-if="announcement.status === AgentAnnouncementStatus.ACTIVE || announcement.status === AgentAnnouncementStatus.SCHEDULED" class="agent-announcement-retract" type="button" @click="openAnnouncementAction('retract', announcement)">撤回</button></footer></article></div>
      </section>
    </template>

    <template v-else-if="isSocial">
      <section class="agent-operations-panel">
        <div class="agent-operations-panel-heading"><div><h2>域内社区与私聊</h2><p>公开内容管理和私聊读取分别授权。</p></div><div class="agent-operations-panel-tools"><PageHelpOverlay title="换绑后的社交内容" trigger-label="查看换绑后的社交内容说明" :sections="socialHelp" /></div></div>
        <div class="agent-social-permission-grid"><article><strong>话题 / 帖子 / 回复</strong><small>AGENT_SOCIAL_MODERATE</small><p>只管理当前域公开内容，处理动作记录理由和审计。</p></article><article><strong>好友 / 私聊只读</strong><small>AGENT_SOCIAL_READ_PRIVATE_MESSAGES</small><p>必须单独获授；读取记录审计，不复制消息正文到日志。</p></article></div>
        <div class="agent-operations-empty"><span>☏</span><strong>暂无社区或私聊记录</strong></div>
      </section>
    </template>

    <template v-else-if="isAudit">
      <section class="agent-operations-panel">
        <div class="agent-operations-panel-heading"><div><h2>本人的代理操作记录</h2><p>Admin 对代理的授权记录仍属于 Admin 审计，不混在代理自行操作记录中。</p></div><span>只读</span></div>
        <form class="agent-audit-filters" @submit.prevent="loadAuditEvents()"><label>动作 / 资源 / 查看目的<input v-model="auditKeyword" maxlength="64" placeholder="搜索审计记录"></label><label>处理结果<select v-model="auditResultType"><option value="">全部结果</option><option :value="String(AgentAuditResultType.SUCCESS)">成功</option><option :value="String(AgentAuditResultType.DENIED)">拒绝</option><option :value="String(AgentAuditResultType.FAILED)">失败</option></select></label><div class="agent-downline-scope"><small>记录范围</small><span>当前代理本人 · 不可变记录</span></div><button type="submit" :disabled="auditLoading">{{ auditLoading ? '正在查询…' : '查询记录' }}</button></form>
        <p v-if="auditError" class="agent-downline-error" role="alert">{{ auditError }} <button type="button" @click="loadAuditEvents()">重试</button></p>
        <div v-else-if="auditLoading && !auditItems.length" class="agent-operations-empty" role="status">正在读取代理操作记录…</div>
        <div v-else-if="!auditItems.length" class="agent-operations-empty"><span>≋</span><strong>暂无操作记录</strong><p>查看下线业务明细等敏感操作会记录目的、目标和结果，不包含认证秘密或私聊正文。</p></div>
        <template v-else><div class="agent-downline-table-wrap"><table class="agent-downline-table agent-audit-table"><thead><tr><th>时间</th><th>动作</th><th>目标</th><th>查看目的</th><th>结果</th><th>审计编号</th></tr></thead><tbody><tr v-for="item in auditItems" :key="item.auditId"><td>{{ new Date(item.createdAt).toLocaleString('zh-CN') }}</td><td>{{ item.actionCode }}</td><td>{{ item.resourceType }} · {{ item.resourceKey }}</td><td>{{ item.purpose }}</td><td><span class="agent-downline-status" :data-status="item.resultType">{{ auditResultText(item.resultType) }}</span></td><td>{{ item.auditId }}</td></tr></tbody></table></div><div class="agent-downline-pagination"><span>共 {{ auditTotal }} 条不可变记录</span><button v-if="auditNextCursor" type="button" :disabled="auditLoading" @click="loadAuditEvents(auditNextCursor)">{{ auditLoading ? '正在读取…' : '加载更多' }}</button></div></template>
      </section>
    </template>
  </section>
  <div v-if="detailPurposeOpen" class="agent-downline-scrim agent-downline-purpose-scrim" @click.self="cancelDownlineRead" @keydown.esc="cancelDownlineRead">
    <form class="agent-downline-purpose-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-downline-purpose-title" @submit.prevent="submitDownlineDetailRead" @keydown.tab="trapPurposeDialogTab">
      <h2 id="agent-downline-purpose-title">查看业务明细</h2>
      <p>本次读取会写入代理操作审计，请选择查看目的。</p>
      <label>查看目的<select v-model="detailPurposeCode"><option :value="AgentDownlinePurpose.ROUTINE_OPERATIONS_REVIEW">日常业务核查</option><option :value="AgentDownlinePurpose.ASSET_EXCEPTION_FOLLOWUP">资产异常跟进</option><option :value="AgentDownlinePurpose.PAYMENT_FOLLOWUP">充值或提现跟进</option><option :value="AgentDownlinePurpose.GAME_DISPUTE_FOLLOWUP">牌局争议跟进</option><option :value="AgentDownlinePurpose.SUPPORT_CASE">客服工单处理</option></select></label>
      <label v-if="detailPurposeCode === AgentDownlinePurpose.SUPPORT_CASE">客服工单号<input v-model="detailCaseReference" maxlength="80" minlength="3" required placeholder="填写工单编号"></label>
      <p v-if="detailError" class="agent-downline-error" role="alert">{{ detailError }}</p>
      <footer><button class="agent-downline-purpose-cancel" type="button" @click="cancelDownlineRead">取消</button><button class="agent-downline-purpose-submit" type="submit" :disabled="detailPurposeCode === AgentDownlinePurpose.SUPPORT_CASE && detailCaseReference.trim().length < 3">继续查看</button></footer>
    </form>
  </div>
  <div v-if="publishDialogOpen" class="agent-downline-scrim agent-downline-purpose-scrim" @click.self="publishDialogOpen = false" @keydown.esc="publishDialogOpen = false">
    <form class="agent-downline-purpose-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-config-publish-title" @submit.prevent="publishAgentConfig">
      <h2 id="agent-config-publish-title">发布本代理域配置</h2>
      <p>该操作只写入当前浏览器的 LOCAL_DEMO 配置快照和代理审计，不会修改线上或其他设备配置。</p>
      <div class="agent-config-publish-summary"><span>{{ simulation?.report.runs.toLocaleString() }} 局模拟</span><strong>平均净水 {{ simulation?.report.meanNetScore.toFixed(2) }}</strong><small>{{ simulation?.report.modelVersion }} · {{ simulation?.report.seed }}</small></div>
      <label>发布原因<input v-model="publishReason" minlength="3" maxlength="240" required placeholder="说明为何调整此配置"></label>
      <footer><button type="button" @click="publishDialogOpen = false">取消</button><button class="agent-downline-purpose-submit" type="submit" :disabled="publishBusy || publishReason.trim().length < 3 || !hasCurrentSimulation">{{ publishBusy ? '正在发布…' : '确认本机演练发布' }}</button></footer>
    </form>
  </div>
  <div v-if="selectedDownlineId" class="agent-downline-scrim" @click.self="closeDownline" @keydown.esc="closeDownline">
    <section class="agent-downline-drawer" role="dialog" aria-modal="true" :aria-label="selectedDownline ? `${selectedDownline.downline.displayName}的业务明细` : '下线业务明细'" @keydown.tab="trapDetailDrawerTab">
      <header><div><p class="eyebrow">DOWNLINE DETAIL</p><h2>{{ selectedDownline?.downline.displayName ?? '下线业务明细' }}</h2><small v-if="selectedDownline">ID {{ selectedDownline.downline.userId }} · {{ statusText(selectedDownline.downline.userStatus) }}</small></div><button type="button" aria-label="关闭明细" @click="closeDownline">×</button></header>
      <p v-if="detailLoading" role="status">正在读取授权范围内的业务明细…</p>
      <p v-else-if="detailError" class="agent-downline-error" role="alert">{{ detailError }} <button type="button" @click="submitDownlineDetailRead">重试</button></p>
      <template v-else-if="selectedDownline">
        <div class="agent-downline-balance-grid"><article><small>金币可用 / 冻结</small><strong>{{ selectedDownline.downline.coinAvailable }} / {{ selectedDownline.downline.coinFrozen }}</strong></article><article><small>余额可用 / 冻结</small><strong>{{ cny(selectedDownline.downline.cnyAvailableFen) }} / {{ cny(selectedDownline.downline.cnyFrozenFen) }}</strong></article><article><small>未完成流水</small><strong>{{ selectedDownline.turnoverRemainingCoins }} 金币</strong></article><article><small>该用户作为上级的返点模式</small><strong>{{ selectedDownline.userRewardType === 1 ? '充值返点' : '客损返点' }}</strong></article></div>
        <section class="agent-downline-detail-section"><h3>邀请上级链</h3><ol><li v-for="parent in selectedDownline.referralChain" :key="parent.level"><span>第 {{ parent.level }} 级 · {{ parent.displayName }}</span></li></ol></section>
        <section class="agent-downline-detail-section"><h3>近期资产、订单与牌局记录</h3><div v-if="!selectedDownline.recentActivities.length" class="agent-operations-empty">暂无业务记录</div><ul v-else class="agent-downline-activities"><li v-for="activity in selectedDownline.recentActivities" :key="activity.activityId"><span><strong>{{ activity.summary }}</strong><small>{{ new Date(activity.occurredAt).toLocaleString('zh-CN') }}</small></span><b>{{ activityAmount(activity) }}</b></li></ul></section>
        <p class="agent-downline-secret-note">认证凭证、TOTP 密钥、恢复码及收款密钥不会向代理展示。</p>
      </template>
    </section>
  </div>
  <div v-if="announcementDialog" class="agent-downline-scrim agent-downline-purpose-scrim" @click.self="announcementDialog = null" @keydown.esc="announcementDialog = null">
    <section class="agent-downline-purpose-dialog agent-announcement-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-announcement-dialog-title">
      <h2 id="agent-announcement-dialog-title">{{ announcementDialog === 'create' ? '新建域内公告草稿' : announcementDialog === 'publish' ? '预览并发布公告' : '撤回域内公告' }}</h2>
      <template v-if="announcementDialog === 'create'"><label>标题<input v-model="announcementTitle" maxlength="60" required minlength="2" placeholder="例如：本域游戏规则提醒"></label><label>公告正文<textarea v-model="announcementBody" maxlength="240" minlength="4" required rows="4" placeholder="仅支持纯文字；不要填写概率、赔率、派奖承诺或外部链接。"></textarea></label><p v-if="announcementTitle || announcementBody" class="agent-announcement-live-preview"><strong>玩家端文字预览</strong><b>{{ announcementTitle || '公告标题' }}</b><span>{{ announcementBody || '公告正文会显示在这里。' }}</span></p></template>
      <template v-else-if="announcementDialog === 'publish' && announcementDialogTarget"><p class="agent-announcement-live-preview"><strong>本代理域公告预览</strong><b>{{ announcementDialogTarget.title }}</b><span>{{ announcementDialogTarget.body }}</span></p><label>开始时间<select v-model.number="announcementStartDelay"><option :value="0">立即展示</option><option :value="1">1 小时后展示</option></select></label><label>有效时长<select v-model.number="announcementDurationHours"><option :value="1">1 小时</option><option :value="6">6 小时</option><option :value="24">24 小时</option><option :value="72">72 小时</option></select></label></template>
      <template v-else><p>撤回后，本机公告状态会变为“已撤回”；此演练不会影响玩家端或服务端公告。</p><p class="agent-announcement-live-preview"><b>{{ announcementDialogTarget?.title }}</b><span>{{ announcementDialogTarget?.body }}</span></p></template>
      <label>{{ announcementDialog === 'create' ? '创建原因' : announcementDialog === 'publish' ? '发布原因' : '撤回原因' }}<textarea v-model="announcementReason" maxlength="240" minlength="3" required rows="2" placeholder="至少 3 个字符，将写入不可变代理审计"></textarea></label>
      <p v-if="announcementDialog === 'create' && !isSafeAgentAnnouncementText(announcementTitle, announcementBody) && (announcementTitle || announcementBody)" class="agent-downline-error" role="alert">公告不能包含 HTML、网址或概率/赔率/派奖承诺。</p>
      <footer><button type="button" @click="announcementDialog = null">取消</button><button class="agent-downline-purpose-submit" type="button" :disabled="announcementBusy || announcementReason.trim().length < 3 || (announcementDialog === 'create' && (!isSafeAgentAnnouncementText(announcementTitle, announcementBody) || announcementTitle.trim().length < 2 || announcementBody.trim().length < 4))" @click="submitAgentAnnouncement">{{ announcementBusy ? '正在保存…' : announcementDialog === 'create' ? '保存为草稿' : announcementDialog === 'publish' ? '确认本机演练发布' : '确认本机演练撤回' }}</button></footer>
    </section>
  </div>
</template>
