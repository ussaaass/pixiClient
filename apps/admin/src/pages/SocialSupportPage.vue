<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { SocialContentStatus, SocialModerationAction, SocialModerationCaseStatus, SocialModerationResourceType, type SocialModerationActionCode, type SocialModerationAuditDto, type SocialModerationCaseDto } from '@gameing/contracts/social';
import { SupportCategoryType, SupportConversationStatus, SupportSenderType, type SupportDeskConversationDto, type SupportDeskDetailResponseDto, type SupportMessageDto } from '@gameing/contracts/support';
import PageHelpOverlay from '../components/PageHelpOverlay.vue';
import { localSupportDeskApplication } from '../platform/support-desk/composition';
import { localSocialModerationApplication } from '../platform/social-moderation/composition';

const route = useRoute();
const router = useRouter();
const sections = [
  { path: '/admin/community/topics', title: '社区话题' },
  { path: '/admin/community/moderation', title: '内容审核' },
  { path: '/admin/support/conversations', title: '客服队列' },
];
const page = computed(() => {
  if (route.path === '/admin/community') return sections[0]!;
  const found = sections.find((item) => item.path === route.path);
  if (found) return found;
  return { path: '/admin/support/conversations/:conversationId', title: '客服会话' };
});
const isTopics = computed(() => page.value.path === '/admin/community/topics');
const isModeration = computed(() => page.value.path === '/admin/community/moderation');
const isConversation = computed(() => route.meta.socialSupportPage === 'conversation');
const conversationId = computed(() => typeof route.params.conversationId === 'string' ? route.params.conversationId : '');
const supportItems = ref<SupportDeskConversationDto[]>([]);
const supportQueueTotal = ref(0);
const supportNextCursor = ref<string | null>(null);
const supportMessages = ref<SupportMessageDto[]>([]);
const supportKeyword = ref('');
const supportStatus = ref('');
const supportLoading = ref(false);
const supportError = ref('');
const detailLoading = ref(false);
const detailError = ref('');
const supportDetail = ref<SupportDeskDetailResponseDto | null>(null);
const supportReply = ref('');
const replyRequestKey = ref<string | null>(null);
const supportActionBusy = ref(false);
const supportActionRequestKeys = ref<Partial<Record<'claim' | 'resolve' | 'reopen', string>>>({});
const supportFeedback = ref('');
const supportActionError = ref('');
const moderationCases = ref<SocialModerationCaseDto[]>([]);
const moderationTotal = ref(0);
const moderationNextCursor = ref<string | null>(null);
const moderationKeyword = ref('');
const moderationResourceType = ref('');
const moderationCaseStatus = ref(String(SocialModerationCaseStatus.OPEN));
const moderationLoading = ref(false);
const moderationError = ref('');
const selectedModerationCase = ref<SocialModerationCaseDto | null>(null);
const moderationAction = ref<SocialModerationActionCode>(SocialModerationAction.HIDE);
const moderationReason = ref('');
const moderationRequestKey = ref<string | null>(null);
const moderationSaving = ref(false);
const moderationFeedback = ref('');
const moderationActionError = ref('');
const moderationAudits = ref<SocialModerationAuditDto[]>([]);
const moderationAuditError = ref('');
const moderationActionOptions = computed(() => {
  if (!selectedModerationCase.value) return [];
  const status = selectedModerationCase.value.contentStatus;
  return [
    ...(status === SocialContentStatus.PENDING_REVIEW ? [{ value: SocialModerationAction.APPROVE, label: '审核通过并发布' }] : []),
    ...(status !== SocialContentStatus.HIDDEN ? [{ value: SocialModerationAction.HIDE, label: '隐藏内容' }] : []),
    ...(status === SocialContentStatus.HIDDEN ? [{ value: SocialModerationAction.RESTORE, label: '恢复为公开' }] : []),
    ...(status !== SocialContentStatus.PENDING_REVIEW ? [{ value: SocialModerationAction.DISMISS, label: '驳回举报' }] : []),
  ];
});
const statusText = (status: number) => ({ 1: '等待客服', 2: '等待用户', 3: '已结束' }[status] ?? '未知状态');
const categoryText = (category: number) => ({ 1: '账号与安全', 2: '充值与支付', 3: '提现', 4: '游戏问题', 5: '其他' }[category] ?? '其他');
const messageTime = (value: string) => new Date(value).toLocaleString('zh-CN');
const moderationCaseStatusText = (status: number) => ({ 1: '待审核', 2: '已处理', 3: '已驳回' }[status] ?? '未知');
const moderationContentStatusText = (status: string) => ({ PUBLISHED: '公开', PENDING_REVIEW: '待审核', HIDDEN: '已隐藏' }[status] ?? status);
const moderationResourceText = (resourceType: string) => resourceType === SocialModerationResourceType.POST ? '帖子' : '回复';

