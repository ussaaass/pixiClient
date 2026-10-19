<script setup lang="ts">
import { ElSelect } from 'element-plus';
import AdminSelectOption from '../components/AdminSelectOption.vue';
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  AdminUserRoleType,
  AdminUserSource,
  AdminUserStatus,
  type AdminUserSummaryDto,
} from '@gameing/admin-contracts/admin-users';
import { localDemoAdminUserApplication } from '../platform/admin-users/composition';

const userId = ref('');
const username = ref('');
const roleType = ref('');
const status = ref('');
const users = ref<AdminUserSummaryDto[]>([]);
const total = ref(0);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const error = ref('');
const searched = ref(false);

function roleLabel(value: number): string { return value === AdminUserRoleType.PLAYER_AGENT ? '玩家 / 代理' : '普通玩家'; }
function statusLabel(value: number): string { return value === AdminUserStatus.ACTIVE ? '正常' : value === AdminUserStatus.DISABLED ? '已停用' : '已关闭'; }

async function searchUsers(cursor?: string): Promise<void> {
  loading.value = true;
  error.value = '';
  searched.value = true;
  const query = {
    ...(userId.value.trim() ? { userId: userId.value.trim() } : {}),
    ...(username.value.trim() ? { username: username.value.trim() } : {}),
    ...(roleType.value ? { roleType: Number(roleType.value) } : {}),
    ...(status.value ? { status: Number(status.value) } : {}),
    ...(cursor ? { cursor } : {}),
    pageSize: 20,
  };
  const result = await localDemoAdminUserApplication.list(query);
  loading.value = false;
  if (!result.ok) {
    users.value = [];
    total.value = 0;
    nextCursor.value = null;
    error.value = result.code === 'INVALID_QUERY' ? '筛选条件无效。用户 ID 必须是 1 到 18446744073709551615 之间的完整十进制字符串。' : '演练用户目录暂时无法读取，请重试。';
    return;
  }
  users.value = cursor ? [...users.value, ...result.value.items] : result.value.items;
  total.value = result.value.total;
  nextCursor.value = result.value.nextCursor;
}

function resetFilters(): void {
  userId.value = '';
  username.value = '';
  roleType.value = '';
  status.value = '';
  void searchUsers();
}

onMounted(() => { void searchUsers(); });
</script>

