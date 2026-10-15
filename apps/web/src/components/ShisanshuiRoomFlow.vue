<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { RoomDifficultyKey, GameRoomSnapshotDto } from '@gameing/contracts/game-room';
import type { RoomApplication, RoomApplicationFailureCode } from '../platform/rooms/room-application';

const props = defineProps<{
  application: RoomApplication;
  difficultyKey: RoomDifficultyKey;
  difficultyLabel: string;
}>();
const emit = defineEmits<{
  close: [];
  practice: [];
  start: [snapshot: GameRoomSnapshotDto];
}>();

const stage = ref<'entry' | 'join' | 'room'>('entry');
const snapshot = ref<GameRoomSnapshotDto | null>(null);
const joinableRooms = ref<GameRoomSnapshotDto[]>([]);
const matchingJoinableRooms = computed(() => joinableRooms.value.filter((room) => room.difficultyKey === props.difficultyKey));
const leaveConfirmation = computed(() => {
  const room = snapshot.value;
  const current = room?.members.find((member) => member.isCurrentPlayer);
  return current?.seat === room?.ownerSeat
    ? '离开后本地练习房会关闭；牌局尚未开始，不会产生游戏结果。'
    : '离开后只释放你的本地座位，房间里的其他练习参与者会保留。';
});
const roomCode = ref('');
const roomPassword = ref('');
const createPassword = ref('');
const error = ref('');
const busy = ref(false);
const leaving = ref(false);

const failureCopy: Record<RoomApplicationFailureCode, string> = {
  INVALID_REQUEST: '输入信息有误，请检查后重试。',
  ROOM_NOT_FOUND: '没有找到可加入的练习房。你可以核对房号，或创建新房间。',
  INVALID_PASSWORD: '房间密码不正确，请重新输入。',
  DUPLICATE_ROOM_CODE: '房间号正在使用，请重新创建。',
  ROOM_CLOSED: '房间已结束，请重新选择入口。',
  ROOM_FULL: '房间座位已满，请选择其他房间。',
  PLAYER_ALREADY_SEATED: '当前演练身份已在房间中。',
  PLAYER_NOT_FOUND: '没有找到当前座位，请返回并重新加入。',
  ROOM_NOT_READY: '请等待四个座位全部准备后再开始。',
  ROOM_OWNER_REQUIRED: '只有房主可以开始或关闭这间练习房。',
};
const roomPanel = ref<HTMLElement | null>(null);
let returnFocusTarget: HTMLElement | null = null;
let previousPageScroll: {
  y: number;
  htmlOverflow: string;
  bodyOverflow: string;
  bodyPosition: string;
  bodyTop: string;
  bodyLeft: string;
  bodyRight: string;
  bodyWidth: string;
} | undefined;

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (stage.value === 'room') leaving.value = !leaving.value;
    else if (stage.value === 'join') stage.value = 'entry';
    else emit('close');
    return;
  }
  if (event.key !== 'Tab' || !roomPanel.value) return;
  const focusable = Array.from(roomPanel.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ));
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) {
    event.preventDefault();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function refreshRooms(): Promise<void> {
  joinableRooms.value = await props.application.listJoinableRooms();
}

async function runRoomAction(action: () => Promise<{ readonly ok: true; readonly value: GameRoomSnapshotDto } | { readonly ok: false; readonly code: RoomApplicationFailureCode }>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await action();
    if (!result.ok) {
      error.value = failureCopy[result.code];
      await refreshRooms();
      return;
    }
    snapshot.value = result.value;
    stage.value = 'room';
    await refreshRooms();
  } catch {
    error.value = '本地演练状态暂时不可用，请重试或返回子厅。';
  } finally {
    busy.value = false;
  }
}

function quickMatch(): Promise<void> {
  return runRoomAction(() => props.application.quickMatch(props.difficultyKey));
}

function createRoom(): Promise<void> {
  return runRoomAction(() => props.application.createRoom({
    gameKey: 'SHISANSHUI', difficultyKey: props.difficultyKey,
    ...(createPassword.value ? { roomPassword: createPassword.value } : {}),
  }));
}

function joinRoom(code = roomCode.value): Promise<void> {
  const normalizedCode = code.trim().toUpperCase();
  return runRoomAction(() => props.application.joinRoom({
    roomCode: normalizedCode,
    ...(roomPassword.value ? { roomPassword: roomPassword.value } : {}),
  }));
}