async function loadModerationCases(cursor?: string) {
  moderationLoading.value = true;
  moderationError.value = '';
  moderationFeedback.value = '';
  const result = await localSocialModerationApplication.list({
    ...(moderationResourceType.value ? { resourceType: moderationResourceType.value } : {}),
    ...(moderationCaseStatus.value ? { caseStatus: Number(moderationCaseStatus.value) } : {}),
    ...(moderationKeyword.value.trim() ? { keyword: moderationKeyword.value.trim() } : {}),
    pageSize: 25,
    ...(cursor ? { cursor } : {}),
  });
  moderationLoading.value = false;
  if (!result.ok) { moderationError.value = result.code === 'READ_FAILED' ? '审核队列读取失败，请重试。' : '查询条件不合法，请调整筛选后重试。'; return; }
  moderationCases.value = cursor ? [...moderationCases.value, ...result.value.items] : result.value.items;
  moderationTotal.value = result.value.total;
  moderationNextCursor.value = result.value.nextCursor;
  if (selectedModerationCase.value) selectedModerationCase.value = moderationCases.value.find((item) => item.caseId === selectedModerationCase.value?.caseId) ?? null;
}

function selectModerationCase(item: SocialModerationCaseDto) {
  selectedModerationCase.value = item;
  moderationAction.value = item.contentStatus === SocialContentStatus.PENDING_REVIEW ? SocialModerationAction.APPROVE : item.contentStatus === SocialContentStatus.HIDDEN ? SocialModerationAction.RESTORE : SocialModerationAction.HIDE;
  moderationReason.value = '';
  moderationRequestKey.value = null;
  moderationFeedback.value = '';
  moderationActionError.value = '';
  moderationAudits.value = [];
  void loadModerationAudits(item.caseId);
}

async function loadModerationAudits(caseId: string) {
  moderationAuditError.value = '';
  const result = await localSocialModerationApplication.listAudits(caseId);
  if (!result.ok) { moderationAuditError.value = '该审核项的处置记录暂时无法读取。'; return; }
  moderationAudits.value = result.value;
}

async function decideModerationCase() {
  const item = selectedModerationCase.value;
  if (!item) return;
  moderationSaving.value = true;
  moderationActionError.value = '';
  moderationFeedback.value = '';
  moderationRequestKey.value ??= crypto.randomUUID();
  const result = await localSocialModerationApplication.decide(item.caseId, { action: moderationAction.value, reason: moderationReason.value, requestKey: moderationRequestKey.value });
  moderationSaving.value = false;
  if (!result.ok) {
    moderationActionError.value = ({ NOT_FOUND: '该审核项已不在当前授权范围，请刷新队列。', CASE_ALREADY_CLOSED: '该审核项已被处理，请刷新查看最新状态。', REQUEST_KEY_REUSED: '操作编号冲突，请重新提交。', INVALID_TRANSITION: '当前内容状态不能执行此处置，请刷新后重试。', WRITE_FAILED: '处置结果未知；再次提交将沿用相同操作编号。' } as Record<string, string>)[result.code] ?? '操作未完成，请检查原因并重试。';
    if (result.code === 'REQUEST_KEY_REUSED') moderationRequestKey.value = null;
    return;
  }
  moderationRequestKey.value = null;
  selectedModerationCase.value = result.value.item;
  moderationCases.value = moderationCases.value.map((candidate) => candidate.caseId === result.value.item.caseId ? result.value.item : candidate);
  await loadModerationCases();
  selectedModerationCase.value = result.value.item;
  moderationFeedback.value = `已记录“${moderationActionText(moderationAction.value)}”，审核编号 ${result.value.audit.auditId}。`;
  await loadModerationAudits(item.caseId);
}

function moderationActionText(action: SocialModerationActionCode): string {
  return ({ APPROVE: '审核通过', HIDE: '隐藏内容', RESTORE: '恢复内容', DISMISS: '驳回举报' })[action];
}

