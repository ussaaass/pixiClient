<script setup lang="ts">
import { computed } from 'vue';
import {
  PlatformAnnouncementKind,
  PlatformAnnouncementStatus,
} from '@gameing/contracts/platform-events/announcement';
import type { PlatformAnnouncementDetail } from '@gameing/contracts/platform-events/announcement';
import { announcementCopy, announcementScopeLabel } from '../platform/announcement-presentation';

const props = defineProps<{
  detail: PlatformAnnouncementDetail | null;
  loading: boolean;
  unavailable: boolean;
}>();

const emit = defineEmits<{ retry: []; back: [] }>();
const copy = computed(() => props.detail ? announcementCopy(props.detail.announcement) : undefined);

function statusLabel(status: PlatformAnnouncementDetail['status']): string {
  if (status === PlatformAnnouncementStatus.ACTIVE) return '进行中';
  if (status === PlatformAnnouncementStatus.DRAINING) return '停止新增参与';
  if (status === PlatformAnnouncementStatus.EXPIRED) return '已到期';
  if (status === PlatformAnnouncementStatus.EXHAUSTED) return '奖池已耗尽';
  return '已取消';
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value}`;
}
</script>

<template>
  <main class="platform-announcement-detail">
    <header class="announcement-detail-header">
      <button class="back-button" type="button" @click="emit('back')">‹ 返回大厅</button>
      <span>LOTTERY GAME · 活动公告</span>
    </header>
    <article v-if="detail && copy" class="announcement-detail-card">
      <div class="announcement-detail-meta">
        <span :class="detail.kind === PlatformAnnouncementKind.EFFECT ? 'effect' : 'broadcast'">
          {{ detail.kind === PlatformAnnouncementKind.EFFECT ? '活动效果' : '仅事件播报' }}
        </span>
        <span>{{ statusLabel(detail.status) }}</span>
      </div>
      <h1>{{ copy.title }}</h1>
      <p class="announcement-detail-message">{{ copy.message }}</p>
      <dl class="announcement-detail-facts">
        <div><dt>适用范围</dt><dd>{{ detail.announcement.scope.map(announcementScopeLabel).join(' / ') }}</dd></div>
        <div><dt>开始时间（UTC）</dt><dd>{{ detail.announcement.startsAt }}</dd></div>
        <div><dt>原定结束时间（UTC）</dt><dd>{{ detail.announcement.expiresAt }}</dd></div>
        <div v-if="detail.endedAt"><dt>实际结束时间（UTC）</dt><dd>{{ detail.endedAt }}</dd></div>
        <div><dt>规则版本</dt><dd>{{ detail.rulesVersion }}</dd></div>
        <div><dt>公告版本</dt><dd>{{ detail.announcement.stateVersion }}</dd></div>
      </dl>
      <section v-if="detail.kind === PlatformAnnouncementKind.EFFECT" class="announcement-effect-targets" aria-label="当前活动效果">
        <h2>活动效果快照</h2>
        <article v-for="(target, index) in detail.effectTargets" :key="`${target.scopeLabel}-${index}`">
          <h3>{{ target.scopeLabel }}</h3>
          <p>{{ target.summary }}</p>
          <dl>
            <div v-if="target.probabilityDeltaPoints !== undefined"><dt>中奖概率变化</dt><dd>{{ signed(target.probabilityDeltaPoints) }} 个百分点</dd></div>
            <div v-if="target.payoutDeltaPercent !== undefined"><dt>派奖额度变化</dt><dd>{{ signed(target.payoutDeltaPercent) }}%</dd></div>
            <div v-if="target.poolRemaining !== undefined"><dt>奖池剩余</dt><dd>{{ target.poolRemaining }} {{ target.poolUnit }}</dd></div>
            <div v-if="target.seat"><dt>真实参与席位</dt><dd>{{ target.seat.occupied }} / {{ target.seat.capacity }}</dd></div>
          </dl>
        </article>
      </section>
      <p v-else class="announcement-broadcast-note">此公告只说明事件发生，不代表游戏概率或派奖规则发生变化。</p>
      <p class="announcement-data-note">活动状态与效果来自服务端快照；页面不推算或预测后续结果。</p>
    </article>
    <section v-else class="announcement-detail-state" role="status" aria-live="polite">
      <span class="announcement-detail-mark" aria-hidden="true">{{ loading ? '…' : 'i' }}</span>
      <h1>{{ loading ? '正在读取活动公告' : '活动详情暂不可用' }}</h1>
      <p>{{ loading ? '正在从活动服务读取当前快照。' : '活动服务暂未返回可验证的公告快照，请稍后重试。' }}</p>
      <button v-if="unavailable" class="panel-primary" type="button" @click="emit('retry')">重新读取</button>
    </section>
  </main>
</template>
