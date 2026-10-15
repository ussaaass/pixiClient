<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  AdminManagedUserStatus,
  AdminPermissionAction,
  AdminPermissionSource,
  AdminPermissionStatus,
  type AdminManagedUserDto,
  type AdminPermissionAuditDto,
  type AdminPermissionPathDto,
} from '@gameing/admin-contracts/admin-permissions';
import {
  AdminAuditResultType,
  type AdminAuditDto,
} from '@gameing/admin-contracts/admin-audit';
import { getAdminHealth } from '../platform/health-api';
import PageHelpOverlay from '../components/PageHelpOverlay.vue';
import SystemConfigWorkspace from './SystemConfigWorkspace.vue';
import { localSystemConfigApplication } from '../platform/system-config/composition';
import { localAdminPermissionApplication } from '../platform/admin-permissions/composition';
import { localAdminAuditApplication } from '../platform/admin-audit/composition';

const route = useRoute();
const sections = [
  { path: '/admin/system-config', title: '系统配置' },
  { path: '/admin/admin-users', title: 'Admin 权限' },
  { path: '/admin/audit', title: '操作审计' },
  { path: '/admin/jobs', title: 'Worker / Outbox' },
  { path: '/admin/health', title: '服务健康' },
];
const healthHelp = [
  { heading: '当前探测范围', body: '当前健康检查只确认 Admin HTTP API 进程存活并显示往返耗时。Socket.IO、MySQL、Redis 和 Worker 状态只在健康服务明确返回时展示。' },
  { heading: '运行边界', body: '健康页面不直接修改服务配置或任务状态；告警规则、依赖趋势和操作时间线须由服务端健康数据提供。' },
];
const activePath = computed(() => route.path === '/admin/system' ? '/admin/system-config' : route.path);
const page = computed(() => sections.find((item) => item.path === activePath.value) ?? sections[0]!);
const isConfig = computed(() => page.value.path === '/admin/system-config');
const isAdminUsers = computed(() => page.value.path === '/admin/admin-users');
const isAudit = computed(() => page.value.path === '/admin/audit');
const isJobs = computed(() => page.value.path === '/admin/jobs');
const isHealth = computed(() => page.value.path === '/admin/health');
const healthState = ref<'idle' | 'checking' | 'live' | 'unavailable'>('idle');
const healthCheckedAt = ref<string | null>(null);
const healthServerNow = ref<string | null>(null);
const healthLatencyMs = ref<number | null>(null);
let healthRequestId = 0;

async function checkHealth(): Promise<void> {
  const requestId = ++healthRequestId;
  healthState.value = 'checking';
  const startedAt = performance.now();
  try {
    const response = await getAdminHealth();
    if (requestId !== healthRequestId) return;
    healthState.value = 'live';
    healthServerNow.value = response.serverNow;
    healthLatencyMs.value = Math.round(performance.now() - startedAt);
  } catch {
    if (requestId !== healthRequestId) return;
    healthState.value = 'unavailable';
    healthServerNow.value = null;
    healthLatencyMs.value = null;
  } finally {
    if (requestId === healthRequestId) healthCheckedAt.value = new Date().toISOString();
  }
}

watch(isHealth, (active) => {
  if (active) void checkHealth();
  else healthRequestId += 1;
});
onBeforeUnmount(() => { healthRequestId += 1; });
const formattedHealthTime = (value: string | null) => value ? new Date(value).toLocaleString() : '尚未检查';
const auditEvents = ref<AdminAuditDto[]>([]);
const auditKeyword = ref('');
const auditAdminUserId = ref('');
const auditTargetUserId = ref('');
const auditActionCode = ref('');
const auditResultType = ref('');
const auditFrom = ref('');
const auditTo = ref('');
const auditPage = ref(1);
const auditTotal = ref(0);
const auditLoading = ref(false);
const auditError = ref('');
const selectedAudit = ref<AdminAuditDto | null>(null);
const auditPageSize = 25;
let auditRequestSequence = 0;
const auditActionLabels: Record<string, string> = {
  ADMIN_PERMISSIONS_UPDATED: 'Admin 权限变更', AGENT_DOMAIN_ACTION: '代理域审核', GAME_CATALOG_SAVED: '游戏目录变更',
  PAYMENT_CHANNEL_SAVED: '支付渠道变更', ANNOUNCEMENT_TEMPLATE_SAVED: '公告模板草稿', SOCIAL_MODERATION_DECIDED: '社区内容处置',
};

