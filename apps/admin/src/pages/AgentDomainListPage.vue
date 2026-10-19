<script setup lang="ts">
import { ElSelect } from 'element-plus';
import AdminSelectOption from '../components/AdminSelectOption.vue';
import { computed, onMounted, ref } from 'vue';
import { AgentCapabilityCode, AgentDomainAdminAction, AgentDomainStatus, type AgentCapabilityCodeValue, type AgentDomainDto } from '@gameing/contracts/invite-agent';
import type { AgentDomainReviewAuditDto } from '@gameing/admin-contracts/agent-domain-review';
import PageHelpOverlay from '../components/PageHelpOverlay.vue';
import { localAgentDomainReviewApplication } from '../platform/agent-domain-review/composition';
import type { AgentDomainReviewWorkspaceApplication } from '../platform/agent-domain-review/agent-domain-review-application';

const props = defineProps<{ application?: AgentDomainReviewWorkspaceApplication }>();
const application = props.application ?? localAgentDomainReviewApplication;
const records = ref<AgentDomainDto[]>([]);
const audits = ref<AgentDomainReviewAuditDto[]>([]);
const filterStatus = ref<number | ''>('');
const filterUserId = ref('');
const selectedUserId = ref('');
const target = ref<AgentDomainDto | null>(null);
const action = ref<typeof AgentDomainAdminAction[keyof typeof AgentDomainAdminAction] | null>(null);
const capabilities = ref<AgentCapabilityCodeValue[]>([]);
const reason = ref('');
const requestKey = ref('');
const error = ref('');
const pageError = ref('');
const notice = ref('');
const loading = ref(false);
const saving = ref(false);
const reviewOpen = computed(() => target.value !== null && action.value !== null);
const statusOptions = [
  { value: AgentDomainStatus.PENDING_REVIEW, label: '待审核' },
  { value: AgentDomainStatus.ACTIVE, label: '运营中' },
  { value: AgentDomainStatus.SUSPENDED, label: '已暂停' },
  { value: AgentDomainStatus.REVOKED, label: '已撤销 / 已驳回' },
  { value: AgentDomainStatus.WITHDRAWN, label: '已撤回' },
];
const capabilityOptions: { code: AgentCapabilityCodeValue; title: string; group: string; detail: string }[] = [
  { code: AgentCapabilityCode.DASHBOARD_READ, title: '代理域总览', group: '数据读取', detail: '本域汇总运营数据' },
  { code: AgentCapabilityCode.DOWNLINE_READ, title: '下线业务明细', group: '数据读取', detail: '下线资产、订单、牌局和邀请资料' },
  { code: AgentCapabilityCode.EXPORT_READ, title: '数据导出', group: '数据读取', detail: '导出已获准字段并单独审计' },
  { code: AgentCapabilityCode.GAME_CONFIG_READ, title: '查看域级游戏配置', group: '游戏运营', detail: '本域有效配置和继承值' },
  { code: AgentCapabilityCode.GAME_CONFIG_SIMULATE, title: '运行期望计算', group: '游戏运营', detail: '虚拟样本试算，不扣钱、不写牌局' },
  { code: AgentCapabilityCode.GAME_CONFIG_PUBLISH, title: '发布域级配置', group: '游戏运营', detail: '通过边界和计算校验后作用于新局' },
  { code: AgentCapabilityCode.ANNOUNCEMENT_MANAGE, title: '管理域内广播', group: '域内互动', detail: '仅面向当前代理域发布和撤回' },
  { code: AgentCapabilityCode.SOCIAL_MODERATE, title: '管理公开社区', group: '域内互动', detail: '本域话题、帖子与回复' },
  { code: AgentCapabilityCode.SOCIAL_READ_PRIVATE_MESSAGES, title: '查看域内私聊', group: '域内互动', detail: '只读本域私聊；每次读取都需审计' },
];
const visibleRecords = computed(() => records.value.filter((record) =>
  (filterStatus.value === '' || record.status === filterStatus.value)
  && (!filterUserId.value.trim() || record.userId.includes(filterUserId.value.trim())),
));
const visibleAudits = computed(() => audits.value.filter((item) => item.userId === selectedUserId.value));
const groupNames = [...new Set(capabilityOptions.map((item) => item.group))];

function statusLabel(status: number): string {
  return statusOptions.find((item) => item.value === status)?.label ?? '未知状态';
}