function addBots(): Promise<void> {
  const room = snapshot.value;
  if (!room) return Promise.resolve();
  return runRoomAction(() => props.application.addPracticeBots(room.roomId));
}

function toggleReady(): Promise<void> {
  const room = snapshot.value;
  const player = room?.members.find((member) => member.isCurrentPlayer);
  if (!room || !player) return Promise.resolve();
  return runRoomAction(() => props.application.setReady(room.roomId, !player.isReady));
}

async function leaveRoom(): Promise<void> {
  const room = snapshot.value;
  if (!room) return;
  await runRoomAction(async () => {
    const result = await props.application.leave(room.roomId);
    if (result.ok) {
      snapshot.value = null;
      stage.value = 'entry';
      leaving.value = false;
      await refreshRooms();
      emit('close');
    }
    return result;
  });
}

async function startGame(): Promise<void> {
  const room = snapshot.value;
  if (!room) return;
  await runRoomAction(async () => {
    const result = await props.application.start(room.roomId);
    if (result.ok) emit('start', result.value);
    return result;
  });
}

async function copyRoomCode(): Promise<void> {
  if (!snapshot.value) return;
  try {
    await navigator.clipboard.writeText(snapshot.value.roomCode);
  } catch {
    error.value = '复制未成功；你可以长按选中房号手动复制。';
  }
}

onMounted(() => {
  returnFocusTarget = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : document.querySelector<HTMLElement>('.tier-grid-horizontal .tier-card');
  previousPageScroll = {
    y: window.scrollY,
    htmlOverflow: document.documentElement.style.overflow,
    bodyOverflow: document.body.style.overflow,
    bodyPosition: document.body.style.position,
    bodyTop: document.body.style.top,
    bodyLeft: document.body.style.left,
    bodyRight: document.body.style.right,
    bodyWidth: document.body.style.width,
  };
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  document.body.style.position = 'fixed';
  document.body.style.top = `-${previousPageScroll.y}px`;
  document.body.style.left = '0';
  document.body.style.right = '0';
  document.body.style.width = '100%';
  void refreshRooms();
  void nextTick(() => roomPanel.value?.querySelector<HTMLElement>('button:not([disabled])')?.focus());
});
onBeforeUnmount(() => {
  if (previousPageScroll) {
    document.documentElement.style.overflow = previousPageScroll.htmlOverflow;
    document.body.style.overflow = previousPageScroll.bodyOverflow;
    document.body.style.position = previousPageScroll.bodyPosition;
    document.body.style.top = previousPageScroll.bodyTop;
    document.body.style.left = previousPageScroll.bodyLeft;
    document.body.style.right = previousPageScroll.bodyRight;
    document.body.style.width = previousPageScroll.bodyWidth;
    window.scrollTo(0, previousPageScroll.y);
    previousPageScroll = undefined;
  }
  if (returnFocusTarget?.isConnected) returnFocusTarget.focus();
});
</script>