async function loadAdminAudit(page = 1): Promise<void> {
  const sequence = ++auditRequestSequence;
  auditLoading.value = true;
  auditError.value = '';
  const asUtc = (value: string): string | undefined => {
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  };
  const result = await localAdminAuditApplication.list({
    ...(auditKeyword.value.trim() ? { keyword: auditKeyword.value.trim() } : {}),
    ...(auditAdminUserId.value.trim() ? { adminUserId: auditAdminUserId.value.trim() } : {}),
    ...(auditTargetUserId.value.trim() ? { targetUserId: auditTargetUserId.value.trim() } : {}),
    ...(auditActionCode.value ? { actionCode: auditActionCode.value } : {}),
    ...(auditResultType.value ? { resultType: Number(auditResultType.value) } : {}),
    ...(auditFrom.value ? { fromCreatedAt: asUtc(auditFrom.value) } : {}),
    ...(auditTo.value ? { toCreatedAt: asUtc(auditTo.value) } : {}),
    page, pageSize: auditPageSize,
  });
  if (sequence !== auditRequestSequence) return;
  auditLoading.value = false;
  if (!result.ok) {
    auditEvents.value = [];
    auditTotal.value = 0;
    selectedAudit.value = null;
    auditError.value = result.code === 'INVALID_QUERY' ? '筛选条件无效，请检查 user ID 和时间范围。' : result.code === 'READ_FAILED' ? '读取本机审计记录失败，请重试。' : '审计记录不符合共享 DTO，已停止展示。';
    return;
  }
  auditEvents.value = result.value.items;
  auditTotal.value = result.value.total;
  auditPage.value = result.value.page;
  selectedAudit.value = null;
}

function resetAuditFilters(): void {
  auditKeyword.value = '';
  auditAdminUserId.value = '';
  auditTargetUserId.value = '';
  auditActionCode.value = '';
  auditResultType.value = '';
  auditFrom.value = '';
  auditTo.value = '';
  void loadAdminAudit(1);
}

watch(isAudit, (active) => {
  if (active) void loadAdminAudit(1);
  else { auditRequestSequence += 1; auditLoading.value = false; selectedAudit.value = null; }
});
onBeforeUnmount(() => { auditRequestSequence += 1; });
const permissionUsers = ref<AdminManagedUserDto[]>([]);
const permissionPaths = ref<AdminPermissionPathDto[]>([]);
const permissionAudits = ref<AdminPermissionAuditDto[]>([]);
const permissionKeyword = ref('');
const permissionStatus = ref('');
const permissionPathFilter = ref('');
const permissionPathSearch = ref('');
const selectedPermissionUserId = ref('');
const selectedPermissionCodes = ref<string[]>([]);
const permissionReason = ref('');
const permissionRequestKey = ref('');
const permissionLoading = ref(false);
const permissionSaving = ref(false);
const permissionReviewOpen = ref(false);
const permissionError = ref('');
const permissionFeedback = ref('');
const selectedPermissionUser = computed(() => permissionUsers.value.find((user) => user.userId === selectedPermissionUserId.value) ?? null);
const filteredPermissionPaths = computed(() => permissionPaths.value.filter((path) => path.status === AdminPermissionStatus.ACTIVE
  && (!permissionPathSearch.value.trim() || `${path.permissionCode} ${path.name} ${path.pathPattern}`.toLocaleLowerCase().includes(permissionPathSearch.value.trim().toLocaleLowerCase()))));
