<script setup lang="ts">
import { ElSelect } from 'element-plus';
import AdminSelectOption from '../components/AdminSelectOption.vue';
import { computed, onMounted, ref } from 'vue';
import {
  GameCatalogStatus,
  type GameCatalogChangeDto,
  type GameCatalogCoverAssetOption,
  type GameCatalogDto,
} from '@gameing/contracts/game-catalog';
import PageHelpOverlay from '../components/PageHelpOverlay.vue';
import { localGameCatalogApplication } from '../platform/game-catalog/composition';
import type { GameCatalogApplication } from '../platform/game-catalog/game-catalog-application';

const props = defineProps<{ application?: GameCatalogApplication }>();
const application = props.application ?? localGameCatalogApplication;
const records = ref<GameCatalogDto[]>([]);
const covers = ref<GameCatalogCoverAssetOption[]>([]);
const changes = ref<GameCatalogChangeDto[]>([]);
const keyword = ref('');
const statusFilter = ref<GameCatalogDto['status'] | ''>('');
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const notice = ref('');
const editorOpen = ref(false);
const createOpen = ref(false);
const historyOpen = ref(false);
const selected = ref<GameCatalogDto | null>(null);
const editForm = ref<{ name: string; category: string; description: string; coverAssetId: string; sortOrder: number; status: GameCatalogDto['status']; reason: string }>({ name: '', category: '', description: '', coverAssetId: '', sortOrder: 0, status: GameCatalogStatus.ACTIVE, reason: '' });
const createForm = ref({ gameCode: '', name: '', category: '', description: '', coverAssetId: '', sortOrder: 90, reason: '' });
const fieldError = ref('');
let pendingRequest: { signature: string; requestKey: string } | undefined;
const statusOptions = [
  { value: GameCatalogStatus.ACTIVE, label: '展示中' },
  { value: GameCatalogStatus.HIDDEN, label: '已隐藏' },
  { value: GameCatalogStatus.MAINTENANCE, label: '维护中' },
];
const visibleRecords = computed(() => records.value);
const selectedCover = computed(() => covers.value.find((asset) => asset.assetId === editForm.value.coverAssetId) ?? covers.value[0]);
const createCover = computed(() => covers.value.find((asset) => asset.assetId === createForm.value.coverAssetId) ?? covers.value[0]);

function statusLabel(status: GameCatalogDto['status']): string {
  return statusOptions.find((item) => item.value === status)?.label ?? '未知状态';
}

function integrationLabel(game: GameCatalogDto): string {
  return game.isPlayable ? '内置模块 · 可进入' : game.clientModuleKey ? '内置模块 · 待开放' : '外接 Stub · 待接入';
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const normalizedKeyword = keyword.value.trim();
    const query = { ...(normalizedKeyword ? { keyword: normalizedKeyword } : {}), ...(statusFilter.value === '' ? {} : { status: statusFilter.value }) };
    const result = await application.list(query);
    if (!result.ok) { error.value = '目录数据不符合共享契约，请重试。'; return; }
    records.value = result.value.items;
    const assetResult = await application.listReadyCoverAssets();
    if (!assetResult.ok) { error.value = '可用封面素材暂时无法读取。'; return; }
    covers.value = assetResult.value;
  } catch {
    error.value = '本机目录演练数据暂时无法读取，请重试。';
  } finally {
    loading.value = false;
  }
}

function requestKey(signature: string): string {
  if (!pendingRequest || pendingRequest.signature !== signature) pendingRequest = { signature, requestKey: crypto.randomUUID() };
  return pendingRequest.requestKey;
}

function openEditor(game: GameCatalogDto): void {
  selected.value = game;
  editForm.value = { name: game.name, category: game.category, description: game.description, coverAssetId: game.coverAssetId, sortOrder: game.sortOrder, status: game.status, reason: '' };
  fieldError.value = '';
  editorOpen.value = true;
}

async function saveEdit(): Promise<void> {
  if (!selected.value || saving.value) return;
  const signature = JSON.stringify([selected.value.gameId, editForm.value]);
  saving.value = true;
  fieldError.value = '';
  try {
    const result = await application.update({
      requestKey: requestKey(signature), gameId: selected.value.gameId, ...editForm.value,
    });
    if (!result.ok) {
      fieldError.value = {
        INVALID_REQUEST: '请检查字段长度、排序值和操作原因。',
        GAME_NOT_FOUND: '目录条目已不存在，请刷新。',
        GAME_CODE_TAKEN: '游戏代码已被占用。',
        GAME_KEY_TAKEN: '这个游戏键已被占用，请更换稳定代码。',
        COVER_ASSET_NOT_READY: '请选择一项可用的 WebP 封面素材。',
        REQUEST_KEY_REUSED: '请求标识已对应其他变更，请重新打开编辑。',
      }[result.code];
      return;
    }
    pendingRequest = undefined;
    notice.value = `已保存本机演练目录：${result.value.name}。`;
    editorOpen.value = false;
    await refresh();
  } catch {
    fieldError.value = '保存状态尚未确认；保持内容不变并重试会复用同一请求编号。';
  } finally {
    saving.value = false;
  }
}