<template>
  <section class="domain-page user-list-page">
    <div class="domain-heading"><p class="eyebrow">用户与代理</p><h1>用户列表</h1><p>按公开账号标识检索，并从独立详情分区读取安全、关系和业务记录。</p></div>

    <section class="user-filter-panel" aria-labelledby="user-filter-heading">
      <div class="user-filter-heading"><div><h2 id="user-filter-heading">筛选用户</h2><p>账号列表只返回公开摘要；邮箱和手机始终掩码显示。</p></div><span class="local-demo-pill">本机演练数据</span></div>
      <form class="user-filter-grid" @submit.prevent="searchUsers()">
        <label class="user-filter-field"><span>用户 ID</span><input v-model="userId" type="text" inputmode="numeric" autocomplete="off" maxlength="20" placeholder="输入完整用户 ID"></label>
        <label class="user-filter-field"><span>公开用户名</span><input v-model="username" type="text" autocomplete="off" maxlength="64" placeholder="精确或部分匹配"></label>
        <label class="user-filter-field"><span>角色</span><el-select v-model="roleType"><AdminSelectOption value="">全部角色</AdminSelectOption><AdminSelectOption :value="String(AdminUserRoleType.PLAYER)">普通玩家</AdminSelectOption><AdminSelectOption :value="String(AdminUserRoleType.PLAYER_AGENT)">玩家 / 代理</AdminSelectOption></el-select></label>
        <label class="user-filter-field"><span>状态</span><el-select v-model="status"><AdminSelectOption value="">全部状态</AdminSelectOption><AdminSelectOption :value="String(AdminUserStatus.ACTIVE)">正常</AdminSelectOption><AdminSelectOption :value="String(AdminUserStatus.DISABLED)">已停用</AdminSelectOption><AdminSelectOption :value="String(AdminUserStatus.CLOSED)">已关闭</AdminSelectOption></el-select></label>
        <div class="user-filter-actions"><button type="button" :disabled="loading" @click="resetFilters">清空</button><button class="user-search-button" type="submit" :disabled="loading">{{ loading ? '查询中…' : '查询' }}</button></div>
      </form>
    </section>

    <section class="user-results-panel" aria-labelledby="user-results-heading">
      <div class="user-results-heading"><div><h2 id="user-results-heading">用户记录</h2><p>游标分页 · 点击详情查看分区数据</p></div><span class="record-count">{{ loading ? '读取中…' : `${total} 条本机演练样例` }}</span></div>
      <p v-if="error" class="user-query-error" role="alert">{{ error }} <button type="button" :disabled="loading" @click="searchUsers()">重试</button></p>
      <div v-else-if="loading && !users.length" class="user-empty-state" role="status"><strong>正在读取演练用户…</strong></div>
      <div v-else-if="!users.length" class="user-empty-state" role="status"><span class="user-empty-icon" aria-hidden="true">⌕</span><strong>{{ searched ? '没有匹配用户' : '暂无用户记录' }}</strong><p>清除筛选条件后重试。生产环境将由服务端按权限返回真实用户摘要。</p><button v-if="userId || username || roleType || status" type="button" @click="resetFilters">清除筛选</button></div>
      <template v-else>
        <div class="user-table-wrap">
          <table>
            <caption>用户查询结果</caption>
            <thead><tr><th scope="col">用户 ID</th><th scope="col">公开用户名</th><th scope="col">角色</th><th scope="col">直属上级</th><th scope="col">创建时间</th><th scope="col">状态</th><th scope="col">来源 / 操作</th></tr></thead>
            <tbody><tr v-for="user in users" :key="user.userId"><td><code>{{ user.userId }}</code></td><td><strong>{{ user.nickname }}</strong><small>{{ user.username ?? '未设置用户名' }}</small></td><td>{{ roleLabel(user.roleType) }}</td><td>{{ user.parent1UserId ?? '无' }}</td><td>{{ new Date(user.createdAt).toLocaleDateString() }}</td><td><span :class="['user-status-pill', { inactive: user.status !== AdminUserStatus.ACTIVE }]">{{ statusLabel(user.status) }}</span></td><td><span class="local-demo-tag">{{ user.source === AdminUserSource.LOCAL_DEMO ? 'LOCAL_DEMO' : 'SERVER' }}</span><RouterLink class="user-row-detail" :to="`/admin/users/${user.userId}`">详情</RouterLink></td></tr></tbody>
          </table>
        </div>
        <div class="user-mobile-results"><RouterLink v-for="user in users" :key="user.userId" class="user-mobile-card" :to="`/admin/users/${user.userId}`"><span><strong>{{ user.nickname }}</strong><small>user_id {{ user.userId }} · {{ user.username ?? '未设置用户名' }}</small></span><span>{{ roleLabel(user.roleType) }} · {{ statusLabel(user.status) }}</span><small>直属上级 {{ user.parent1UserId ?? '无' }} · LOCAL_DEMO</small><b aria-hidden="true">详情 →</b></RouterLink></div>
        <div v-if="nextCursor" class="user-pagination"><span>当前显示 {{ users.length }} / {{ total }} 条</span><button type="button" :disabled="loading" @click="searchUsers(nextCursor)">{{ loading ? '加载中…' : '加载更多' }}</button></div>
      </template>
    </section>

    <div class="user-list-footnote"><span aria-hidden="true">i</span><p>本页样例数据仅用于离线交互验收，不代表真实玩家。列表不显示联系方式、TOTP、设备指纹、恢复码或支付敏感资料；详情区也不会返回认证秘密。</p></div>
    <RouterLink to="/admin/overview" class="back-link">← 返回运营总览</RouterLink>
  </section>
</template>