function actionLabel(value: typeof AgentDomainAdminAction[keyof typeof AgentDomainAdminAction]): string {
  return ({ APPROVE: '批准', REJECT: '驳回', SUSPEND: '暂停', RESTORE: '恢复', REVOKE: '撤销', UPDATE_CAPABILITIES: '更新能力' })[value];
}

function dialogTitle(value: typeof AgentDomainAdminAction[keyof typeof AgentDomainAdminAction]): string {
  return ({ APPROVE: '批准并配置能力', REJECT: '驳回代理申请', SUSPEND: '暂停代理域', RESTORE: '恢复代理域', REVOKE: '撤销代理权限', UPDATE_CAPABILITIES: '调整代理能力' })[value];
}

async function refresh(): Promise<void> {
  loading.value = true;
  pageError.value = '';
  try {
    const result = await application.listDomains();
    if (!result.ok) pageError.value = '代理域记录格式异常，请重试。';
    else records.value = result.value;
  } catch {
    pageError.value = '本机演练数据暂时无法读取，请重试。';
  } finally {
    loading.value = false;
  }
}

async function addDemo(): Promise<void> {
  pageError.value = '';
  notice.value = '';
  try {
    const result = await application.createLocalDemoApplication();
    if (!result.ok) {
      pageError.value = '本机演练申请未创建，请重试。';
      return;
    }
    notice.value = '已创建本机演练申请 ' + result.value.userId + '。';
    filterStatus.value = AgentDomainStatus.PENDING_REVIEW;
    await refresh();
  } catch {
    pageError.value = '本机演练申请未创建，请检查浏览器存储后重试。';
  }
}

function openReview(record: AgentDomainDto, nextAction: typeof AgentDomainAdminAction[keyof typeof AgentDomainAdminAction]): void {
  target.value = record;
  action.value = nextAction;
  capabilities.value = nextAction === AgentDomainAdminAction.UPDATE_CAPABILITIES ? [...record.capabilities] : [];
  reason.value = '';
  requestKey.value = 'agent-review-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  error.value = '';
}

function closeReview(): void {
  if (saving.value) return;
  target.value = null;
  action.value = null;
  error.value = '';
}

async function submitReview(): Promise<void> {
  if (!target.value || !action.value || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const result = await application.execute({
      requestKey: requestKey.value,
      userId: target.value.userId,
      action: action.value,
      capabilities: capabilities.value,
      reason: reason.value,
    });
    if (!result.ok) {
      error.value = {
        INVALID_REQUEST: '审核内容不符合登记规则。',
        REASON_REQUIRED: '请填写至少 3 个字符的审核原因。',
        REJECT_CANNOT_GRANT_CAPABILITIES: '驳回申请不能同时授予能力。',
        DOMAIN_NOT_FOUND: '该申请已不存在，请刷新列表。',
        DOMAIN_STATE_CONFLICT: '代理域状态已经变化，请刷新后重新确认。',
        REQUEST_KEY_REUSED: '请求标识已用于其他内容，请关闭后重新操作。',
      }[result.code];
      return;
    }
    const actionLabel: Record<typeof AgentDomainAdminAction[keyof typeof AgentDomainAdminAction], string> = {
      APPROVE: '本机演练申请已批准，能力已记录。', REJECT: '本机演练申请已驳回。', SUSPEND: '本机演练代理域已暂停。', RESTORE: '本机演练代理域已恢复。', REVOKE: '本机演练代理权限已撤销。', UPDATE_CAPABILITIES: '本机演练代理能力已更新。',
    };
    notice.value = actionLabel[action.value];
    selectedUserId.value = result.value.agentDomain.userId;
    filterStatus.value = result.value.agentDomain.status;
    target.value = null;
    action.value = null;
    await refresh();
    const auditResult = await application.listAudits(selectedUserId.value);
    audits.value = auditResult.ok ? auditResult.value : [];
  } catch {
    error.value = '审核结果暂时无法确认；请刷新检查原请求状态。';
  } finally {
    saving.value = false;
  }
}

async function toggleAudits(record: AgentDomainDto): Promise<void> {
  selectedUserId.value = selectedUserId.value === record.userId ? '' : record.userId;
  if (!selectedUserId.value) {
    audits.value = [];
    return;
  }
  try {
    const result = await application.listAudits(record.userId);
    audits.value = result.ok ? result.value : [];
  } catch {
    pageError.value = '审核记录暂时无法读取，请重试。';
  }
}