async function loadSupportQueue(cursor?: string) {
  supportLoading.value = true;
  supportError.value = '';
  const result = await localSupportDeskApplication.list({
    ...(supportStatus.value ? { status: Number(supportStatus.value) } : {}),
    ...(supportKeyword.value.trim() ? { keyword: supportKeyword.value.trim() } : {}),
    pageSize: 50,
    ...(cursor ? { cursor } : {}),
  });
  supportLoading.value = false;
  if (!result.ok) { supportError.value = result.code === 'READ_FAILED' ? '队列暂时无法读取，请重试。' : '查询条件无效，请检查后重试。'; return; }
  supportItems.value = cursor ? [...supportItems.value, ...result.value.items] : result.value.items;
  supportQueueTotal.value = result.value.total;
  supportNextCursor.value = result.value.nextCursor;
}

async function loadSupportDetail() {
  if (!conversationId.value) return;
  detailLoading.value = true;
  detailError.value = '';
  const result = await localSupportDeskApplication.detail(conversationId.value);
  detailLoading.value = false;
  if (!result.ok) { detailError.value = result.code === 'NOT_FOUND' ? '会话不存在或当前工作区无权读取。' : '会话读取失败，请重试。'; supportDetail.value = null; return; }
  supportDetail.value = result.value;
  supportMessages.value = result.value.messages;
}

async function runSupportAction(action: 'claim' | 'resolve' | 'reopen') {
  if (!supportDetail.value) return;
  supportActionBusy.value = true;
  supportActionError.value = '';
  supportFeedback.value = '';
  const requestKey = supportActionRequestKeys.value[action] ??= crypto.randomUUID();
  const request = { requestKey };
  const result = action === 'claim'
    ? await localSupportDeskApplication.claim(conversationId.value, request)
    : action === 'resolve'
      ? await localSupportDeskApplication.resolve(conversationId.value, request)
      : await localSupportDeskApplication.reopen(conversationId.value, request);
  supportActionBusy.value = false;
  if (!result.ok) { supportActionError.value = ({ ASSIGNED_TO_OTHER: '该会话由其他客服负责，当前账号不能操作。', CLOSED: '会话已结束，不能领取。', NOT_FOUND: '会话不存在或已移出当前权限范围。', INVALID_STATE: '当前状态不能执行此操作。', REQUEST_KEY_REUSED: '操作编号冲突，请重新执行。', WRITE_FAILED: '保存结果未知；重试将沿用本次操作编号。' } as Record<string, string>)[result.code] ?? '操作未完成，请重试。'; if (result.code === 'REQUEST_KEY_REUSED') delete supportActionRequestKeys.value[action]; return; }
  delete supportActionRequestKeys.value[action];
  supportDetail.value = result.value;
  supportMessages.value = result.value.messages;
  supportFeedback.value = action === 'claim' ? '已领取会话。' : action === 'resolve' ? '会话已结束，可从“已结束”筛选中重新打开。' : '会话已重新打开。';
  await loadSupportQueue();
}

async function sendSupportReply() {
  if (!supportReply.value.trim() || !supportDetail.value) return;
  supportActionBusy.value = true;
  supportActionError.value = '';
  supportFeedback.value = '';
  replyRequestKey.value ??= crypto.randomUUID();
  const result = await localSupportDeskApplication.reply(conversationId.value, { bodyText: supportReply.value, messageKey: replyRequestKey.value });
  supportActionBusy.value = false;
  if (!result.ok) { supportActionError.value = ({ CLOSED: '会话已经结束，无法发送回复。', ASSIGNED_TO_OTHER: '请先领取该会话，或联系负责人转派。', REQUEST_KEY_REUSED: '本次重试编号已用于其他消息，请重新发送。', NOT_FOUND: '会话不存在或已移出当前权限范围。', WRITE_FAILED: '回复未确认；草稿和重试编号已保留，可安全重试。' } as Record<string, string>)[result.code] ?? '回复未能发送，请检查后重试。'; if (result.code === 'REQUEST_KEY_REUSED') replyRequestKey.value = null; return; }
  supportDetail.value = result.value;
  supportMessages.value = result.value.messages;
  supportReply.value = '';
  replyRequestKey.value = null;
  supportFeedback.value = '回复已保存到本机客服演练记录。';
  await loadSupportQueue();
}

function confirmResolve() {
  if (window.confirm('结束本次客服会话？会话历史会保留，之后可以重新打开。')) void runSupportAction('resolve');
}

