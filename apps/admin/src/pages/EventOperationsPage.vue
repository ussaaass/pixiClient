<script setup lang="ts">
import { ElSelect } from 'element-plus';
import AdminSelectOption from '../components/AdminSelectOption.vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  AnnouncementTemplateEventType,
  AnnouncementTemplateSource,
  type AnnouncementTemplateChangeDto,
  type AnnouncementTemplateDto,
} from '@gameing/admin-contracts/announcement-template';
import PageHelpOverlay from '../components/PageHelpOverlay.vue';
import { localAnnouncementTemplateApplication } from '../platform/announcement-templates/composition';
import { renderAnnouncementTemplate } from '../platform/announcement-templates/announcement-template-domain';
import {
  EventActorType, EventRuleStatus, EventRuleType, PlatformEventLocalStatus,
  type AdminEventDeliveryDto, type AdminEventRuleDto, type AdminPlatformEventDto,
} from '@gameing/contracts/event-operations';
import { localAdminEventOperations } from '../platform/event-operations/composition';

const route = useRoute();
const router = useRouter();
const sections = [
  { path: '/admin/events/rules', title: '事件规则', icon: '◇' },
  { path: '/admin/events/instances', title: '活动实例', icon: '◉' },
  { path: '/admin/announcements', title: '公告模板', icon: '▤' },
  { path: '/admin/announcements/delivery', title: '广播投递', icon: '↗' },
];
const fallbackSection = sections[0]!;
const page = computed(() => {
  const path = route.path === '/admin/events' ? '/admin/events/rules' : route.path;
  return sections.find((section) => section.path === path) ?? fallbackSection;
});
const isRulePage = computed(() => page.value.path === '/admin/events/rules');
const isInstancePage = computed(() => page.value.path === '/admin/events/instances');
const isTemplatePage = computed(() => page.value.path === '/admin/announcements');
const isDeliveryPage = computed(() => page.value.path === '/admin/announcements/delivery');
const eventRows = ref<AdminPlatformEventDto[]>([]);
const eventRuleRows = ref<AdminEventRuleDto[]>([]);
const eventDeliveryRows = ref<AdminEventDeliveryDto[]>([]);
const eventAuditRows = ref<Awaited<ReturnType<typeof localAdminEventOperations.listAudits>>>([]);
const eventLoading = ref(false);
const eventError = ref('');
const eventFeedback = ref('');
const eventGameFilter = ref('');
const eventTypeFilter = ref('');
const eventStatusFilter = ref('');
const isRuleEditorOpen = ref(false);
const editingRuleId = ref<string | null>(null);
const ruleEventType = ref<(typeof EventRuleType)[keyof typeof EventRuleType]>(EventRuleType.PLAYER_BURST);
const ruleGameKey = ref('shisanshui');
const ruleDifficultyKey = ref('bronze');
const ruleThreshold = ref(500);
const ruleDurationMinutes = ref(15);
const ruleActorTypes = ref<Array<(typeof EventActorType)[keyof typeof EventActorType]>>([EventActorType.USER, EventActorType.BOT]);
const ruleStatus = ref<(typeof EventRuleStatus)[keyof typeof EventRuleStatus]>(EventRuleStatus.PAUSED);
const ruleReason = ref('');
const ruleRequestKey = ref('');
const triggerRuleId = ref('');
const triggerValue = ref(500);
const triggerActorType = ref<(typeof EventActorType)[keyof typeof EventActorType]>(EventActorType.USER);
const triggerActorLabel = ref('陈先生');
const triggerCannotContinue = ref(true);
const triggerReason = ref('');
const triggerRequestKey = ref('');
const isTriggerDialogOpen = ref(false);
const cancelEventId = ref('');
const cancelReason = ref('');
const cancelRequestKey = ref('');
const isCancelDialogOpen = ref(false);
const deliveryEventId = ref('');
const deliveryAudience = ref<'GLOBAL_HALL' | 'GAME_HALL' | 'DIFFICULTY_HALL'>('DIFFICULTY_HALL');
const deliveryReason = ref('');
const deliveryRequestKey = ref('');
const isDeliveryDialogOpen = ref(false);
const filteredEventRules = computed(() => eventRuleRows.value.filter((rule) => (!eventGameFilter.value || rule.gameKey === eventGameFilter.value)
  && (!eventTypeFilter.value || rule.eventType === eventTypeFilter.value)
  && (!eventStatusFilter.value || rule.status === eventStatusFilter.value)));
const filteredEvents = computed(() => eventRows.value.filter((event) => (!eventGameFilter.value || event.gameKey === eventGameFilter.value)
  && (!eventStatusFilter.value || event.status === eventStatusFilter.value)));