const permissionChanges = computed(() => {
  const current = new Set(selectedPermissionUser.value?.permissions ?? []);
  const next = new Set(selectedPermissionCodes.value);
  return {
    added: [...next].filter((code) => !current.has(code)),
    removed: [...current].filter((code) => !next.has(code)),
  };
});
const permissionErrorText: Record<string, string> = {
  INVALID_REQUEST: '请求不符合共享 DTO 或变更原因少于 3 个字。', USER_NOT_FOUND: 'Admin 账号已不存在，请重新查询。',
  USER_LOCKED: '该账号已锁定，不能修改权限。', UNKNOWN_PERMISSION: '权限目录已变化，请重新加载后选择。',
  NO_CHANGE: '权限没有变化，无需保存。', REQUEST_KEY_REUSED: '操作号已用于其他变更，请重新确认当前差异。',
  READ_FAILED: '读取本机 Admin 演练数据失败，请重试。', WRITE_FAILED: '保存未确认；可以用相同内容和操作号安全重试。',
};

async function loadPermissionWorkspace(): Promise<void> {
  permissionLoading.value = true;
  permissionError.value = '';
  const pathResult = localAdminPermissionApplication.listPaths();
  if (!pathResult.ok) { permissionError.value = permissionErrorText[pathResult.code] ?? '读取权限目录失败。'; permissionLoading.value = false; return; }
  permissionPaths.value = pathResult.value;
  const usersResult = await localAdminPermissionApplication.listUsers({
    ...(permissionKeyword.value.trim() ? { keyword: permissionKeyword.value.trim() } : {}),
    ...(permissionStatus.value ? { status: Number(permissionStatus.value) } : {}),
    ...(permissionPathFilter.value ? { permissionCode: permissionPathFilter.value } : {}),
  });
  permissionLoading.value = false;
  if (!usersResult.ok) { permissionError.value = permissionErrorText[usersResult.code] ?? '读取 Admin 账号失败。'; return; }
  permissionUsers.value = usersResult.value;
  if (!usersResult.value.some((user) => user.userId === selectedPermissionUserId.value)) {
    selectedPermissionUserId.value = usersResult.value[0]?.userId ?? '';
  }
  if (selectedPermissionUser.value) await selectPermissionUser(selectedPermissionUser.value);
  else { selectedPermissionCodes.value = []; permissionAudits.value = []; }
}

async function selectPermissionUser(user: AdminManagedUserDto): Promise<void> {
  selectedPermissionUserId.value = user.userId;
  selectedPermissionCodes.value = [...user.permissions];
  permissionReviewOpen.value = false;
  permissionReason.value = '';
  permissionRequestKey.value = '';
  permissionError.value = '';
  const result = await localAdminPermissionApplication.listAudits(user.userId);
  if (result.ok) permissionAudits.value = result.value;
  else { permissionAudits.value = []; permissionError.value = permissionErrorText[result.code] ?? '读取权限历史失败。'; }
}

function setPermission(code: string, checked: boolean): void {
  selectedPermissionCodes.value = checked
    ? [...new Set([...selectedPermissionCodes.value, code])].sort()
    : selectedPermissionCodes.value.filter((item) => item !== code);
  permissionRequestKey.value = '';
  permissionError.value = '';
  permissionFeedback.value = '';
}

function togglePermissionFromEvent(code: string, event: Event): void {
  setPermission(code, (event.currentTarget as HTMLInputElement).checked);
}

function resetPermissionDraft(): void {
  if (!selectedPermissionUser.value) return;
  selectedPermissionCodes.value = [...selectedPermissionUser.value.permissions];
  permissionRequestKey.value = '';
  permissionReason.value = '';
  permissionError.value = '';
  permissionFeedback.value = '';
  permissionReviewOpen.value = false;
}