onMounted(() => { void loadSupportQueue(); void loadSupportDetail(); if (isModeration.value) void loadModerationCases(); });
watch(() => route.path, (path) => { if (path === '/admin/community/moderation') void loadModerationCases(); });
watch(conversationId, () => { supportReply.value = ''; replyRequestKey.value = null; supportActionRequestKeys.value = {}; supportDetail.value = null; void loadSupportDetail(); });
const supportHelp = [
  { heading: '权限分区', body: '社区审核、代理域私聊读取和客服 IM 是独立权限。客服队列与会话不因 URL 中的 ID 推断存在或授权。' },
  { heading: '附件查看', body: '每次附件查看都需检查客服权限、会话归属并填写目的；使用 Asset 授权的流式解密，记录客服、目的、asset ID 和时间。' },
  { heading: '账号恢复', body: '客服可以创建人工核验工单，但不能重置用户 TOTP 或查看密钥、恢复码。' },
];
</script>

<template>
  <section class="social-support-page">
    <div class="social-support-heading">
      <div><p class="eyebrow">社区与客服</p><h1>{{ page.title }}</h1><p>管理当前工作区的内容与会话。</p></div>
      <PageHelpOverlay title="社区与客服操作说明" trigger-label="查看社区与客服操作说明" :sections="supportHelp" />
    </div>

    <nav v-if="!isConversation" class="social-support-tabs" aria-label="社区与客服工作区">
      <RouterLink v-for="section in sections" :key="section.path" :to="section.path" :class="{ active: page.path === section.path }">{{ section.title }}</RouterLink>
    </nav>
    <RouterLink v-else to="/admin/support/conversations" class="back-link">← 返回客服队列</RouterLink>

    <template v-if="isTopics">
      <section class="social-support-query-panel">
        <div class="social-support-panel-heading"><div><h2>话题目录</h2><p>话题封面引用 Asset；平台公共话题和代理域话题必须明确标记 scope。</p></div><button type="button" disabled>＋ 新建话题</button></div>
        <div class="social-support-filter-grid">
          <label>话题名称<input disabled placeholder="输入名称"></label>
          <label>可见范围<select disabled><option>全部范围</option></select></label>
          <label>启用状态<select disabled><option>全部状态</option></select></label>
          <button type="button" disabled>查询话题</button>
        </div>
        <div class="social-support-empty"><span>◇</span><strong>暂无可读取的话题</strong><p>新增或编辑需选择 Asset 封面、排序和启用状态；保存后由服务端记录版本与操作者，不在浏览器写入社交数据。</p></div>
      </section>
    </template>

    <template v-else-if="isModeration">
      <section class="social-support-query-panel">
        <div class="social-support-panel-heading"><div><h2>社区审核队列</h2><p>仅处理公开话题、帖子、回复和举报；普通私聊与客服会话不出现在此队列。当前使用本机演练数据。</p></div><span>处置原因必填 · 封禁不在此执行</span></div>
        <div class="social-support-filter-grid moderation-filters">
          <label>内容类型<select v-model="moderationResourceType"><option value="">帖子 / 回复</option><option :value="SocialModerationResourceType.POST">帖子</option><option :value="SocialModerationResourceType.REPLY">回复</option></select></label>
          <label>处理状态<select v-model="moderationCaseStatus"><option value="">全部状态</option><option :value="String(SocialModerationCaseStatus.OPEN)">待处理</option><option :value="String(SocialModerationCaseStatus.RESOLVED)">已处理</option><option :value="String(SocialModerationCaseStatus.DISMISSED)">已驳回</option></select></label>
          <label>话题 / 内容 / 作者<input v-model="moderationKeyword" maxlength="80" placeholder="输入关键词"></label>
          <button type="button" @click="loadModerationCases()">{{ moderationLoading ? '查询中…' : '查询队列' }}</button>
        </div>
        <p v-if="moderationError" class="support-feedback is-error" role="alert">{{ moderationError }} <button type="button" @click="loadModerationCases()">重试</button></p>
        <div v-else-if="moderationLoading && moderationCases.length===0" class="social-support-empty" role="status"><strong>正在读取审核队列…</strong></div>
        <div v-else-if="moderationCases.length===0" class="social-support-empty"><span>☷</span><strong>没有符合条件的审核项</strong><p>调整内容类型、处理状态或关键词后再查。</p><button type="button" @click="moderationResourceType='';moderationCaseStatus=String(SocialModerationCaseStatus.OPEN);moderationKeyword='';loadModerationCases()">清除筛选</button></div>
        <div v-else class="moderation-workspace">
          <div class="moderation-case-list" aria-label="审核项列表">
            <button v-for="item in moderationCases" :key="item.caseId" type="button" :class="['moderation-case-card', { selected: selectedModerationCase?.caseId===item.caseId }]" @click="selectModerationCase(item)">
              <span><b>{{ moderationResourceText(item.resourceType) }} · {{ item.topicTitle }}</b><em :data-status="item.caseStatus">{{ moderationCaseStatusText(item.caseStatus) }}</em></span>
              <strong>{{ item.contentTitle || '无标题内容' }}</strong><small>{{ item.authorLabel }} · {{ item.reasonCode }} · {{ item.reporterCount }} 人反馈</small>
              <p>{{ item.reportSummary }}</p>
            </button>
            <div class="moderation-pagination"><span>显示 {{ moderationCases.length }} / {{ moderationTotal }} 条</span><button v-if="moderationNextCursor" type="button" :disabled="moderationLoading" @click="loadModerationCases(moderationNextCursor)">{{ moderationLoading ? '正在读取…' : '加载更多' }}</button></div>
          </div>
          <section v-if="selectedModerationCase" class="moderation-detail-panel" aria-label="审核内容详情">
            <header><div><small>{{ moderationResourceText(selectedModerationCase.resourceType) }} · {{ selectedModerationCase.topicTitle }} · {{ moderationCaseStatusText(selectedModerationCase.caseStatus) }}</small><h3>{{ selectedModerationCase.contentTitle || '无标题内容' }}</h3></div><span>{{ moderationContentStatusText(selectedModerationCase.contentStatus) }}</span></header>
            <p class="moderation-author">作者：{{ selectedModerationCase.authorLabel }} · 资源 ID {{ selectedModerationCase.resourceId }}<template v-if="selectedModerationCase.agentDomainId"> · 代理域 {{ selectedModerationCase.agentDomainId }}</template></p>
            <blockquote>{{ selectedModerationCase.contentBody }}</blockquote>
            <aside class="moderation-report-summary"><strong>反馈摘要 · {{ selectedModerationCase.reporterCount }} 人</strong><p>{{ selectedModerationCase.reasonCode }}：{{ selectedModerationCase.reportSummary }}</p></aside>
            <form v-if="selectedModerationCase.caseStatus===SocialModerationCaseStatus.OPEN" class="moderation-decision-form" @submit.prevent="decideModerationCase">
              <label>处置方式<select v-model="moderationAction"><option v-for="option in moderationActionOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
              <p class="moderation-effect-note"><template v-if="moderationAction===SocialModerationAction.APPROVE">内容将变为公开并进入话题流。</template><template v-else-if="moderationAction===SocialModerationAction.HIDE">内容将从普通话题流隐藏，原文及审核记录仍保留。</template><template v-else-if="moderationAction===SocialModerationAction.RESTORE">内容将恢复为公开状态。</template><template v-else>只关闭当前举报，不改变内容状态。</template>封禁用户需转交账号安全流程。</p>
              <label>处理原因<textarea v-model="moderationReason" maxlength="500" required placeholder="至少填写 3 个字符，说明证据与决定依据"></textarea><small>{{ moderationReason.trim().length }}/500</small></label>
              <button type="submit" :disabled="moderationSaving || moderationReason.trim().length<3">{{ moderationSaving ? '正在保存…' : '提交处置' }}</button>
            </form>
            <p v-else class="moderation-closed-note">该审核项已关闭，保留只读；新的举报应创建新的审核项。</p>
            <p v-if="moderationFeedback" class="support-feedback" role="status">{{ moderationFeedback }}</p>
            <p v-if="moderationActionError" class="support-feedback is-error" role="alert">{{ moderationActionError }}</p>
            <section class="moderation-audit-history"><h4>不可变处置记录</h4><p v-if="moderationAuditError" class="support-feedback is-error">{{ moderationAuditError }} <button type="button" @click="loadModerationAudits(selectedModerationCase!.caseId)">重试</button></p><p v-else-if="moderationAudits.length===0">尚无处置记录。</p><article v-for="audit in moderationAudits" :key="audit.auditId"><strong>{{ moderationActionText(audit.action) }}</strong><time>{{ messageTime(audit.createdAt) }}</time><p>{{ audit.reason }}</p><small>Admin {{ audit.reviewerAdminUserId }} · {{ moderationContentStatusText(audit.previousStatus) }} → {{ moderationContentStatusText(audit.nextStatus) }} · {{ audit.auditId }}</small></article></section>
          </section>
          <div v-else class="moderation-detail-placeholder"><strong>选择一条审核项</strong><p>先查看完整内容和举报摘要，再选择可用处置并填写原因。</p></div>
        </div>
        <div v-if="!moderationError && moderationCases.length" class="moderation-total"><span>普通私聊与客服会话不出现在此队列。跨代理域访问范围由授权决定，筛选条件不会扩大权限。</span></div>
        <aside class="social-support-privacy-note"><strong>权限隔离</strong><p>社区审核不授予客服 IM、代理私聊、钱包或概率配置权限。跨代理域检索必须由服务端限制 scope，不能由筛选器扩大范围。</p></aside>
      </section>
    </template>

    <template v-else-if="!isConversation">
      <section class="social-support-query-panel">
        <div class="social-support-panel-heading"><div><h2>客服会话队列</h2><p>先筛选并领取会话，再读取历史、回复或结束；本页使用独立的本机演练记录。</p></div><span>附件需 Asset 能力接入</span></div>
        <div class="social-support-filter-grid support-queue-filters">
          <label>队列状态<select v-model="supportStatus"><option value="">全部状态</option><option :value="String(SupportConversationStatus.WAITING_SUPPORT)">等待客服</option><option :value="String(SupportConversationStatus.WAITING_USER)">等待用户</option><option :value="String(SupportConversationStatus.CLOSED)">已结束</option></select></label>
          <label>用户 / 主题<input v-model="supportKeyword" maxlength="80" placeholder="按脱敏姓名、主题或 ID 查找"></label>
          <div class="support-filter-hint">仅显示当前本机演练数据</div>
          <button type="button" @click="loadSupportQueue()">{{ supportLoading ? '查询中…' : '查询会话' }}</button>
        </div>
        <p v-if="supportError" class="support-feedback is-error" role="alert">{{ supportError }} <button type="button" @click="loadSupportQueue()">重试</button></p>
        <div v-else-if="supportLoading && supportItems.length === 0" class="social-support-empty" role="status"><strong>正在读取会话队列…</strong></div>
        <div v-else-if="supportItems.length === 0" class="social-support-empty"><span>☏</span><strong>没有符合条件的会话</strong><p>清除筛选条件，或等待用户提交新的工单。</p><button type="button" @click="supportKeyword='';supportStatus='';loadSupportQueue()">清除筛选</button></div>
        <div v-else class="support-queue-table-wrap"><table class="support-queue-table"><thead><tr><th>用户 / 会话</th><th>问题类别</th><th>状态</th><th>负责人</th><th>最近消息</th><th></th></tr></thead><tbody><tr v-for="item in supportItems" :key="item.conversation.conversationId"><td><strong>{{ item.customerDisplayName }}</strong><small>{{ item.customerUserId }} · {{ item.conversation.subject }}</small></td><td>{{ categoryText(item.conversation.categoryType) }}</td><td><span class="support-status-chip" :data-status="item.conversation.status">{{ statusText(item.conversation.status) }}</span></td><td>{{ item.assignedAdminUserId ? (item.assignedAdminUserId === '90001' ? '当前客服' : '其他客服') : '待领取' }}</td><td>{{ item.conversation.lastMessageAt ? messageTime(item.conversation.lastMessageAt) : '—' }}</td><td><button type="button" class="support-open-action" @click="router.push(`/admin/support/conversations/${item.conversation.conversationId}`)">查看会话</button></td></tr></tbody></table></div>
        <div v-if="!supportError && supportItems.length" class="support-queue-pagination"><span>显示 {{ supportItems.length }} / {{ supportQueueTotal }} 条会话</span><button v-if="supportNextCursor" type="button" :disabled="supportLoading" @click="loadSupportQueue(supportNextCursor)">{{ supportLoading ? '正在读取…' : '加载更多' }}</button></div>
        <aside class="social-support-privacy-note"><strong>客服身份恢复工单</strong><p>可按流程核验 TOTP / 恢复凭证问题并转人工处理；后台不得直接重置用户 TOTP，也不得展示密钥或恢复码。</p></aside>
      </section>
    </template>

    <template v-else>
      <section v-if="detailLoading" class="social-support-empty" role="status"><strong>正在载入会话…</strong></section>
      <section v-else-if="detailError" class="social-support-empty"><strong>{{ detailError }}</strong><div><button type="button" @click="loadSupportDetail">重试读取</button><RouterLink to="/admin/support/conversations">返回队列</RouterLink></div></section>
      <section v-else-if="supportDetail" class="support-conversation-layout">
        <div class="support-message-panel">
          <div class="social-support-panel-heading"><div><h2>{{ supportDetail.item.customerDisplayName }} · {{ supportDetail.item.conversation.subject }}</h2><p>{{ categoryText(supportDetail.item.conversation.categoryType) }} · {{ statusText(supportDetail.item.conversation.status) }} · 用户 ID {{ supportDetail.item.customerUserId }}</p></div><span class="support-local-label">LOCAL_DEMO</span></div>
          <div class="support-message-list" aria-live="polite"><article v-for="message in supportMessages" :key="message.messageId" :class="['support-message', message.senderType === SupportSenderType.ADMIN ? 'from-admin' : 'from-customer']"><div><strong>{{ message.senderType === SupportSenderType.ADMIN ? '客服' : supportDetail.item.customerDisplayName }}</strong><time>{{ messageTime(message.createdAt) }}</time></div><p>{{ message.bodyText }}</p></article><p v-if="supportMessages.length===0" class="support-message-empty">暂无消息</p></div>
          <p v-if="supportFeedback" class="support-feedback" role="status">{{ supportFeedback }}</p>
          <p v-if="supportActionError" class="support-feedback is-error" role="alert">{{ supportActionError }}</p>
          <form v-if="supportDetail.item.conversation.status !== SupportConversationStatus.CLOSED" class="support-reply-box" @submit.prevent="sendSupportReply"><label for="support-reply">客服回复</label><p v-if="supportDetail.item.assignedAdminUserId!=='90001'" class="support-assignment-hint">请先领取会话，领取后才能发送回复。</p><textarea id="support-reply" v-model="supportReply" maxlength="4000" placeholder="请勿索取或发送密码、验证码、TOTP 密钥或恢复码"></textarea><div><small>{{ supportReply.length }}/4000 · 回复成功后状态变为“等待用户”</small><button type="submit" :disabled="supportActionBusy || !supportReply.trim() || supportDetail.item.assignedAdminUserId !== '90001'">{{ supportActionBusy ? '正在保存…' : '发送回复' }}</button></div></form>
          <p v-else class="support-closed-note">此会话已结束，历史只读。需要继续处理时请重新打开。</p>
        </div>
        <aside class="support-detail-panel">
          <section><small>数据来源</small><strong>浏览器本机演练</strong><p>这些示例不是线上工单，也不会发消息给用户或更改资产、身份状态。</p></section>
          <section><small>客服权限边界</small><strong>不提供 TOTP 重置</strong><p>账号恢复只能转人工身份核验；不得索取密码、验证码、恢复码或 TOTP 秘钥。</p></section>
          <section><small>附件支持</small><strong>需要 Asset 授权链路</strong><p>当前演练仅支持文本消息。附件上传、授权解密和逐次审计尚未接入，所以本页不开放附件操作。</p></section>
          <section><small>会话操作</small><div class="support-conversation-actions"><button v-if="!supportDetail.item.assignedAdminUserId && supportDetail.item.conversation.status!==SupportConversationStatus.CLOSED" type="button" :disabled="supportActionBusy" @click="runSupportAction('claim')">领取会话</button><span v-else-if="supportDetail.item.assignedAdminUserId!=='90001'">{{ supportDetail.item.assignedAdminUserId ? '由其他客服负责' : '当前未分派' }}</span><span v-else>当前客服负责</span><button v-if="supportDetail.item.conversation.status===SupportConversationStatus.CLOSED && supportDetail.item.assignedAdminUserId==='90001'" type="button" :disabled="supportActionBusy" @click="runSupportAction('reopen')">重新打开</button><button v-else-if="supportDetail.item.conversation.status!==SupportConversationStatus.CLOSED && supportDetail.item.assignedAdminUserId==='90001'" type="button" :disabled="supportActionBusy" @click="confirmResolve">结束会话</button></div></section>
        </aside>
      </section>
    </template>
  </section>
</template>
