<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { NotificationSource, type NotificationSummaryItemDto, type NotificationSummaryResponseDto } from '@gameing/contracts/notifications';
import type { NotificationSummaryApplication } from '../platform/notifications/notification-summary-application';

const props = defineProps<{ application: NotificationSummaryApplication; authenticated: boolean }>();
const emit = defineEmits<{ open: [item: NotificationSummaryItemDto]; login: [] }>();
const snapshot = ref<NotificationSummaryResponseDto>();
const loading = ref(false);
const error = ref('');

const sourceLabel: Record<string, string> = {
  [NotificationSource.ANNOUNCEMENT]: '平台公告',
  [NotificationSource.WALLET]: '资产记录',
  [NotificationSource.SUPPORT]: '客服会话',
  [NotificationSource.SOCIAL_FRIEND_REQUEST]: '好友申请',
};

async function reload(): Promise<void> {
  loading.value = true; error.value = '';
  try { snapshot.value = await props.application.load(props.authenticated); }
  catch { error.value = '消息暂时无法读取，请检查连接后重试。'; }
  finally { loading.value = false; }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

watch(() => props.authenticated, () => { void reload(); });
onMounted(() => { void reload(); });
</script>

<template>
  <section class="player-notifications-workspace" aria-label="消息与事项">
    <header><p>公告、资产变动、客服会话与好友申请由各自的业务来源提供。</p><button type="button" :disabled="loading" @click="reload">{{ loading ? '正在更新…' : '刷新' }}</button></header>
    <p v-if="error" class="social-workspace-error" role="alert">{{ error }} <button type="button" @click="reload">重试</button></p>
    <div v-if="loading && !snapshot" class="social-workspace-state" role="status">正在读取消息…</div>
    <div v-else-if="snapshot?.unavailableSources.length" class="notification-source-warning" role="status">部分来源暂时无法读取：{{ snapshot.unavailableSources.map((source) => sourceLabel[source]).join('、') }}。<button type="button" :disabled="loading" @click="reload">重试</button></div>
    <div v-if="snapshot?.items.length" class="notification-items" aria-label="消息列表">
      <button v-for="item in snapshot.items" :key="item.itemId" class="notification-item" type="button" @click="emit('open', item)">
        <span class="notification-item-source">{{ sourceLabel[item.source] }}</span><span class="notification-item-copy"><strong>{{ item.title }}</strong><small>{{ item.summary }}</small></span><time :datetime="item.occurredAt">{{ formatTime(item.occurredAt) }}</time><span class="notification-item-arrow" aria-hidden="true">›</span>
      </button>
    </div>
    <div v-else-if="!loading && !snapshot?.unavailableSources.length" class="player-panel-empty player-panel-empty-large"><span aria-hidden="true">✉</span><strong>暂时没有新事项</strong><p>{{ authenticated ? '新的公告、资产变动和业务状态会显示在这里。' : '登录后还可查看资产、客服与社交事项。' }}</p><button v-if="!authenticated" type="button" @click="emit('login')">登录 / 恢复账号</button></div>
    <p class="notification-source-note">此处聚合来源记录，不单独创建通知副本或统一已读状态。</p>
  </section>
</template>