const filteredDeliveries = computed(() => eventDeliveryRows.value.filter((delivery) => !deliveryEventId.value || delivery.eventId === deliveryEventId.value));
const eligibleRules = computed(() => eventRuleRows.value.filter((rule) => rule.status === EventRuleStatus.ACTIVE));
const activeEvents = computed(() => eventRows.value.filter((event) => event.status === PlatformEventLocalStatus.ACTIVE));
const templateRows = ref<AnnouncementTemplateDto[]>([]);
const templateHistory = ref<AnnouncementTemplateChangeDto[]>([]);
const templateLoading = ref(false);
const templateError = ref('');
const templateFeedback = ref('');
const templateKeyword = ref('');
const templateEventFilter = ref('');
const editingTemplateId = ref<string | null>(null);
const templateEventType = ref<(typeof AnnouncementTemplateEventType)[keyof typeof AnnouncementTemplateEventType]>(AnnouncementTemplateEventType.PLAYER_BURST);
const titlePattern = ref('');
const messagePattern = ref('');
const saveReason = ref('');
const isTemplateEditorOpen = ref(false);
const templateSaving = ref(false);
const templateRequestKey = ref('');
const templatePreview = computed(() => renderAnnouncementTemplate({ titlePattern: titlePattern.value, messagePattern: messagePattern.value }, {
  actorLabel: '陈先生', gameName: '跳高高', difficultyName: '进阶厅', roundCount: '8',
}));
const filteredTemplates = computed(() => templateRows.value.filter((item) => (!templateEventFilter.value || item.eventType === templateEventFilter.value)
  && (!templateKeyword.value || `${item.eventType} ${item.titlePattern} ${item.messagePattern}`.toLocaleLowerCase().includes(templateKeyword.value.trim().toLocaleLowerCase()))));

async function loadTemplates() {
  templateLoading.value = true;
  templateError.value = '';
  const result = await localAnnouncementTemplateApplication.list({
    ...(templateEventFilter.value ? { eventType: templateEventFilter.value } : {}),
    ...(templateKeyword.value.trim() ? { keyword: templateKeyword.value.trim() } : {}),
  });
  templateLoading.value = false;
  if (!result.ok) { templateError.value = '读取本机公告草稿失败，请重试。'; return; }
  templateRows.value = result.value;
}

async function loadEventWorkspace() {
  eventLoading.value = true;
  eventError.value = '';
  try {
    const [rules, events, deliveries, audits] = await Promise.all([
      localAdminEventOperations.listRules(), localAdminEventOperations.listEvents(),
      localAdminEventOperations.listDeliveries(), localAdminEventOperations.listAudits(),
    ]);
    eventRuleRows.value = rules; eventRows.value = events; eventDeliveryRows.value = deliveries; eventAuditRows.value = audits;
  } catch { eventError.value = '读取本机事件工作区失败，可重试；既有记录未清除。'; }
  finally { eventLoading.value = false; }
}

function startNewRule() {
  editingRuleId.value = null; ruleEventType.value = EventRuleType.PLAYER_BURST;
  ruleGameKey.value = 'shisanshui'; ruleDifficultyKey.value = 'bronze'; ruleThreshold.value = 500;
  ruleDurationMinutes.value = 15; ruleActorTypes.value = [EventActorType.USER, EventActorType.BOT];
  ruleStatus.value = EventRuleStatus.PAUSED; ruleReason.value = ''; ruleRequestKey.value = crypto.randomUUID(); eventError.value = '';
  isRuleEditorOpen.value = true;
}

function editRule(rule: AdminEventRuleDto) {
  editingRuleId.value = rule.ruleId; ruleEventType.value = rule.eventType; ruleGameKey.value = rule.gameKey;
  ruleDifficultyKey.value = rule.difficultyKey; ruleThreshold.value = rule.threshold; ruleDurationMinutes.value = rule.durationMinutes;
  ruleActorTypes.value = [...rule.allowedActorTypes]; ruleStatus.value = rule.status; ruleReason.value = '';
  ruleRequestKey.value = crypto.randomUUID(); eventError.value = ''; isRuleEditorOpen.value = true;
}

async function saveRule() {
  const result = await localAdminEventOperations.saveRule({
    ruleId: editingRuleId.value, eventType: ruleEventType.value, gameKey: ruleGameKey.value.trim(), difficultyKey: ruleDifficultyKey.value.trim(),
    threshold: ruleThreshold.value, durationMinutes: ruleDurationMinutes.value, allowedActorTypes: ruleActorTypes.value,
    status: ruleStatus.value, reason: ruleReason.value, requestKey: ruleRequestKey.value,
  });
  if (!result.ok) { eventError.value = eventFailure(result.code); return; }
  eventFeedback.value = '规则已保存到本机演练，并追加审计；不会改变生产赔率或触发真实广播。';
  isRuleEditorOpen.value = false; await loadEventWorkspace();
}

async function startTrigger(rule?: AdminEventRuleDto) {
  triggerRuleId.value = rule?.ruleId ?? String(route.query.ruleId ?? eligibleRules.value[0]?.ruleId ?? '');
  const selected = eventRuleRows.value.find((item) => item.ruleId === triggerRuleId.value);
  triggerValue.value = selected?.threshold ?? 1; triggerActorType.value = selected?.allowedActorTypes[0] ?? EventActorType.USER;
  triggerActorLabel.value = triggerActorType.value === EventActorType.USER ? '陈先生' : triggerActorType.value === EventActorType.BOT ? '机器人01' : '系统事件';
  triggerCannotContinue.value = selected?.eventType === EventRuleType.PLAYER_BURST; triggerReason.value = ''; triggerRequestKey.value = crypto.randomUUID(); eventError.value = '';
  if (!isInstancePage.value) await router.push({ path: '/admin/events/instances', query: { ruleId: triggerRuleId.value } });
  isTriggerDialogOpen.value = true;
}

