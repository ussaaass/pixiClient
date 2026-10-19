<script setup lang="ts">
import { ElSelect } from 'element-plus';
import AdminSelectOption from '../components/AdminSelectOption.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SystemConfigDraftDto, SystemConfigEntryDto } from '@gameing/admin-contracts/system-config';
import PageHelpOverlay from '../components/PageHelpOverlay.vue';
import type { SystemConfigApplication } from '../platform/system-config/system-config-application';

const props = defineProps<{ application: SystemConfigApplication }>();
type EditorStage = 'EDIT' | 'CONFIRM' | null;

const entries = ref<SystemConfigEntryDto[]>([]);
const drafts = ref<SystemConfigDraftDto[]>([]);
const keyword = ref('');
const configType = ref('');
const loading = ref(false);
const loadError = ref('');
const resultMessage = ref('');
const editorEntry = ref<SystemConfigEntryDto | null>(null);
const editorStage = ref<EditorStage>(null);
const proposedValue = ref('');
const reason = ref('');
const requestKey = ref('');
const previewDraft = ref<SystemConfigDraftDto | null>(null);
const editorError = ref('');
const saving = ref(false);
const valueInput = ref<HTMLInputElement | null>(null);
let triggerToRestore: HTMLElement | null = null;
let previousInert = false;
let requestSequence = 0;

const draftByKey = computed(() => new Map(drafts.value.map((draft) => [draft.configKey, draft])));
const configTypes = computed(() => [...new Set(entries.value.map((entry) => entry.configType))]);
const valueKindLabel = (entry: SystemConfigEntryDto) => ({
  UNSIGNED_INTEGER: '整数',
  PERCENT_INTEGER: '百分比',
  INTEGER_RATIO: '整数比例',
}[entry.valueKind]);

async function loadEntries(): Promise<void> {
  const currentRequest = ++requestSequence;
  loading.value = true;
  loadError.value = '';
  try {
    const [entryResult, draftResult] = await Promise.all([
      props.application.listEntries({ keyword: keyword.value, ...(configType.value ? { configType: configType.value } : {}) }),
      props.application.listDrafts(),
    ]);
    if (currentRequest !== requestSequence) return;
    if (!entryResult.ok || !draftResult.ok) {
      loadError.value = '配置草稿暂时无法读取，请重试。';
      return;
    }
    entries.value = entryResult.value;
    drafts.value = draftResult.value;
  } catch {
    if (currentRequest === requestSequence) loadError.value = '配置草稿暂时无法读取，请重试。';
  } finally {
    if (currentRequest === requestSequence) loading.value = false;
  }
}

watch([keyword, configType], () => { void loadEntries(); });

function makeRequestKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `local-config-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function openEditor(entry: SystemConfigEntryDto, event: MouseEvent): Promise<void> {
  triggerToRestore = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  editorEntry.value = entry;
  proposedValue.value = draftByKey.value.get(entry.configKey)?.proposedValue ?? entry.referenceValue;
  reason.value = '';
  requestKey.value = makeRequestKey();
  previewDraft.value = null;
  editorError.value = '';
  editorStage.value = 'EDIT';
  const appSurface = document.querySelector<HTMLElement>('.page-content');
  previousInert = appSurface?.inert ?? false;
  if (appSurface) appSurface.inert = true;
  await nextTick();
  valueInput.value?.focus();
}

async function closeEditor(): Promise<void> {
  editorStage.value = null;
  editorEntry.value = null;
  previewDraft.value = null;
  const appSurface = document.querySelector<HTMLElement>('.page-content');
  if (appSurface) appSurface.inert = previousInert;
  await nextTick();
  triggerToRestore?.focus();
  triggerToRestore = null;
}

async function previewChanges(): Promise<void> {
  if (!editorEntry.value || editorStage.value !== 'EDIT') return;
  editorError.value = '';
  const result = await props.application.previewDraft({
    requestKey: requestKey.value,
    configKey: editorEntry.value.configKey,
    proposedValue: proposedValue.value,
    reason: reason.value,
  });
  if (!result.ok) {
    editorError.value = {
      INVALID_REQUEST: '提交内容格式无效，请检查后重试。',
      CONFIG_NOT_FOUND: '该配置项已不可用，请返回列表刷新。',
      INVALID_VALUE: '数值格式与该配置项类型不匹配。',
      REASON_REQUIRED: '请填写至少 3 个字符的变更原因。',
      VALUE_UNCHANGED: '候选值与参考值相同，无需创建草稿。',
      REQUEST_KEY_REUSED: '本次请求标识已用于其他内容，请重新打开编辑。',
    }[result.code];
    return;
  }
  previewDraft.value = result.value;
  editorStage.value = 'CONFIRM';
}

async function saveDraft(): Promise<void> {
  if (!previewDraft.value || saving.value) return;
  saving.value = true;
  editorError.value = '';
  try {
    const result = await props.application.createDraft({
      requestKey: requestKey.value,
      configKey: previewDraft.value.configKey,
      proposedValue: previewDraft.value.proposedValue,
      reason: previewDraft.value.reason,
    });
    if (!result.ok) {
      editorError.value = result.code === 'REQUEST_KEY_REUSED' ? '请求内容已变化，请返回修改后重新预览。' : '草稿未保存，请检查内容后重试。';
      return;
    }
    resultMessage.value = `${editorEntry.value?.title ?? '配置'}的本机持久化草稿已保存。`;
    await closeEditor();
    await loadEntries();
  } catch {
    editorError.value = '草稿未保存，请保留输入后重试。';
  } finally {
    saving.value = false;
  }
}

async function discardDraft(entry: SystemConfigEntryDto): Promise<void> {
  const result = await props.application.discardDraft(entry.configKey);
  if (!result.ok) {
    loadError.value = '草稿已不可用，请刷新列表。';
    return;
  }
  resultMessage.value = `${entry.title}的本机持久化草稿已撤销。`;
  await loadEntries();
}

function handleEditorKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    void closeEditor();
  } else if (event.key === 'Tab') {
    const dialog = event.currentTarget as HTMLElement;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

onMounted(() => { void loadEntries(); });
onBeforeUnmount(() => {
  requestSequence += 1;
  const appSurface = document.querySelector<HTMLElement>('.page-content');
  if (appSurface) appSurface.inert = previousInert;
});
</script>

<template>
  <section class="system-config-workspace">
    <div class="system-work-panel">
      <div class="system-panel-heading">
        <div><h2>全局系统配置</h2><p>展示已确认的需求参考值；候选值保存在本机草稿中，不会更改当前生效配置。</p></div>
        <div class="system-panel-actions"><PageHelpOverlay title="系统配置操作说明" trigger-label="查看系统配置操作说明" :sections="[
          { heading: '配置类型', body: '配置值以字符串保存，按配置类型进行解析和校验。每个配置项只允许使用登记的解析规则。' },
          { heading: '草稿范围', body: '候选草稿保存在当前浏览器的 IndexedDB 中，刷新后仍可继续查看或撤销。保存不会发布、不会即时生效，也不代表修改了生产配置。' },
          { heading: '变更原因', body: '确认前需要填写原因，并核对参考值与候选值。生产配置发布仍须服务端校验权限、影响范围并追加审计。' },
        ]" /><span class="system-local-draft-label">本机持久化草稿</span></div>
      </div>

      <div class="system-config-filters">
        <label>搜索配置<input v-model="keyword" type="search" placeholder="输入名称或 config key" /></label>
        <label>配置类型<el-select v-model="configType"><AdminSelectOption value="">全部类型</AdminSelectOption><AdminSelectOption v-for="type in configTypes" :key="type" :value="type">{{ type }}</AdminSelectOption></el-select></label>
        <button type="button" @click="keyword = ''; configType = ''">清除筛选</button>
      </div>

      <p v-if="resultMessage" class="system-config-result" role="status">{{ resultMessage }}</p>
      <p v-if="loadError" class="system-config-error" role="alert">{{ loadError }} <button type="button" @click="loadEntries">重试</button></p>
      <div v-if="loading" class="system-config-empty" role="status">正在读取配置参考值…</div>
      <div v-else-if="!entries.length" class="system-config-empty"><strong>没有匹配的配置项</strong><button type="button" @click="keyword = ''; configType = ''">清除筛选</button></div>
      <div v-else class="system-config-list" aria-label="系统配置参考值">
        <article v-for="entry in entries" :key="entry.configKey" class="system-config-row">
          <div class="system-config-description"><strong>{{ entry.title }}</strong><code>{{ entry.configKey }}</code><p>{{ entry.description }}</p></div>
          <div class="system-config-value"><small>需求参考值 · {{ entry.unit }}</small><strong>{{ entry.referenceValue }} <span>{{ entry.unit }}</span></strong><small>{{ valueKindLabel(entry) }} · {{ entry.configType }}</small></div>
          <div class="system-config-draft"><template v-if="draftByKey.get(entry.configKey)"><small>本机候选</small><strong>{{ draftByKey.get(entry.configKey)?.proposedValue }} <span>{{ entry.unit }}</span></strong><small>未生效</small></template><span v-else class="system-config-no-draft">—</span></div>
          <div class="system-config-row-actions"><button type="button" @click="openEditor(entry, $event)">{{ draftByKey.has(entry.configKey) ? '修改草稿' : '新建草稿' }}</button><button v-if="draftByKey.has(entry.configKey)" type="button" class="system-config-discard" @click="discardDraft(entry)">撤销</button></div>
        </article>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="editorStage" class="system-config-backdrop" @click.self="closeEditor">
        <section class="system-config-dialog" role="dialog" aria-modal="true" aria-labelledby="config-editor-title" @keydown="handleEditorKeydown">
        <button class="system-config-close" type="button" aria-label="关闭配置编辑" @click="closeEditor">×</button>
        <p class="eyebrow">{{ editorStage === 'EDIT' ? '编辑候选值' : '确认本机持久化草稿' }}</p>
        <h2 id="config-editor-title">{{ editorEntry?.title }}</h2>
        <code>{{ editorEntry?.configKey }}</code>

        <form v-if="editorStage === 'EDIT'" class="system-config-editor-form" @submit.prevent="previewChanges">
          <label :for="`config-value-${editorEntry?.configKey}`">候选值（{{ editorEntry?.unit }}）<input :id="`config-value-${editorEntry?.configKey}`" ref="valueInput" v-model="proposedValue" maxlength="128" required /></label>
          <label for="config-reason">变更原因<textarea id="config-reason" v-model="reason" rows="3" maxlength="240" minlength="3" required placeholder="说明这次候选调整的原因"></textarea></label>
          <p v-if="editorError" class="system-config-error" role="alert">{{ editorError }}</p>
          <p class="system-config-dialog-boundary">草稿保存在当前浏览器中，刷新后仍可恢复；不会发布或改变生效配置。</p>
          <div class="system-config-dialog-actions"><button type="button" @click="closeEditor">取消</button><button class="system-config-primary" type="submit">预览变更</button></div>
        </form>

        <div v-else-if="previewDraft" class="system-config-confirmation">
          <dl><div><dt>需求参考值</dt><dd>{{ previewDraft.baseValue }} {{ editorEntry?.unit }}</dd></div><div><dt>本机候选值</dt><dd>{{ previewDraft.proposedValue }} {{ editorEntry?.unit }}</dd></div><div><dt>变更原因</dt><dd>{{ previewDraft.reason }}</dd></div></dl>
          <p class="system-config-dialog-boundary">保存只更新本机持久化草稿，不会让配置生效。</p>
          <p v-if="editorError" class="system-config-error" role="alert">{{ editorError }}</p>
          <div class="system-config-dialog-actions"><button type="button" @click="editorStage = 'EDIT'; editorError = ''">返回修改</button><button class="system-config-primary" type="button" :disabled="saving" @click="saveDraft">{{ saving ? '保存中…' : '保存本机草稿' }}</button></div>
        </div>
        </section>
      </div>
    </Teleport>
  </section>
</template>