async function createStub(): Promise<void> {
  if (saving.value) return;
  const signature = JSON.stringify(createForm.value);
  saving.value = true;
  fieldError.value = '';
  try {
    const result = await application.createExternalStub({ requestKey: requestKey(signature), ...createForm.value });
    if (!result.ok) {
      fieldError.value = {
        INVALID_REQUEST: '游戏代码需使用小写字母、数字和连字符，其他字段也需符合长度要求。',
        GAME_NOT_FOUND: '目录条目已不存在，请刷新。',
        GAME_CODE_TAKEN: '这个游戏代码已存在，请换一个稳定代码。',
        GAME_KEY_TAKEN: '这个游戏键已被占用，请换一个稳定代码。',
        COVER_ASSET_NOT_READY: '请选择一项可用的 WebP 封面素材。',
        REQUEST_KEY_REUSED: '请求标识已对应其他内容，请关闭后重试。',
      }[result.code];
      return;
    }
    pendingRequest = undefined;
    notice.value = `已创建本机外接 Stub「${result.value.name}」；它不会加载游戏模块。`;
    createOpen.value = false;
    keyword.value = result.value.gameCode;
    statusFilter.value = '';
    await refresh();
  } catch {
    fieldError.value = '创建状态尚未确认；重试会复用相同请求编号。';
  } finally {
    saving.value = false;
  }
}

async function showHistory(game: GameCatalogDto): Promise<void> {
  selected.value = game;
  historyOpen.value = true;
  fieldError.value = '';
  try {
    const result = await application.listChanges(game.gameId);
    if (!result.ok) { error.value = '目录变更记录暂时不可读。'; return; }
    changes.value = result.value;
  } catch {
    error.value = '目录变更记录暂时不可读。';
  }
}

function openCreate(): void {
  createForm.value = { gameCode: '', name: '', category: '游戏', description: '游戏模块接入前的外接占位', coverAssetId: covers.value[0]?.assetId ?? '', sortOrder: Math.max(0, ...records.value.map((game) => game.sortOrder)) + 10, reason: '' };
  fieldError.value = '';
  createOpen.value = true;
}

onMounted(() => { void refresh(); });
</script>