<template>
  <div class="room-flow-scrim" @click.self="stage === 'entry' && emit('close')">
    <section ref="roomPanel" class="room-flow-panel" role="dialog" aria-modal="true" aria-labelledby="room-flow-title" @keydown="handleKeydown">
      <button class="room-flow-close" type="button" aria-label="关闭房间流程" @click="stage === 'room' ? leaving = true : emit('close')">×</button>
      <p class="eyebrow">SHISANSHUI · LOCAL ROOM</p>
      <h2 id="room-flow-title">{{ stage === 'room' ? '练习房间' : stage === 'join' ? '加入房间' : '选择进入方式' }}</h2>
      <p class="room-flow-subtitle">{{ difficultyLabel }} · 本地演练，不连接其他玩家、不扣真实金币</p>

      <template v-if="stage === 'entry'">
        <div class="room-flow-actions">
          <button type="button" :disabled="busy" @click="quickMatch"><strong>快速匹配</strong><small>安排三位练习机器人，直接进入准备室</small></button>
          <button type="button" :disabled="busy" @click="createRoom"><strong>创建练习房</strong><small>生成房号，可用练习机器人补齐座位</small></button>
          <button type="button" :disabled="busy" @click="stage = 'join'; error = ''"><strong>加入房间</strong><small>输入本机练习房号，也可加入示例房</small></button>
          <button type="button" class="room-flow-practice" @click="emit('practice')"><strong>单人练习</strong><small>跳过房间流程，直接开始本地牌局</small></button>
        </div>
        <label class="room-flow-password">私人房密码（可选）<input v-model="createPassword" type="password" minlength="4" maxlength="32" autocomplete="new-password" placeholder="4–32 位；仅本机演练有效" /></label>
      </template>

      <template v-else-if="stage === 'join'">
        <div v-if="matchingJoinableRooms.length" class="room-flow-joinable-list" aria-label="可加入的本地练习房">
          <article v-for="room in matchingJoinableRooms" :key="room.roomId" class="room-flow-joinable">
            <strong>{{ room.roomCode === 'LG3812' ? '本地示例房' : '本机创建的练习房' }}</strong>
            <span>房号 {{ room.roomCode }} · 还剩 {{ room.capacity - room.members.length }} 个座位</span>
            <button type="button" :disabled="busy" @click="roomCode = room.roomCode; roomPassword = ''; joinRoom(room.roomCode)">加入</button>
          </article>
        </div>
        <form class="room-flow-join-form" @submit.prevent="joinRoom()">
          <label>房间号<input v-model="roomCode" inputmode="text" maxlength="6" autocomplete="off" placeholder="例如 LG3812" /></label>
          <label>房间密码（如有）<input v-model="roomPassword" type="password" autocomplete="off" placeholder="输入房主提供的密码" /></label>
          <div><button type="button" @click="stage = 'entry'; error = ''">返回</button><button class="room-flow-primary" type="submit" :disabled="busy">加入</button></div>
        </form>
      </template>

      <template v-else-if="snapshot">
        <div class="room-flow-code"><span>练习房号</span><strong>{{ snapshot.roomCode }}</strong><button type="button" @click="copyRoomCode">复制房号</button></div>
        <ol class="room-flow-seats" aria-label="房间座位">
          <li v-for="seat in snapshot.capacity" :key="seat" :class="{ occupied: snapshot.members.some((member) => member.seat === seat), current: snapshot.members.some((member) => member.seat === seat && member.isCurrentPlayer) }">
            <template v-if="snapshot.members.find((member) => member.seat === seat)">
              <span class="room-flow-seat-number">{{ seat }} 号位</span>
              <strong>{{ snapshot.members.find((member) => member.seat === seat)?.displayName }}</strong>
              <small>{{ snapshot.members.find((member) => member.seat === seat)?.participantType === 'BOT' ? '练习机器人' : snapshot.members.find((member) => member.seat === seat)?.isCurrentPlayer ? '你' : '牌友' }} · {{ snapshot.members.find((member) => member.seat === seat)?.isReady ? '已准备' : '未准备' }}</small>
            </template>
            <template v-else><span class="room-flow-seat-number">{{ seat }} 号位</span><strong>等待加入</strong><small>空位</small></template>
          </li>
        </ol>
        <p class="room-flow-state">{{ snapshot.members.length }}/{{ snapshot.capacity }} 个座位 · 全部准备后可开局</p>
        <div class="room-flow-room-actions">
          <button type="button" :disabled="busy || snapshot.members.length === snapshot.capacity" @click="addBots">补充练习机器人</button>
          <button type="button" :disabled="busy || !snapshot.members.some((member) => member.isCurrentPlayer)" @click="toggleReady">{{ snapshot.members.find((member) => member.isCurrentPlayer)?.isReady ? '取消准备' : '准备' }}</button>
          <button type="button" class="room-flow-primary" :disabled="busy || !application.canStart(snapshot)" @click="startGame">开始牌局</button>
          <button type="button" class="room-flow-leave" @click="leaving = true">离开房间</button>
        </div>
      </template>

      <p v-if="error" class="room-flow-error" role="alert">{{ error }}</p>
      <div v-if="leaving" class="room-flow-confirm" role="group" aria-label="确认离开练习房">
        <p>{{ leaveConfirmation }}</p>
        <button type="button" @click="leaving = false">继续等待</button><button type="button" class="room-flow-primary" :disabled="busy" @click="leaveRoom">确认离开</button>
      </div>
    </section>
  </div>
</template>
