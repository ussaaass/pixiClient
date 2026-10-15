<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PlatformAnnouncement } from '@gameing/contracts/platform-events/announcement';
import { PlatformAnnouncementKind } from '@gameing/contracts/platform-events/announcement';
import { announcementCopy, announcementScopeLabel } from '../platform/announcement-presentation';

const props = defineProps<{
  announcements: readonly PlatformAnnouncement[];
}>();

const emit = defineEmits<{ open: [announcementId: string] }>();
const currentIndex = ref(0);
const collapsed = ref(false);
const muted = ref(false);
const currentAnnouncements = computed(() => props.announcements);
const currentAnnouncement = computed(() => currentAnnouncements.value[currentIndex.value]);
const currentCopy = computed(() => currentAnnouncement.value ? announcementCopy(currentAnnouncement.value) : undefined);

watch(currentAnnouncements, (items) => {
  if (currentIndex.value >= items.length) currentIndex.value = Math.max(0, items.length - 1);
});

function moveAnnouncement(offset: number): void {
  const count = currentAnnouncements.value.length;
  if (count < 2) return;
  currentIndex.value = (currentIndex.value + offset + count) % count;
}
</script>

<template>
  <section
    v-if="currentAnnouncement"
    class="platform-announcement-bar"
    :class="{ collapsed, muted }"
    aria-label="平台活动公告"
  >
    <template v-if="currentAnnouncement && currentCopy">
      <span class="announcement-indicator" aria-hidden="true">{{ currentAnnouncement.kind === PlatformAnnouncementKind.EFFECT ? '↗' : 'i' }}</span>
      <div v-if="!muted" class="announcement-copy">
        <span class="announcement-kind">{{ currentAnnouncement.kind === PlatformAnnouncementKind.EFFECT ? '活动效果' : '仅事件播报' }}</span>
        <button v-if="currentAnnouncement.clickAction" type="button" class="announcement-open" @click="emit('open', currentAnnouncement.clickAction.params.announcementId)">
          <strong>{{ currentCopy.title }}</strong>
          <span v-if="!collapsed">{{ currentCopy.message }}</span>
          <span class="announcement-scope">{{ currentAnnouncement.scope.map(announcementScopeLabel).join(' / ') }}</span>
        </button>
        <div v-else class="announcement-open announcement-static">
          <strong>{{ currentCopy.title }}</strong>
          <span v-if="!collapsed">{{ currentCopy.message }}</span>
          <span class="announcement-scope">{{ currentAnnouncement.scope.map(announcementScopeLabel).join(' / ') }}</span>
        </div>
      </div>
      <span v-else class="announcement-muted-copy">活动播报已静音</span>
      <div class="announcement-controls">
        <template v-if="currentAnnouncements.length > 1">
          <button type="button" aria-label="上一条活动公告" @click="moveAnnouncement(-1)">‹</button>
          <span>{{ currentIndex + 1 }}/{{ currentAnnouncements.length }}</span>
          <button type="button" aria-label="下一条活动公告" @click="moveAnnouncement(1)">›</button>
        </template>
        <button type="button" :aria-label="collapsed ? '展开公告' : '折叠公告'" @click="collapsed = !collapsed">{{ collapsed ? '展开' : '折叠' }}</button>
        <button type="button" :aria-pressed="muted" :aria-label="muted ? '取消静音' : '静音公告'" @click="muted = !muted">{{ muted ? '取消静音' : '静音' }}</button>
      </div>
    </template>
  </section>
</template>