<template>
  <section class="domain-page game-catalog-page">
    <div class="domain-heading">
      <p class="eyebrow">游戏运营 / 大厅展示</p>
      <h1>游戏目录</h1>
      <p>维护大厅名称、封面、排序与展示状态。是否可进入由已注册的游戏模块决定，隐藏条目不会删除模块或历史牌局。</p>
    </div>

    <section class="game-catalog-banner" aria-label="本机演练范围">
      <span class="domain-state-icon" aria-hidden="true">◇</span>
      <div><strong>LOCAL_DEMO 游戏目录</strong><p>本机 IndexedDB 演练，不会发布到玩家大厅。外接 Stub 只创建目录占位，不执行远端代码。</p></div>
      <PageHelpOverlay title="游戏目录操作说明" trigger-label="查看目录说明" :sections="[{ heading: '模块准入', body: '目录状态只控制展示；实际游戏入口还要匹配已注册的内部 handler。外接 Stub 始终不能进入游戏。' }, { heading: '素材', body: '演练 Asset Picker 只提供当前工作区已登记的 WebP 封面；生产目录必须引用 Asset READY 状态的 asset_id。' }, { heading: '审计', body: '每次保存都需要原因，并在同一 IndexedDB 事务写目录快照和变更审计。' } ]" />
    </section>
    <p v-if="notice" class="game-catalog-result" role="status">{{ notice }}</p>
    <p v-if="error" class="game-catalog-error" role="alert">{{ error }} <button type="button" @click="refresh">重试</button></p>

    <section class="game-catalog-panel" aria-labelledby="game-catalog-title">
      <div class="agent-domain-section-heading"><div><h2 id="game-catalog-title">大厅游戏</h2><p>按显示名称、稳定 game code、目录状态查询；排序值越小越靠前。</p></div><span class="record-count">{{ visibleRecords.length }} 项</span></div>
      <form class="game-catalog-filters" @submit.prevent="refresh">
        <label><span>游戏名称 / Code</span><input v-model="keyword" type="search" placeholder="输入名称或 code" /></label>
        <label><span>展示状态</span><el-select v-model="statusFilter"><AdminSelectOption value="">全部状态</AdminSelectOption><AdminSelectOption v-for="item in statusOptions" :key="item.value" :value="item.value">{{ item.label }}</AdminSelectOption></el-select></label>
        <button type="submit" :disabled="loading">{{ loading ? '查询中…' : '查询' }}</button>
        <button class="catalog-create-button" type="button" @click="openCreate">＋ 新增外接 Stub</button>
      </form>
      <div class="game-catalog-table-wrap">
        <table>
          <caption>大厅游戏目录</caption>
          <thead><tr><th scope="col">游戏</th><th scope="col">Game Code</th><th scope="col">封面 Asset</th><th scope="col">集成方式</th><th scope="col">展示状态</th><th scope="col">排序</th><th scope="col">操作</th></tr></thead>
          <tbody>
            <tr v-if="loading"><td colspan="7"><div class="game-catalog-empty" role="status">正在读取本机目录…</div></td></tr>
            <tr v-else-if="!visibleRecords.length"><td colspan="7"><div class="game-catalog-empty" role="status"><span class="user-empty-icon" aria-hidden="true">♧</span><strong>没有匹配的游戏</strong><p>调整筛选条件，或新增只展示、不执行远端代码的外接 Stub。</p></div></td></tr>
            <template v-else>
              <tr v-for="game in visibleRecords" :key="game.gameId">
                <td><strong>{{ game.name }}</strong><small class="catalog-subtitle">{{ game.category }} · {{ game.description }}</small></td>
                <td><code>{{ game.gameCode }}</code></td>
                <td><span class="catalog-asset-id">{{ game.coverAssetId }}</span></td>
                <td>{{ integrationLabel(game) }}</td>
                <td><span class="catalog-status-pill" :class="`status-${game.status}`">{{ statusLabel(game.status) }}</span></td>
                <td>{{ game.sortOrder }}</td>
                <td><div class="catalog-row-actions"><button type="button" @click="openEditor(game)">编辑</button><button type="button" @click="showHistory(game)">历史</button></div></td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div v-if="visibleRecords.length" class="game-catalog-mobile-list">
        <article v-for="game in visibleRecords" :key="game.gameId" class="catalog-mobile-card">
          <img :src="covers.find((asset) => asset.assetId === game.coverAssetId)?.previewUrl" :alt="`${game.name}封面`" loading="lazy" />
          <div><span class="catalog-status-pill" :class="`status-${game.status}`">{{ statusLabel(game.status) }}</span><h3>{{ game.name }}</h3><code>{{ game.gameCode }}</code><p>{{ integrationLabel(game) }} · 排序 {{ game.sortOrder }}</p><small>{{ game.description }}</small></div>
          <div class="catalog-row-actions"><button type="button" @click="openEditor(game)">编辑</button><button type="button" @click="showHistory(game)">历史</button></div>
        </article>
      </div>
    </section>

    <section class="game-catalog-workflow" aria-labelledby="catalog-workflow-title">
      <div class="agent-domain-section-heading"><div><h2 id="catalog-workflow-title">目录变更规则</h2><p>目录维护不会更改游戏 handler、子厅规则或进行中的牌局快照。</p></div></div>
      <ol><li><span>01</span><div><strong>调整目录字段</strong><p>显示名称、分类、描述、已就绪封面引用、排序和展示状态。</p></div></li><li><span>02</span><div><strong>确认素材与预览</strong><p>封面必须来自当前 Asset Picker 的 READY 项；确认后保存本机演练版本。</p></div></li><li><span>03</span><div><strong>保留变更原因</strong><p>每次编辑追加前后快照；生产发布仍需 Admin API 与 Asset 授权。</p></div></li></ol>
    </section>

    <Teleport to="body">
      <div v-if="editorOpen && selected" class="catalog-dialog-backdrop" @click.self="editorOpen = false">
        <section class="catalog-dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-edit-title">
          <header><div><p class="eyebrow">LOCAL_DEMO / 目录编辑</p><h2 id="catalog-edit-title">编辑 {{ selected.name }}</h2><p>{{ selected.gameCode }} · {{ integrationLabel(selected) }}</p></div><button type="button" aria-label="关闭编辑" :disabled="saving" @click="editorOpen = false">×</button></header>
          <div class="catalog-edit-grid">
            <label>显示名称<input v-model="editForm.name" maxlength="64" minlength="2" /></label>
            <label>分类<input v-model="editForm.category" maxlength="48" /></label>
            <label>展示状态<el-select v-model.number="editForm.status"><AdminSelectOption v-for="item in statusOptions" :key="item.value" :value="item.value">{{ item.label }}</AdminSelectOption></el-select></label>
            <label>排序值<input v-model.number="editForm.sortOrder" type="number" min="0" max="1000000" step="1" /></label>
            <label class="catalog-description-field">大厅说明<textarea v-model="editForm.description" maxlength="240" rows="3"></textarea></label>
            <label class="catalog-asset-field">大厅封面 Asset<el-select v-model="editForm.coverAssetId"><AdminSelectOption v-for="asset in covers" :key="asset.assetId" :value="asset.assetId">{{ asset.name }} · {{ asset.assetId }}</AdminSelectOption></el-select></label>
            <figure v-if="selectedCover" class="catalog-cover-preview"><img :src="selectedCover.previewUrl" :alt="selectedCover.name" /><figcaption>{{ selectedCover.name }}<small>asset_id {{ selectedCover.assetId }} · WebP</small></figcaption></figure>
            <label class="catalog-reason-field">变更原因<textarea v-model="editForm.reason" maxlength="500" minlength="3" rows="2" placeholder="填写至少 3 个字符的原因"></textarea></label>
          </div>
          <p v-if="fieldError" class="game-catalog-error" role="alert">{{ fieldError }}</p>
          <footer><button type="button" :disabled="saving" @click="editorOpen = false">取消</button><button type="button" class="catalog-save-button" :disabled="saving" @click="saveEdit">{{ saving ? '保存中…' : '保存本机版本' }}</button></footer>
        </section>
      </div>
      <div v-if="createOpen" class="catalog-dialog-backdrop" @click.self="createOpen = false">
        <section class="catalog-dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-create-title">
          <header><div><p class="eyebrow">LOCAL_DEMO / EXTERNAL_STUB</p><h2 id="catalog-create-title">新增外接游戏占位</h2><p>Stub 只展示目录信息，客户端不会执行外部 URL 或动态代码。</p></div><button type="button" aria-label="关闭创建" :disabled="saving" @click="createOpen = false">×</button></header>
          <div class="catalog-edit-grid">
            <label>稳定 Game Code<input v-model="createForm.gameCode" maxlength="64" placeholder="partner-game" /></label>
            <label>显示名称<input v-model="createForm.name" maxlength="64" minlength="2" /></label>
            <label>分类<input v-model="createForm.category" maxlength="48" /></label>
            <label>排序值<input v-model.number="createForm.sortOrder" type="number" min="0" max="1000000" step="1" /></label>
            <label class="catalog-description-field">大厅说明<textarea v-model="createForm.description" maxlength="240" rows="3"></textarea></label>
            <label class="catalog-asset-field">大厅封面 Asset<el-select v-model="createForm.coverAssetId"><AdminSelectOption v-for="asset in covers" :key="asset.assetId" :value="asset.assetId">{{ asset.name }} · {{ asset.assetId }}</AdminSelectOption></el-select></label>
            <figure v-if="createCover" class="catalog-cover-preview"><img :src="createCover.previewUrl" :alt="createCover.name" /><figcaption>{{ createCover.name }}<small>asset_id {{ createCover.assetId }} · WebP</small></figcaption></figure>
            <label class="catalog-reason-field">新增原因<textarea v-model="createForm.reason" maxlength="500" minlength="3" rows="2" placeholder="填写至少 3 个字符的原因"></textarea></label>
          </div>
          <p v-if="fieldError" class="game-catalog-error" role="alert">{{ fieldError }}</p>
          <footer><button type="button" :disabled="saving" @click="createOpen = false">取消</button><button type="button" class="catalog-save-button" :disabled="saving" @click="createStub">{{ saving ? '创建中…' : '创建本机 Stub' }}</button></footer>
        </section>
      </div>
      <div v-if="historyOpen && selected" class="catalog-dialog-backdrop" @click.self="historyOpen = false">
        <section class="catalog-dialog catalog-history-dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-history-title">
          <header><div><p class="eyebrow">LOCAL_DEMO / APPEND-ONLY</p><h2 id="catalog-history-title">{{ selected.name }} · 目录变更历史</h2><p>{{ selected.gameCode }}</p></div><button type="button" aria-label="关闭历史记录" @click="historyOpen = false">×</button></header>
          <div v-if="changes.length" class="catalog-history-list"><article v-for="change in changes" :key="change.changeId"><strong>{{ change.previous ? '目录更新' : '新增外接 Stub' }}</strong><small>{{ new Date(change.createdAt).toLocaleString() }} · {{ change.reason }}</small><p v-if="change.previous">{{ change.previous.name }} → {{ change.next.name }} · {{ statusLabel(change.previous.status) }} → {{ statusLabel(change.next.status) }}</p><p v-else>{{ change.next.gameCode }} · {{ change.next.name }} · 不可直接进入</p></article></div>
          <p v-else class="catalog-history-empty">暂无目录变更记录。</p>
          <footer><button type="button" @click="historyOpen = false">关闭</button></footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>