function updateTriggerRule() {
  const selected = eventRuleRows.value.find((item) => item.ruleId === triggerRuleId.value);
  if (!selected) return;
  triggerValue.value = selected.threshold;
  triggerActorType.value = selected.allowedActorTypes[0]!;
  triggerActorLabel.value = triggerActorType.value === EventActorType.USER ? '陈先生' : triggerActorType.value === EventActorType.BOT ? '机器人01' : '系统事件';
  triggerCannotContinue.value = selected.eventType === EventRuleType.PLAYER_BURST;
}

async function submitTrigger() {
  const defaultActorLabel = triggerActorType.value === EventActorType.USER ? '陈先生' : triggerActorType.value === EventActorType.BOT ? '机器人01' : '系统事件';
  const request = {
    ruleId: triggerRuleId.value, eventValue: triggerValue.value, actorType: triggerActorType.value,
    actorLabel: triggerActorLabel.value || defaultActorLabel, cannotContinue: triggerCannotContinue.value,
    reason: triggerReason.value, requestKey: triggerRequestKey.value,
  };
  const result = await localAdminEventOperations.simulateTrigger(request);
  if (!result.ok) { eventError.value = eventFailure(result.code); return; }
  eventFeedback.value = `本地活动实例 ${result.value.eventId.slice(0, 8)} 已创建；未产生实际概率、派奖或 Socket 广播。`;
  isTriggerDialogOpen.value = false; await router.push('/admin/events/instances'); await loadEventWorkspace();
}

function startCancel(event: AdminPlatformEventDto) {
  cancelEventId.value = event.eventId; cancelReason.value = ''; cancelRequestKey.value = crypto.randomUUID(); eventError.value = ''; isCancelDialogOpen.value = true;
}

async function submitCancel() {
  const result = await localAdminEventOperations.cancelEvent({ eventId: cancelEventId.value, reason: cancelReason.value, requestKey: cancelRequestKey.value });
  if (!result.ok) { eventError.value = eventFailure(result.code); return; }
  eventFeedback.value = '本机演练实例已停止，历史状态与审计均已保留。'; isCancelDialogOpen.value = false; await loadEventWorkspace();
}

async function startDelivery(event?: AdminPlatformEventDto) {
  deliveryEventId.value = event?.eventId ?? eventRows.value.find((item) => item.status === PlatformEventLocalStatus.ACTIVE)?.eventId ?? '';
  deliveryAudience.value = 'DIFFICULTY_HALL'; deliveryReason.value = ''; deliveryRequestKey.value = crypto.randomUUID(); eventError.value = '';
  if (!isDeliveryPage.value) await router.push('/admin/announcements/delivery');
  isDeliveryDialogOpen.value = true;
}

async function submitDeliveryPreview() {
  const result = await localAdminEventOperations.previewDelivery({ eventId: deliveryEventId.value, audience: deliveryAudience.value, reason: deliveryReason.value, requestKey: deliveryRequestKey.value });
  if (!result.ok) { eventError.value = eventFailure(result.code); return; }
  eventFeedback.value = '安全公告预览已加入本机投递列表；该记录不是已发送或已送达。'; isDeliveryDialogOpen.value = false; await router.push('/admin/announcements/delivery'); await loadEventWorkspace();
}

function eventFailure(code: string): string {
  const labels: Record<string, string> = {
    INVALID_REQUEST: '输入未通过校验，请检查字段和至少 3 个字的原因。', NOT_FOUND: '记录不存在，请刷新后重试。',
    RULE_DISABLED: '此规则已暂停，启用后才可模拟触发。', TRIGGER_NOT_MET: '输入值未达到规则阈值。',
    PLAYER_CAN_CONTINUE: '燃尽事件要求玩家本轮后无法继续参与。', ACTOR_NOT_ALLOWED: '规则不允许所选来源类型。',
    EVENT_NOT_ACTIVE: '活动实例已停止或过期，不能继续操作。', REQUEST_KEY_REUSED: '操作号已用于不同请求，请重新开始操作。',
    WRITE_FAILED: '本机写入未确认；保留相同操作号后可安全重试。',
  };
  return labels[code] ?? `操作未完成（${code}），请刷新后重试。`;
}

function startNewTemplate() {
  editingTemplateId.value = null;
  templateRequestKey.value = globalThis.crypto.randomUUID();
  templateEventType.value = AnnouncementTemplateEventType.PLAYER_BURST;
  titlePattern.value = '{{actorLabel}}在{{gameName}}燃尽了';
  messagePattern.value = '{{difficultyName}}的活动效果已开启，详情以服务端快照为准。';
  saveReason.value = '';
  templateHistory.value = [];
  templateFeedback.value = '';
  templateError.value = '';
  isTemplateEditorOpen.value = true;
}

async function editTemplate(template: AnnouncementTemplateDto) {
  editingTemplateId.value = template.templateId;
  templateRequestKey.value = globalThis.crypto.randomUUID();
  templateEventType.value = template.eventType;
  titlePattern.value = template.titlePattern;
  messagePattern.value = template.messagePattern;
  saveReason.value = '';
  templateFeedback.value = '';
  templateError.value = '';
  isTemplateEditorOpen.value = true;
  const result = await localAnnouncementTemplateApplication.listChanges(template.templateId);
  if (result.ok) templateHistory.value = result.value;
  else templateError.value = '读取变更历史失败；草稿仍可继续编辑，可关闭后重试历史读取。';
}