function openPermissionReview(): void {
  permissionError.value = '';
  permissionFeedback.value = '';
  permissionRequestKey.value = globalThis.crypto.randomUUID();
  permissionReviewOpen.value = true;
}

async function savePermissionChange(): Promise<void> {
  if (!selectedPermissionUser.value || permissionSaving.value) return;
  permissionSaving.value = true;
  permissionError.value = '';
  const result = await localAdminPermissionApplication.updatePermissions({
    targetAdminUserId: selectedPermissionUser.value.userId,
    permissionCodes: selectedPermissionCodes.value,
    reason: permissionReason.value,
    requestKey: permissionRequestKey.value,
  });
  permissionSaving.value = false;
  if (!result.ok) {
    permissionError.value = permissionErrorText[result.code] ?? '权限变更失败，请重试。';
    if (result.code === 'REQUEST_KEY_REUSED') permissionRequestKey.value = globalThis.crypto.randomUUID();
    return;
  }
  permissionUsers.value = permissionUsers.value.map((user) => user.userId === result.value.user.userId ? result.value.user : user);
  selectedPermissionCodes.value = [...result.value.user.permissions];
  permissionAudits.value = [result.value.audit, ...permissionAudits.value.filter((audit) => audit.auditId !== result.value.audit.auditId)];
  permissionReviewOpen.value = false;
  permissionRequestKey.value = '';
  permissionReason.value = '';
  permissionFeedback.value = `本机权限演练已保存；auth_version 更新为 ${result.value.user.authVersion}，代表旧 Admin 会话应失效。`;
}

function permissionStatusLabel(status: number): string {
  return status === AdminManagedUserStatus.ACTIVE ? '启用' : '已锁定';
}

onMounted(() => {
  if (isAdminUsers.value) void loadPermissionWorkspace();
  if (isAudit.value) void loadAdminAudit(1);
});
watch(isAdminUsers, (active) => { if (active) void loadPermissionWorkspace(); });
</script>