onMounted(() => { void refresh(); });
</script>

<template>
  <section class="domain-page agent-domain-page">
    <div class="domain-heading">
      <p class="eyebrow">用户与代理 / 权限与范围</p><h1>代理域</h1>
      <p>审核普通用户的代理申请，并按 capability 白名单开通运营范围。代理域不创建独立登录账号。</p>
    </div>
    <section class="agent-domain-notice" aria-label="本机演练边界">
      <span class="domain-state-icon" aria-hidden="true">◇</span>
      <div><strong>本机审核演练</strong><p>记录只保存在当前浏览器 IndexedDB，不代表真实用户、线上授权或生产审计。</p></div>
      <button type="button" class="agent-domain-demo-button" @click="addDemo">创建演练申请</button>
    </section>
    <p v-if="notice" class="agent-domain-result" role="status">{{ notice }}</p>
    <p v-if="pageError" class="agent-domain-error" role="alert">{{ pageError }} <button type="button" @click="refresh">重试</button></p>

    <section class="agent-domain-filter" aria-labelledby="agent-domain-filter-title">
      <div class="agent-domain-section-heading"><div><h2 id="agent-domain-filter-title">申请与代理列表</h2><p>演练申请使用独立的本机演练身份，不会写入真实用户。</p></div><span class="record-count">{{ visibleRecords.length }} 条</span></div>
      <div class="agent-domain-controls">
        <label><span>本机演练 user ID</span><input v-model="filterUserId" type="search" placeholder="输入演练 user ID" /></label>
        <label><span>域状态</span><el-select v-model="filterStatus"><AdminSelectOption value="">全部状态</AdminSelectOption><AdminSelectOption v-for="item in statusOptions" :key="item.value" :value="item.value">{{ item.label }}</AdminSelectOption></el-select></label>
        <button type="button" @click="filterUserId = ''; filterStatus = ''">清除筛选</button>
      </div>
      <div v-if="loading" class="agent-domain-empty" role="status">正在读取本机演练记录…</div>
      <div v-else-if="!visibleRecords.length" class="agent-domain-empty" role="status"><span class="user-empty-icon" aria-hidden="true">⌕</span><strong>{{ records.length ? '没有匹配的记录' : '暂无本机演练记录' }}</strong><p>{{ records.length ? '调整筛选条件，或清除筛选查看其他状态。' : '创建演练申请后，可走完能力勾选、确认、结果和审计查看。' }}</p></div>
      <div v-else class="agent-domain-record-list">
        <article v-for="record in visibleRecords" :key="record.userId" class="agent-domain-record">
          <div class="agent-domain-record-main"><span class="agent-domain-local-pill">LOCAL_DEMO</span><strong>本机演练普通用户</strong><code>{{ record.userId }}</code><small>申请于 {{ new Date(record.appliedAt).toLocaleString() }}</small></div>
          <div class="agent-domain-record-state"><span class="agent-domain-state-pill">{{ statusLabel(record.status) }}</span><small>{{ record.capabilities.length }} 项 capability</small></div>
          <div class="agent-domain-record-actions">
            <button type="button" @click="toggleAudits(record)">{{ selectedUserId === record.userId ? '收起审核记录' : '查看审核记录' }}</button>
            <button v-if="record.status === AgentDomainStatus.PENDING_REVIEW" type="button" class="agent-domain-approve" @click="openReview(record, AgentDomainAdminAction.APPROVE)">审核批准</button>
            <button v-if="record.status === AgentDomainStatus.PENDING_REVIEW" type="button" class="agent-domain-reject" @click="openReview(record, AgentDomainAdminAction.REJECT)">驳回</button>
            <button v-if="record.status === AgentDomainStatus.ACTIVE" type="button" @click="openReview(record, AgentDomainAdminAction.UPDATE_CAPABILITIES)">调整能力</button>
            <button v-if="record.status === AgentDomainStatus.ACTIVE" type="button" class="agent-domain-reject" @click="openReview(record, AgentDomainAdminAction.SUSPEND)">暂停</button>
            <button v-if="record.status === AgentDomainStatus.SUSPENDED" type="button" class="agent-domain-approve" @click="openReview(record, AgentDomainAdminAction.RESTORE)">恢复</button>
            <button v-if="record.status === AgentDomainStatus.ACTIVE || record.status === AgentDomainStatus.SUSPENDED" type="button" class="agent-domain-reject" @click="openReview(record, AgentDomainAdminAction.REVOKE)">撤销权限</button>
          </div>
          <div v-if="selectedUserId === record.userId" class="agent-domain-audit-list"><strong>不可变审核记录</strong><p v-if="!visibleAudits.length">暂无审核记录。</p>
            <article v-for="audit in visibleAudits" :key="audit.auditId"><span>{{ actionLabel(audit.action) }} · {{ statusLabel(audit.previousStatus) }} → {{ statusLabel(audit.nextStatus) }}</span><small>{{ new Date(audit.createdAt).toLocaleString() }} · {{ audit.reason }}</small><small>能力：{{ audit.nextCapabilities.length ? audit.nextCapabilities.join('、') : '无' }}</small></article>
          </div>
        </article>
      </div>
    </section>

    <section class="agent-domain-capabilities" aria-labelledby="agent-capabilities-title">
      <div class="agent-domain-section-heading"><div><h2 id="agent-capabilities-title">授权能力边界</h2><p>只允许选择代码登记的 capability；菜单隐藏不替代 API 授权。</p></div>
        <PageHelpOverlay title="代理能力说明" trigger-label="查看代理能力说明" :sections="[{ heading: '独立授权', body: '配置发布、运行计算、数据导出、域内广播、社区审核和私聊读取分别控制。' }, { heading: '用户与域', body: '代理仍是 user 表中的普通账号。驳回保留域记录，不删除 user 或邀请关系。' }, { heading: '演练数据', body: '本页操作只改变当前浏览器的本机演练数据；真实审批仍需要服务端权限、事务和不可变审计。' }]" />
      </div>
      <div class="capability-group-grid"><article v-for="group in groupNames" :key="group" class="capability-group"><h3>{{ group }}</h3><ul><li v-for="item in capabilityOptions.filter((capability) => capability.group === group)" :key="item.code"><span aria-hidden="true">○</span><span><strong>{{ item.title }}</strong><small>{{ item.code }}</small></span></li></ul></article></div>
      <p class="agent-domain-footnote">密码、TOTP 秘钥、恢复码和设备认证秘密永不开放给代理；私聊读取、导出、配置发布及域广播分别授权并留审计。</p>
    </section>

    <Teleport to="body">
      <div v-if="reviewOpen" class="agent-domain-review-backdrop" @click.self="closeReview">
        <section class="agent-domain-review-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-domain-review-title">
          <header><div><p class="eyebrow">LOCAL_DEMO / 代理域操作</p><h2 id="agent-domain-review-title">{{ action ? dialogTitle(action) : '代理域操作' }}</h2><p>演练用户 {{ target?.userId }}</p></div><button type="button" aria-label="关闭审核" :disabled="saving" @click="closeReview">×</button></header>
          <div v-if="action === AgentDomainAdminAction.APPROVE || action === AgentDomainAdminAction.UPDATE_CAPABILITIES" class="agent-domain-capability-picker"><p>{{ action === AgentDomainAdminAction.APPROVE ? '勾选本次开通的能力；未勾选的能力默认关闭。' : '勾选需要保留的能力；未勾选的能力将被移除。' }}</p><label v-for="item in capabilityOptions" :key="item.code"><input v-model="capabilities" type="checkbox" :value="item.code" /><span><strong>{{ item.title }}</strong><small>{{ item.code }} · {{ item.detail }}</small></span></label></div>
          <p v-else class="agent-domain-reject-summary">{{ action === AgentDomainAdminAction.REJECT ? '驳回后保留申请事实，不删除 user 或邀请关系。' : action === AgentDomainAdminAction.SUSPEND ? '暂停期间保留当前能力；恢复后按原能力继续。' : action === AgentDomainAdminAction.RESTORE ? '恢复后重新启用当前 capability 列表。' : action === AgentDomainAdminAction.REVOKE ? '撤销后清空域能力并保留审计历史。' : '确认此项代理域操作。' }}</p>
          <label class="agent-domain-review-reason">操作原因<textarea v-model="reason" minlength="3" maxlength="500" rows="3" placeholder="填写至少 3 个字符的原因"></textarea></label>
          <p v-if="error" class="agent-domain-error" role="alert">{{ error }}</p>
          <footer><button type="button" :disabled="saving" @click="closeReview">取消</button><button type="button" class="agent-domain-approve" :disabled="saving" @click="submitReview">{{ saving ? '提交中…' : `确认${action ? actionLabel(action) : '操作'}` }}</button></footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>