async function saveTemplate() {
  templateSaving.value = true;
  templateError.value = '';
  templateFeedback.value = '';
  const result = await localAnnouncementTemplateApplication.save({
    templateId: editingTemplateId.value,
    eventType: templateEventType.value,
    titlePattern: titlePattern.value,
    messagePattern: messagePattern.value,
    reason: saveReason.value,
    requestKey: templateRequestKey.value,
  });
  templateSaving.value = false;
  if (!result.ok) {
    if (result.code === 'INVALID_REQUEST') {
      templateError.value = '内容不符合模板规则：请只使用本事件允许的变量，不要输入 HTML 或链接，并填写至少 3 个字的变更原因。';
    } else if (result.code === 'REQUEST_KEY_REUSED') {
      templateRequestKey.value = globalThis.crypto.randomUUID();
      templateError.value = '操作号已用于不同内容，已生成新的操作号；确认当前内容后可以再次保存。';
    } else {
      templateError.value = '写入未确认；再次点击保存会用相同操作号安全重试，不会重复追加记录。';
    }
    return;
  }
  editingTemplateId.value = result.value.templateId;
  templateRequestKey.value = globalThis.crypto.randomUUID();
  templateEventType.value = result.value.eventType;
  templateFeedback.value = '已保存到本机演练草稿及变更历史；尚未发布或投递。';
  const history = await localAnnouncementTemplateApplication.listChanges(result.value.templateId);
  if (history.ok) templateHistory.value = history.value;
  await loadTemplates();
}

watch([templateKeyword, templateEventFilter, isTemplatePage], () => { if (isTemplatePage.value) void loadTemplates(); });
watch([isRulePage, isInstancePage, isDeliveryPage], () => {
  if (isRulePage.value || isInstancePage.value || isDeliveryPage.value) void loadEventWorkspace();
});
onMounted(() => {
  if (isTemplatePage.value) void loadTemplates();
  if (isRulePage.value || isInstancePage.value || isDeliveryPage.value) void loadEventWorkspace();
});
const ruleHelp = [
  { heading: '触发条件', body: '记录来源游戏与难度、触发者类型、阈值和主体排除规则。' },
  { heading: '效果类型', body: '区分播报、奖池和经审核的配置效果；纯播报必须明确标记“仅事件播报”。' },
  { heading: '受众范围', body: '平台或代理域范围由服务端授权并隔离 Socket 房间，客户端不能指定域加入。' },
] as const;
</script>