<template>
  <section class="system-operations-page">
    <div class="system-operations-heading">
      <div><p class="eyebrow">系统设置与审计</p><h1>{{ page.title }}</h1><p>{{ isConfig ? '查看已确认的需求参考值，并在本机保存可恢复的配置草稿。' : '运维和权限操作按当前页面的访问范围处理。' }}</p></div>
    </div>
    <nav class="system-operations-tabs" aria-label="系统设置与审计工作区">
      <RouterLink v-for="section in sections" :key="section.path" :to="section.path" :class="{ active: page.path === section.path }">{{ section.title }}</RouterLink>
    </nav>
    <section v-if="!isHealth && !isConfig && !isAdminUsers && !isAudit" class="system-service-banner" role="status"><span>!</span><div><strong>暂无可展示的系统记录</strong><p>当前没有运维或审计记录可供查看。</p></div></section>

    <template v-if="isConfig">
      <SystemConfigWorkspace :application="localSystemConfigApplication" />
    </template>

    <template v-else-if="isAdminUsers">
      <section class="system-work-panel">
        <div class="system-panel-heading"><div><h2>统一 user 中的 Admin 账号</h2><p>只管理 `role_type` 含 ADMIN 的 user 权限 JSON；权限从登记目录选择，不创建独立 admin_user 或 Role。</p></div><span>本机 IndexedDB 演练</span></div>
        <form class="system-filter-grid admin-permission-filters" @submit.prevent="loadPermissionWorkspace"><label>user ID / 用户名<input v-model="permissionKeyword" placeholder="搜索本机演练账号" maxlength="80"></label><label>Admin 状态<select v-model="permissionStatus"><option value="">全部状态</option><option :value="String(AdminManagedUserStatus.ACTIVE)">启用</option><option :value="String(AdminManagedUserStatus.LOCKED)">已锁定</option></select></label><label>权限码<select v-model="permissionPathFilter"><option value="">全部权限</option><option v-for="path in permissionPaths" :key="path.permissionCode" :value="path.permissionCode">{{ path.permissionCode }}</option></select></label><button type="submit" :disabled="permissionLoading">{{ permissionLoading ? '查询中…' : '查询账号' }}</button></form>
        <p v-if="permissionError" class="system-inline-error" role="alert">{{ permissionError }} <button type="button" @click="loadPermissionWorkspace">重试</button></p>
        <p v-else-if="permissionFeedback" class="system-inline-success" role="status">{{ permissionFeedback }}</p>
        <div class="admin-permission-workspace">
          <aside class="admin-permission-user-list" aria-label="Admin 账号查询结果">
            <p v-if="permissionLoading" role="status">正在读取本机演练账号…</p>
            <p v-else-if="!permissionUsers.length" class="system-empty-state">没有匹配的本机 Admin 账号；清除筛选后重试。</p>
            <button v-for="user in permissionUsers" :key="user.userId" type="button" :class="['admin-permission-user', { selected: selectedPermissionUserId === user.userId }]" @click="selectPermissionUser(user)">
              <strong>{{ user.username }}</strong><small>user_id {{ user.userId }} · {{ permissionStatusLabel(user.status) }}</small><span>{{ user.permissions.length }} 项权限 · auth_version {{ user.authVersion }}</span><i>{{ user.source===AdminPermissionSource.LOCAL_DEMO ? 'LOCAL_DEMO' : 'SERVER' }}</i>
            </button>
          </aside>
          <section v-if="selectedPermissionUser" class="admin-permission-detail">
            <div class="admin-permission-detail-heading"><div><h3>{{ selectedPermissionUser.username }}</h3><p>user_id {{ selectedPermissionUser.userId }} · 权限列表保存在统一 user.permissions JSON</p></div><span :class="selectedPermissionUser.status===AdminManagedUserStatus.ACTIVE?'is-active':'is-locked'">{{ permissionStatusLabel(selectedPermissionUser.status) }}</span></div>
            <label class="admin-permission-path-search">筛选登记权限<input v-model="permissionPathSearch" placeholder="权限码、名称或 API path" maxlength="128"></label>
            <div v-if="selectedPermissionUser.status!==AdminManagedUserStatus.ACTIVE" class="system-inline-warning">账号已锁定，只读查看权限；解锁属于独立账号安全流程。</div>
            <div class="admin-permission-path-list" aria-label="已登记的 HTTP 权限目录">
              <label v-for="path in filteredPermissionPaths" :key="path.permissionCode" class="admin-permission-path-row" :class="{ assigned:selectedPermissionCodes.includes(path.permissionCode) }">
                <input type="checkbox" :checked="selectedPermissionCodes.includes(path.permissionCode)" :disabled="selectedPermissionUser.status!==AdminManagedUserStatus.ACTIVE || permissionSaving" @change="togglePermissionFromEvent(path.permissionCode, $event)">
                <span><strong>{{ path.name }}</strong><code>{{ path.permissionCode }}</code><small>{{ path.httpMethod }} {{ path.pathPattern }}</small></span>
              </label>
              <p v-if="!filteredPermissionPaths.length" class="system-empty-state">没有匹配的已启用 permission path。</p>
            </div>
            <div class="admin-permission-pending-summary"><strong>当前差异</strong><span>新增 {{ permissionChanges.added.length }} 项</span><span>撤销 {{ permissionChanges.removed.length }} 项</span></div>
            <div class="system-panel-actions"><button type="button" :disabled="permissionChanges.added.length+permissionChanges.removed.length===0 || selectedPermissionUser.status!==AdminManagedUserStatus.ACTIVE" @click="resetPermissionDraft">放弃本次修改</button><button class="system-primary-action" type="button" :disabled="permissionChanges.added.length+permissionChanges.removed.length===0 || selectedPermissionUser.status!==AdminManagedUserStatus.ACTIVE" @click="openPermissionReview">审阅并保存</button></div>
            <section class="admin-permission-audit"><h4>不可变权限审计</h4><p v-if="!permissionAudits.length">该账号暂无本机权限变更记录。</p><article v-for="audit in permissionAudits" :key="audit.auditId"><strong>{{ audit.action===AdminPermissionAction.PERMISSIONS_UPDATED?'权限列表变更':audit.action }}</strong><time>{{ new Date(audit.createdAt).toLocaleString() }}</time><span>{{ audit.reason }}</span><small>{{ audit.previousPermissions.length }} → {{ audit.nextPermissions.length }} 项 · auth_version {{ audit.previousAuthVersion }} → {{ audit.nextAuthVersion }}</small></article></section>
          </section>
          <section v-else class="admin-permission-detail system-empty-state"><strong>选择一个 Admin 账号</strong><p>账号权限和审计历史将在此显示。</p></section>
        </div>
        <p class="system-inline-warning">权限授予/撤销在同一事务中递增目标 user 的 auth_version 并追加审计，目标旧 Admin session 应失效。TOTP 自愿启用；本页不修改 TOTP，也不重置凭证。</p>
        <div v-if="permissionReviewOpen && selectedPermissionUser" class="system-confirm-backdrop" role="presentation" @click.self="permissionReviewOpen=false">
          <form class="system-confirm-dialog admin-permission-confirm" role="dialog" aria-modal="true" aria-labelledby="admin-permission-confirm-title" @submit.prevent="savePermissionChange">
            <p class="eyebrow">授权影响确认</p><h2 id="admin-permission-confirm-title">确认更新 Admin 权限</h2><p>{{ selectedPermissionUser.username }} 的旧会话将在 auth_version 更新后失效。</p>
            <section v-if="permissionChanges.added.length"><strong>将新增</strong><ul><li v-for="code in permissionChanges.added" :key="code">{{ permissionPaths.find((path)=>path.permissionCode===code)?.name }} · {{ code }}</li></ul></section>
            <section v-if="permissionChanges.removed.length"><strong>将撤销</strong><ul><li v-for="code in permissionChanges.removed" :key="code">{{ permissionPaths.find((path)=>path.permissionCode===code)?.name }} · {{ code }}</li></ul></section>
            <label>变更原因<input v-model="permissionReason" minlength="3" maxlength="500" required placeholder="至少 3 个字，写明授权依据"></label>
            <p v-if="permissionError" class="system-inline-error" role="alert">{{ permissionError }}</p>
            <div class="system-panel-actions"><button type="button" :disabled="permissionSaving" @click="permissionReviewOpen=false">返回修改</button><button class="system-primary-action" type="submit" :disabled="permissionSaving || permissionReason.trim().length<3">{{ permissionSaving?'保存中…':'确认授权变更' }}</button></div>
          </form>
        </div>
      </section>
    </template>

    <template v-else-if="isAudit">
      <section class="system-work-panel">
        <div class="system-panel-heading"><div><h2>不可变操作审计</h2><p>只读聚合已闭环本机流程的审计事实，不编辑、删除或覆盖原始记录；草稿保存不计作生产配置变更。</p></div><span>本机审计投影</span></div>
        <form class="system-filter-grid audit-filters active-audit-filters" @submit.prevent="loadAdminAudit(1)">
          <label>关键字<input v-model="auditKeyword" maxlength="100" placeholder="原因、动作、资源或 request ID"></label>
          <label>操作者 user ID<input v-model="auditAdminUserId" inputmode="numeric" maxlength="20" placeholder="完整 ID"></label>
          <label>目标 user ID<input v-model="auditTargetUserId" inputmode="numeric" maxlength="20" placeholder="完整 ID"></label>
          <label>操作类型<select v-model="auditActionCode"><option value="">全部操作</option><option v-for="(label,code) in auditActionLabels" :key="code" :value="code">{{ label }}</option></select></label>
          <label>结果<select v-model="auditResultType"><option value="">全部结果</option><option :value="String(AdminAuditResultType.SUCCESS)">成功</option><option :value="String(AdminAuditResultType.DENIED)">拒绝</option><option :value="String(AdminAuditResultType.FAILED)">失败</option></select></label>
          <label>开始时间<input v-model="auditFrom" type="datetime-local"></label>
          <label>结束时间<input v-model="auditTo" type="datetime-local"></label>
          <span class="system-panel-actions"><button type="button" @click="resetAuditFilters">清空</button><button class="system-primary-action" type="submit" :disabled="auditLoading">{{ auditLoading?'查询中…':'查询审计' }}</button></span>
        </form>
        <p v-if="auditError" class="system-inline-error" role="alert">{{ auditError }} <button type="button" @click="loadAdminAudit(auditPage)">重试</button></p>
        <div v-if="auditLoading" class="system-empty-state" role="status"><strong>正在读取审计记录…</strong></div>
        <div v-else-if="!auditEvents.length" class="system-empty-state"><span>≋</span><strong>没有匹配的本机审计记录</strong><p>操作成功保存后，其领域审计会进入此只读列表；系统配置候选草稿不会作为生产变更显示。</p></div>
        <div v-else class="admin-audit-table-wrap"><table class="admin-audit-table"><thead><tr><th>时间</th><th>操作者</th><th>操作</th><th>目标 / 资源</th><th>结果</th><th>查看</th></tr></thead><tbody><tr v-for="event in auditEvents" :key="event.auditId"><td>{{ new Date(event.createdAt).toLocaleString() }}</td><td>{{ event.adminDisplayName }}<small>{{ event.adminUserId }}</small></td><td>{{ auditActionLabels[event.actionCode] }}<small>{{ event.actionCode }}</small></td><td>{{ event.resourceType }}<small>{{ event.targetUserId ? `目标 user ${event.targetUserId}` : event.resourceKey }}</small></td><td><span class="admin-audit-result">{{ event.resultType===AdminAuditResultType.SUCCESS?'成功':event.resultType===AdminAuditResultType.DENIED?'拒绝':'失败' }}</span></td><td><button type="button" @click="selectedAudit=event">详情</button></td></tr></tbody></table></div>
        <div v-if="auditTotal" class="admin-audit-pagination"><span>共 {{ auditTotal }} 条 · 第 {{ auditPage }} / {{ Math.max(1,Math.ceil(auditTotal/auditPageSize)) }} 页</span><span><button type="button" :disabled="auditPage<=1 || auditLoading" @click="loadAdminAudit(auditPage-1)">上一页</button><button type="button" :disabled="auditPage* auditPageSize>=auditTotal || auditLoading" @click="loadAdminAudit(auditPage+1)">下一页</button></span></div>
        <p class="system-inline-warning">LOCAL_DEMO 结果仅用于浏览器流程验收；访问来源 IP、真实 HTTP 路由授权与生产 Admin 审计由服务端记录。</p>
      </section>
      <div v-if="selectedAudit" class="system-confirm-backdrop" role="presentation" @click.self="selectedAudit=null"><section class="system-confirm-dialog admin-audit-detail" role="dialog" aria-modal="true" aria-labelledby="admin-audit-detail-title"><button class="system-config-close" type="button" aria-label="关闭审计详情" @click="selectedAudit=null">×</button><p class="eyebrow">不可变审计详情</p><h2 id="admin-audit-detail-title">{{ auditActionLabels[selectedAudit.actionCode] }}</h2><dl><div><dt>审计 ID</dt><dd>{{ selectedAudit.auditId }}</dd></div><div><dt>操作者</dt><dd>{{ selectedAudit.adminDisplayName }} · {{ selectedAudit.adminUserId }}</dd></div><div><dt>目标 / 资源</dt><dd>{{ selectedAudit.resourceType }} · {{ selectedAudit.resourceKey }}<template v-if="selectedAudit.targetUserId"> · user {{ selectedAudit.targetUserId }}</template></dd></div><div><dt>Request ID</dt><dd>{{ selectedAudit.requestId ?? '无' }}</dd></div><div><dt>时间 / 结果</dt><dd>{{ new Date(selectedAudit.createdAt).toLocaleString() }} · {{ selectedAudit.resultType===AdminAuditResultType.SUCCESS?'成功':selectedAudit.resultType===AdminAuditResultType.DENIED?'拒绝':'失败' }}</dd></div><div><dt>操作理由</dt><dd>{{ selectedAudit.reason }}</dd></div><div><dt>变更前摘要</dt><dd>{{ selectedAudit.beforeSummary ?? '无' }}</dd></div><div><dt>变更后摘要</dt><dd>{{ selectedAudit.afterSummary ?? '无' }}</dd></div></dl><button class="system-primary-action" type="button" @click="selectedAudit=null">关闭</button></section></div>
    </template>

    <template v-else-if="isJobs">
      <section class="system-work-panel">
        <div class="system-panel-heading"><div><h2>Outbox 与后台任务</h2><p>查看积压、失败和租约；重试保持 event key 幂等，不编辑 payload 或业务事实。</p></div><button type="button" disabled>重试失败任务</button></div>
        <div class="system-filter-grid jobs-filters"><label>topic / consumer<input disabled placeholder="按任务类型或消费者过滤"></label><label>任务状态<select disabled><option>全部状态</option></select></label><label>最早时间<input disabled placeholder="最早积压时间"></label><button type="button" disabled>查询任务</button></div>
        <div class="system-empty-state"><span>↻</span><strong>暂无可读取的任务状态</strong><p>失败详情仅展示脱敏错误码与安全 payload 摘要。死信、取消和重试均需独立权限、原因和审计；不得把 Redis 临时状态当作数据库业务事实。</p></div>
        <p class="system-inline-warning">当前没有任务数据，不能推测队列正常或积压为零。</p>
      </section>
    </template>

    <template v-else>
      <section class="system-health-panel">
        <div class="system-panel-heading"><div><h2>服务与依赖状态</h2><p>查看 Admin HTTP API 状态与探测耗时。</p></div><div class="system-panel-actions"><PageHelpOverlay title="服务健康数据范围" trigger-label="查看服务健康数据范围" :sections="healthHelp" /><button type="button" :disabled="healthState === 'checking'" @click="checkHealth">{{ healthState === 'checking' ? '检查中…' : '重新检查' }}</button></div></div>
        <div class="system-health-grid">
          <article class="health-api-card" :class="`health-${healthState}`" aria-live="polite"><span></span><strong>Admin HTTP API</strong><small>{{ healthState === 'live' ? '存活' : healthState === 'checking' ? '检查中' : healthState === 'unavailable' ? '不可达' : '未检查' }}</small><p>请求耗时：{{ healthLatencyMs === null ? '—' : `${healthLatencyMs} ms` }} · 服务时间：{{ formattedHealthTime(healthServerNow) }}</p></article>
          <article v-for="service in ['游戏 Socket.IO', 'MySQL', 'Redis', 'Worker / Outbox']" :key="service"><span></span><strong>{{ service }}</strong><small>未知</small><p>当前 Health API 不提供此依赖的探测数据</p></article>
        </div>
        <p class="system-health-sample">最近检查：{{ formattedHealthTime(healthCheckedAt) }}。API 只提供实时存活探针，不提供历史趋势或依赖告警。</p>
        <div v-if="healthState === 'unavailable'" class="system-inline-warning" role="alert">健康接口未返回有效响应。请确认 API 地址和服务状态后重试；不会据此推断数据库或其他依赖状态。</div>
      </section>
    </template>
  </section>
</template>