<template>
  <section class="event-operations-page">
    <div class="event-heading">
      <div><p class="eyebrow">活动与广播</p><h1>{{ page.title }}</h1><p>事件由服务端规则触发；公告展示真实范围和效果，不由客户端拼装中奖或概率承诺。</p></div>
    </div>

    <nav class="event-section-tabs" aria-label="事件与公告管理">
      <RouterLink v-for="section in sections" :key="section.path" :to="section.path" :class="{ active: page.path === section.path }">
        <span aria-hidden="true">{{ section.icon }}</span>{{ section.title }}
      </RouterLink>
    </nav>

    <template v-if="isRulePage">
      <section class="event-query-panel">
        <div class="event-panel-heading"><div><h2>规则目录</h2><p>仅配置已登记事件类型、游戏/难度阈值与运行时长；本机闭环仅产生广播预览。</p></div><div class="event-heading-actions"><PageHelpOverlay title="事件规则设计要求" trigger-label="查看事件规则设计说明" :sections="ruleHelp" /><button type="button" @click="startNewRule">＋ 新建规则</button></div></div>
        <p v-if="eventError" class="event-template-feedback error" role="alert">{{ eventError }}</p><p v-else-if="eventFeedback" class="event-template-feedback success" role="status">{{ eventFeedback }}</p>
        <div class="event-filter-grid">
          <label>来源游戏<input v-model="eventGameFilter" placeholder="全部游戏" maxlength="64"></label>
          <label>事件类型<el-select v-model="eventTypeFilter"><AdminSelectOption value="">全部事件</AdminSelectOption><AdminSelectOption :value="EventRuleType.PLAYER_BURST">玩家燃尽</AdminSelectOption><AdminSelectOption :value="EventRuleType.PLAYER_STREAK">连续局数</AdminSelectOption></el-select></label>
          <label>规则状态<el-select v-model="eventStatusFilter"><AdminSelectOption value="">全部状态</AdminSelectOption><AdminSelectOption :value="EventRuleStatus.ACTIVE">运行中</AdminSelectOption><AdminSelectOption :value="EventRuleStatus.PAUSED">已暂停</AdminSelectOption></el-select></label>
          <button type="button" @click="loadEventWorkspace">刷新规则</button>
        </div>
        <div v-if="eventLoading" class="event-empty-state" role="status"><strong>正在读取本机事件规则…</strong></div>
        <div v-else-if="filteredEventRules.length" class="event-rule-list">
          <article v-for="rule in filteredEventRules" :key="rule.ruleId" class="event-rule-card">
            <div class="event-rule-card-main"><div><span>{{ rule.eventType === EventRuleType.PLAYER_BURST ? '玩家燃尽' : '连续局数' }} · {{ rule.status === EventRuleStatus.ACTIVE ? '运行中' : '已暂停' }}</span><strong>{{ rule.gameKey }} / {{ rule.difficultyKey }}</strong></div><p>{{ rule.eventType === EventRuleType.PLAYER_BURST ? `燃尽阈值 ${rule.threshold}，要求无法继续参与` : `事件来源报告连续局数达到 ${rule.threshold}` }} · {{ rule.durationMinutes }} 分钟 · 仅广播</p><small>允许来源：{{ rule.allowedActorTypes.join(' / ') }} · LOCAL_DEMO</small></div>
            <div class="event-rule-card-actions"><button type="button" @click="editRule(rule)">编辑</button><button type="button" :disabled="rule.status !== EventRuleStatus.ACTIVE" @click="startTrigger(rule)">本机模拟触发</button></div>
          </article>
        </div>
        <div v-else class="event-empty-state"><span>◇</span><strong>{{ eventRuleRows.length ? '没有匹配的规则' : '还没有事件规则' }}</strong><p>{{ eventRuleRows.length ? '清除筛选条件或调整事件类型后重试。' : '先登记并启用一个规则，再到活动实例页输入合成事件走通流程。此演练只生成本地广播预览。' }}</p><button v-if="!eventRuleRows.length" type="button" @click="startNewRule">创建第一条规则</button></div>
        <div v-if="isRuleEditorOpen" class="event-local-dialog-backdrop" @click.self="isRuleEditorOpen=false"><section class="event-local-dialog" role="dialog" aria-modal="true" aria-labelledby="event-rule-dialog-title"><div class="event-panel-heading"><div><h3 id="event-rule-dialog-title">{{ editingRuleId ? '编辑事件规则' : '新建事件规则' }}</h3><p>只保存本地候选，profile 当前固定为“仅广播”。</p></div><button type="button" @click="isRuleEditorOpen=false">关闭</button></div><div class="event-template-form"><label>事件类型<el-select v-model="ruleEventType"><AdminSelectOption :value="EventRuleType.PLAYER_BURST">玩家燃尽：本局无法继续且超过阈值</AdminSelectOption><AdminSelectOption :value="EventRuleType.PLAYER_STREAK">连续局数：由游戏模块上报连续局数，不推断输赢</AdminSelectOption></el-select></label><label>游戏 Key<input v-model="ruleGameKey" maxlength="64" placeholder="例如 shisanshui"></label><label>难度 Key<input v-model="ruleDifficultyKey" maxlength="64" placeholder="例如 bronze"></label><label>{{ ruleEventType === EventRuleType.PLAYER_BURST ? '燃尽金额阈值（本机演练单位）' : '连续局数阈值' }}<input v-model.number="ruleThreshold" type="number" min="1" max="100000"></label><label>实例持续时间（分钟）<input v-model.number="ruleDurationMinutes" type="number" min="1" max="15"></label><label>允许事件来源<el-select v-model="ruleActorTypes" multiple><AdminSelectOption :value="EventActorType.USER">真实用户事件</AdminSelectOption><AdminSelectOption :value="EventActorType.BOT">机器人事件</AdminSelectOption><AdminSelectOption :value="EventActorType.SYSTEM">系统事件</AdminSelectOption></el-select></label><label>规则状态<el-select v-model="ruleStatus"><AdminSelectOption :value="EventRuleStatus.PAUSED">先暂停</AdminSelectOption><AdminSelectOption :value="EventRuleStatus.ACTIVE">保存并启用本机规则</AdminSelectOption></el-select></label><label>变更原因<input v-model="ruleReason" maxlength="240" placeholder="至少 3 个字"></label></div><p class="event-action-boundary">概率和派奖效果必须引用已审核的游戏数学 profile；本机演练不支持修改赔率、奖池或资产。</p><div class="event-dialog-actions"><button type="button" @click="isRuleEditorOpen=false">取消</button><button type="button" @click="saveRule">保存本地规则</button></div></section></div>
      </section>
    </template>

    <template v-else-if="isInstancePage">
      <section class="event-query-panel">
        <div class="event-panel-heading"><div><h2>活动实例</h2><p>查看规则触发结果与本地实例生命周期。演练实例没有真实席位、奖池或效果。</p></div><button type="button" :disabled="eligibleRules.length === 0" @click="startTrigger()">＋ 模拟事件输入</button></div>
        <p v-if="eventError" class="event-template-feedback error" role="alert">{{ eventError }}</p><p v-else-if="eventFeedback" class="event-template-feedback success" role="status">{{ eventFeedback }}</p>
        <div class="event-filter-grid event-instance-filters">
          <label>游戏 Key<input v-model="eventGameFilter" placeholder="全部游戏" maxlength="64"></label>
          <label>实例状态<el-select v-model="eventStatusFilter"><AdminSelectOption value="">全部状态</AdminSelectOption><AdminSelectOption :value="PlatformEventLocalStatus.ACTIVE">运行中</AdminSelectOption><AdminSelectOption :value="PlatformEventLocalStatus.CANCELLED">已取消</AdminSelectOption><AdminSelectOption :value="PlatformEventLocalStatus.EXPIRED">已过期</AdminSelectOption></el-select></label>
          <button type="button" @click="loadEventWorkspace">刷新实例</button>
        </div>
        <div v-if="eventLoading" class="event-empty-state" role="status"><strong>正在读取本机活动实例…</strong></div>
        <div v-else-if="filteredEvents.length" class="event-instance-list"><article v-for="event in filteredEvents" :key="event.eventId" class="event-instance-card"><div><span>{{ event.eventType === EventRuleType.PLAYER_BURST ? '玩家燃尽' : '连续局数' }} · {{ event.status }}</span><strong>{{ event.publicActorLabel }} · {{ event.gameKey }} / {{ event.difficultyKey }}</strong><p>{{ event.actorType }} · 触发值 {{ event.metricValue }} · {{ event.startsAt }} 至 {{ event.expiresAt }}</p><small>实例 {{ event.eventId }} · 状态版本 {{ event.stateVersion }} · 仅广播 · LOCAL_DEMO</small></div><div class="event-instance-actions"><button type="button" :disabled="event.status !== PlatformEventLocalStatus.ACTIVE" @click="startDelivery(event)">公告预览</button><button type="button" :disabled="event.status !== PlatformEventLocalStatus.ACTIVE" @click="startCancel(event)">停止实例</button></div></article></div>
        <div v-else class="event-empty-state"><span>◉</span><strong>{{ eventRows.length ? '没有匹配的活动实例' : '暂无活动实例' }}</strong><p>{{ eligibleRules.length ? '可以使用“模拟事件输入”生成一条 LOCAL_DEMO 事件；它不会连接玩家账户或影响游戏概率。' : '先到事件规则页建立并启用本地规则，随后回来输入一条合成事件。' }}</p><RouterLink v-if="eligibleRules.length === 0" to="/admin/events/rules">前往事件规则</RouterLink><button v-else type="button" @click="startTrigger()">模拟一条本地事件</button></div>
        <div v-if="isTriggerDialogOpen" class="event-local-dialog-backdrop" @click.self="isTriggerDialogOpen=false"><section class="event-local-dialog" role="dialog" aria-modal="true" aria-labelledby="event-trigger-dialog-title"><div class="event-panel-heading"><div><h3 id="event-trigger-dialog-title">模拟事件输入</h3><p>合成输入不会伪装成真实用户事件或写入游戏账本。</p></div><button type="button" @click="isTriggerDialogOpen=false">关闭</button></div><div class="event-template-form"><label>启用规则<el-select v-model="triggerRuleId" @change="updateTriggerRule"><AdminSelectOption v-for="rule in eligibleRules" :key="rule.ruleId" :value="rule.ruleId">{{ rule.gameKey }}/{{ rule.difficultyKey }} · {{ rule.eventType === EventRuleType.PLAYER_BURST ? '燃尽' : '连续局数' }} · 阈值 {{ rule.threshold }}</AdminSelectOption></el-select></label><label>{{ eventRuleRows.find(rule=>rule.ruleId===triggerRuleId)?.eventType === EventRuleType.PLAYER_BURST ? '累计损失值' : '连续局数' }}<input v-model.number="triggerValue" type="number" min="1" max="100000"></label><label>来源类型<el-select v-model="triggerActorType"><AdminSelectOption v-for="actor in eventRuleRows.find(rule=>rule.ruleId===triggerRuleId)?.allowedActorTypes ?? []" :key="actor" :value="actor">{{ actor }}</AdminSelectOption></el-select></label><label>安全展示名<el-select v-model="triggerActorLabel"><AdminSelectOption v-if="triggerActorType===EventActorType.USER" value="陈先生">陈先生</AdminSelectOption><AdminSelectOption v-if="triggerActorType===EventActorType.USER" value="林女士">林女士</AdminSelectOption><AdminSelectOption v-if="triggerActorType===EventActorType.BOT" value="机器人01">机器人01</AdminSelectOption><AdminSelectOption v-if="triggerActorType===EventActorType.BOT" value="机器人02">机器人02</AdminSelectOption><AdminSelectOption v-if="triggerActorType===EventActorType.SYSTEM" value="系统事件">系统事件</AdminSelectOption></el-select></label><label v-if="eventRuleRows.find(rule=>rule.ruleId===triggerRuleId)?.eventType===EventRuleType.PLAYER_BURST" class="event-checkbox-label"><input v-model="triggerCannotContinue" type="checkbox">本局结束后无法继续参与</label><label>演练原因<input v-model="triggerReason" maxlength="240" placeholder="至少 3 个字"></label></div><p class="event-action-boundary">燃尽事件必须满足“超过该难度阈值且无法继续参与”；连续局数事件由具体游戏 handler 定义，不在平台层判断胜负。</p><div class="event-dialog-actions"><button type="button" @click="isTriggerDialogOpen=false">取消</button><button type="button" :disabled="!triggerRuleId" @click="submitTrigger">创建本机活动实例</button></div></section></div>
        <div v-if="isCancelDialogOpen" class="event-local-dialog-backdrop" @click.self="isCancelDialogOpen=false"><section class="event-local-dialog" role="dialog" aria-modal="true" aria-labelledby="event-cancel-dialog-title"><h3 id="event-cancel-dialog-title">停止本机活动实例</h3><p>停止后保留实例历史与操作审计。</p><label>停止原因<input v-model="cancelReason" maxlength="240" placeholder="至少 3 个字"></label><div class="event-dialog-actions"><button type="button" @click="isCancelDialogOpen=false">返回</button><button type="button" @click="submitCancel">确认停止</button></div></section></div>
      </section>
    </template>

    <template v-else-if="isTemplatePage">
      <section class="event-query-panel">
        <div class="event-panel-heading"><div><h2>安全公告模板</h2><p>只允许已登记变量与纯文本模板，不执行 HTML 或脚本。</p></div><button type="button" @click="startNewTemplate">＋ 新建草稿</button></div>
        <div class="event-filter-grid event-template-filters">
          <label>事件类型<el-select v-model="templateEventFilter"><AdminSelectOption value="">全部事件</AdminSelectOption><AdminSelectOption :value="AnnouncementTemplateEventType.PLAYER_BURST">玩家燃尽</AdminSelectOption><AdminSelectOption :value="AnnouncementTemplateEventType.PLAYER_STREAK">连龙播报</AdminSelectOption></el-select></label>
          <label>关键词<input v-model="templateKeyword" placeholder="搜索模板内容" maxlength="80"></label>
          <button type="button" @click="loadTemplates">查询草稿</button>
        </div>
        <p v-if="templateError" class="event-template-feedback error" role="alert">{{ templateError }}</p>
        <p v-else-if="templateFeedback" class="event-template-feedback success" role="status">{{ templateFeedback }}</p>
        <div v-if="templateLoading" class="event-empty-state" role="status"><strong>正在读取本机草稿…</strong></div>
        <div v-else-if="filteredTemplates.length" class="event-template-list">
          <article v-for="template in filteredTemplates" :key="template.templateId" class="event-template-card">
            <div><span>{{ template.eventType === AnnouncementTemplateEventType.PLAYER_BURST ? '玩家燃尽' : '连龙播报' }} · 本机草稿</span><strong>{{ template.titlePattern }}</strong><p>{{ template.messagePattern }}</p></div>
            <button type="button" @click="editTemplate(template)">编辑与历史</button>
          </article>
        </div>
        <div v-else class="event-empty-state"><span>▤</span><strong>还没有公告草稿</strong><p>新建草稿后可预览安全变量替换、保存并查看变更历史；这里不会发送玩家公告。</p></div>
        <section v-if="isTemplateEditorOpen" class="event-template-editor" aria-label="公告草稿编辑器">
          <div class="event-panel-heading"><div><h3>{{ editingTemplateId ? '编辑公告草稿' : '新建公告草稿' }}</h3><p>存储在当前浏览器 IndexedDB；不触发游戏效果，不对玩家发布。</p></div><button type="button" @click="isTemplateEditorOpen=false">关闭</button></div>
          <div class="event-template-form">
            <label>事件类型<el-select v-model="templateEventType"><AdminSelectOption :value="AnnouncementTemplateEventType.PLAYER_BURST">玩家燃尽（PLAYER_BURST）</AdminSelectOption><AdminSelectOption :value="AnnouncementTemplateEventType.PLAYER_STREAK">连龙播报（PLAYER_STREAK）</AdminSelectOption></el-select></label>
            <label>标题模板<input v-model="titlePattern" maxlength="80" placeholder="例如：{{actorLabel}}在{{gameName}}燃尽了"></label>
            <label>正文模板<textarea v-model="messagePattern" maxlength="240" rows="3" placeholder="使用白名单变量，例如 {{difficultyName}}"></textarea></label>
            <label>变更原因<input v-model="saveReason" maxlength="240" placeholder="至少 3 个字，写明变更理由"></label>
          </div>
          <div class="event-template-preview" aria-live="polite"><span>脱敏预览 · 不会发送</span><strong>{{ templatePreview.title }}</strong><p>{{ templatePreview.message }}</p></div>
          <div class="event-template-allowed-vars"><span>允许变量：</span><code v-if="templateEventType===AnnouncementTemplateEventType.PLAYER_BURST">&#123;&#123;actorLabel&#125;&#125; · &#123;&#123;gameName&#125;&#125; · &#123;&#123;difficultyName&#125;&#125;</code><code v-else>&#123;&#123;actorLabel&#125;&#125; · &#123;&#123;gameName&#125;&#125; · &#123;&#123;difficultyName&#125;&#125; · &#123;&#123;roundCount&#125;&#125;</code></div>
          <div v-if="templateHistory.length" class="event-template-history"><h4>不可变变更历史</h4><article v-for="entry in templateHistory" :key="entry.changeId"><time>{{ entry.createdAt }}</time><span>{{ entry.reason }}</span><small>{{ entry.previous ? '更新草稿' : '创建草稿' }} · {{ entry.source===AnnouncementTemplateSource.LOCAL_DEMO ? 'LOCAL_DEMO' : 'SERVER' }}</small></article></div>
          <button type="button" class="event-template-save" :disabled="templateSaving" @click="saveTemplate">{{ templateSaving ? '正在保存…' : '保存本机草稿' }}</button>
        </section>
        <div class="event-template-workspace">
          <div class="event-template-empty"><span>▤</span><strong>模板草稿不等于活动实例</strong><p>预览使用固定脱敏样例。启用仍需后端白名单、事件规则和代理域 scope 校验。</p></div>
          <aside class="event-template-checklist"><h3>发布前核对</h3><ul><li>变量来自白名单，不拼接任意用户输入</li><li>明确平台或代理域展示范围</li><li>概率与派奖描述对应已审核的实际效果</li><li>主体本人由服务端受众过滤排除</li></ul></aside>
        </div>
      </section>
    </template>

    <template v-else-if="isDeliveryPage">
      <section class="event-query-panel">
        <div class="event-panel-heading"><div><h2>广播投递预览</h2><p>将活动事实套用安全文案并检查展示范围；本地记录只表示“预览过”，不冒充已发送/已送达。</p></div><button type="button" :disabled="activeEvents.length===0" @click="startDelivery()">＋ 创建公告预览</button></div>
        <p v-if="eventError" class="event-template-feedback error" role="alert">{{ eventError }}</p><p v-else-if="eventFeedback" class="event-template-feedback success" role="status">{{ eventFeedback }}</p>
        <div class="event-filter-grid event-delivery-filters">
          <label>活动实例<el-select v-model="deliveryEventId"><AdminSelectOption value="">全部实例</AdminSelectOption><AdminSelectOption v-for="event in eventRows" :key="event.eventId" :value="event.eventId">{{ event.gameKey }}/{{ event.difficultyKey }} · {{ event.eventId.slice(0,8) }}</AdminSelectOption></el-select></label>
          <label>投递状态<el-select disabled><AdminSelectOption value="">仅本地预览</AdminSelectOption></el-select></label>
          <button type="button" @click="loadEventWorkspace">刷新预览</button>
        </div>
        <div v-if="eventLoading" class="event-empty-state" role="status"><strong>正在读取本机预览…</strong></div><div v-else-if="filteredDeliveries.length" class="event-delivery-list"><article v-for="delivery in filteredDeliveries" :key="delivery.deliveryId" class="event-delivery-card"><div><span>{{ delivery.status }} · {{ delivery.audience }}</span><strong>{{ delivery.previewText }}</strong><small>实例 {{ delivery.eventId }} · {{ delivery.previewedAt }} · LOCAL_DEMO</small></div></article></div><div v-else class="event-empty-state"><span>↗</span><strong>暂无公告预览</strong><p>{{ eventRows.length ? '从活动实例页或此页创建安全预览。只有 LOCAL_DEMO 活动事实才能继续。' : '先启用规则并生成本地活动实例；预览不会向玩家或 Socket 节点发送消息。' }}</p><RouterLink v-if="eventRows.length===0" to="/admin/events/instances">前往活动实例</RouterLink><button v-else type="button" @click="startDelivery()">创建公告预览</button></div>
        <ul v-if="eventAuditRows.length" class="event-audit-compact"><li v-for="audit in eventAuditRows.filter(item=>item.action==='DELIVERY_PREVIEWED').slice(0,8)" :key="audit.auditId"><time>{{ audit.createdAt }}</time><span>{{ audit.reason }}</span><small>{{ audit.source }}</small></li></ul>
        <div v-if="isDeliveryDialogOpen" class="event-local-dialog-backdrop" @click.self="isDeliveryDialogOpen=false"><section class="event-local-dialog" role="dialog" aria-modal="true" aria-labelledby="event-delivery-dialog-title"><div class="event-panel-heading"><div><h3 id="event-delivery-dialog-title">安全公告预览</h3><p>仅使用已脱敏主体和活动规则字段。</p></div><button type="button" @click="isDeliveryDialogOpen=false">关闭</button></div><div class="event-template-form"><label>有效活动实例<el-select v-model="deliveryEventId"><AdminSelectOption v-for="event in activeEvents" :key="event.eventId" :value="event.eventId">{{ event.gameKey }}/{{ event.difficultyKey }} · {{ event.publicActorLabel }}</AdminSelectOption></el-select></label><label>受众范围<el-select v-model="deliveryAudience"><AdminSelectOption value="GLOBAL_HALL">全局大厅</AdminSelectOption><AdminSelectOption value="GAME_HALL">对应游戏厅</AdminSelectOption><AdminSelectOption value="DIFFICULTY_HALL">对应难度厅</AdminSelectOption></el-select></label><label>预览原因<input v-model="deliveryReason" maxlength="240" placeholder="至少 3 个字"></label></div><p class="event-action-boundary">“确认预览”只在本机保存文案快照。真实公告模板、域授权、主体排除、Socket 投递和 HTTP 补拉仍由服务端实现。</p><div class="event-dialog-actions"><button type="button" @click="isDeliveryDialogOpen=false">取消</button><button type="button" :disabled="!deliveryEventId" @click="submitDeliveryPreview">生成本地预览</button></div></section></div>
      </section>
    </template>

    <section class="event-integrity-note"><strong>一致性与安全边界</strong><p>前端仅呈现服务器确认的范围、状态和实际效果。平台公告可跨域下发，代理公告仅在其授权域内可见；不得用静态席位、概率或派奖数字制造活动事实。</p></section>
  </section>
</template>
