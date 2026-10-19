<script setup lang="ts">
import { ElSelect } from 'element-plus';
import AdminSelectOption from '../components/AdminSelectOption.vue';
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const sections = [
  { path: '/admin/assets', title: 'Asset 目录' },
  { path: '/admin/ai-generation', title: 'AI 生成台账' },
  { path: '/admin/asset-releases', title: '资源发布' },
];
const page = computed(() => sections.find((section) => section.path === route.path) ?? sections[0]!);
const isCatalog = computed(() => page.value.path === '/admin/assets');
const isGeneration = computed(() => page.value.path === '/admin/ai-generation');
const assetChecks = ['asset_id 与文件类型', 'hash / 字节数 / MIME 声明', '尺寸 / 时长 / 编码信息', '引用位置与授权预览'];
const releaseChecks = ['READY 且审核通过', '格式与资源完整性', '尺寸 / 体积预算', '清单 hash 与依赖', '缓存版本与回滚点'];
</script>

<template>
  <section class="asset-management-page">
    <div class="asset-operations-heading">
      <div><p class="eyebrow">素材与资源</p><h1>{{ page.title }}</h1><p>文件本体由 Asset 管理；业务记录只引用 asset_id。生成密钥仅留在内部执行端，绝不进入浏览器。</p></div>
    </div>

    <nav class="asset-section-tabs" aria-label="素材与资源工作区">
      <RouterLink v-for="section in sections" :key="section.path" :to="section.path" :class="{ active: page.path === section.path }">{{ section.title }}</RouterLink>
    </nav>

    <template v-if="isCatalog">
      <section class="asset-query-panel">
        <div class="asset-panel-heading"><div><h2>Asset 文件目录</h2><p>查询统一文件元数据；variant/使用位置由已登记 artifact、release 与引用记录汇总。</p></div><button type="button" disabled>＋ 上传资源</button></div>
        <div class="asset-query-grid">
          <label>Asset ID<input disabled placeholder="十进制字符串"></label>
          <label>资源类型<el-select disabled><AdminSelectOption value="">全部类型</AdminSelectOption></el-select></label>
          <label>资源状态<el-select disabled><AdminSelectOption value="">全部状态</AdminSelectOption></el-select></label>
          <label>使用位置<el-select disabled><AdminSelectOption value="">全部位置</AdminSelectOption></el-select></label>
          <button type="button" disabled>查询资源</button>
        </div>
        <div class="asset-table-empty"><span>▧</span><strong>暂无可读取的 Asset</strong><p>目录会显示类型、状态、hash、密文字节数、尺寸/时长、客户端声明 MIME、可见范围与引用位置。对象存储路径和长期公开 URL 不在列表回显。</p></div>
      </section>
      <section class="asset-metadata-grid" aria-label="Asset 记录字段">
        <article v-for="check in assetChecks" :key="check"><span>✓</span><strong>{{ check }}</strong></article>
      </section>
      <section class="asset-security-note"><strong>密文预览授权</strong><p>用户上传资源在浏览器加密后保存。预览需由 Asset API 授权获取短期解密能力，逐块先验 MAC 再解密；解密材料和明文不进入持久缓存。无授权上下文时不能生成预览。</p></section>
    </template>

    <template v-else-if="isGeneration">
      <section class="asset-query-panel">
        <div class="asset-panel-heading"><div><h2>AI 生成任务台账</h2><p>主模型与图像模型分开记录，实际模型 ID 和费用依据由服务端任务回执提供。</p></div><button type="button" disabled>＋ 创建生成任务</button></div>
        <div class="asset-query-grid generation-query-grid">
          <label>素材语义键<input disabled placeholder="按 asset_key 查找"></label>
          <label>资源类型<el-select disabled><AdminSelectOption value="">全部类型</AdminSelectOption></el-select></label>
          <label>任务状态<el-select disabled><AdminSelectOption value="">全部状态</AdminSelectOption></el-select></label>
          <label>创建时间<input disabled placeholder="开始时间 — 结束时间"></label>
          <button type="button" disabled>查询任务</button>
        </div>
        <div class="asset-table-empty"><span>✧</span><strong>暂无生成任务</strong><p>任务记录提示词及 hash、风格版本、GPT-6 系列主模型代码、独立图像模型代码、参数、实际用量/成本、尝试次数和完成时间。</p></div>
      </section>
      <section class="generation-workflow-grid">
        <article><small>创建任务</small><strong>锁定风格与模型配置</strong><p>填写素材目标、提示词与非秘密生成参数；参考图必须先登记为 Asset。</p></article>
        <article><small>输出审核</small><strong>候选不等于已批准</strong><p>原图和 WebP/AVIF 等衍生产物分别进入 Asset；审核记录质量与来源。</p></article>
        <article><small>安全边界</small><strong>浏览器永远没有 API Token</strong><p>请求通过内部生成执行端；页面只读取任务状态、模型代码和成本台账。</p></article>
      </section>
      <div class="asset-action-row"><button type="button" disabled>重试失败任务</button><button type="button" disabled>批准候选入库</button><button type="button" disabled>拒绝候选</button></div>
    </template>

    <template v-else>
      <section class="asset-query-panel">
        <div class="asset-panel-heading"><div><h2>资源发布清单</h2><p>大厅公共资源与游戏专属资源按不可变版本发布；每个 release 固定清单和文件 hash。</p></div><div class="asset-panel-actions"><button type="button" disabled>构建检查</button><button type="button" disabled>＋ 新建发布</button></div></div>
        <div class="asset-query-grid release-query-grid">
          <label>资源范围<el-select disabled><AdminSelectOption value="">大厅 / 指定游戏</AdminSelectOption></el-select></label>
          <label>发布状态<el-select disabled><AdminSelectOption value="">全部状态</AdminSelectOption></el-select></label>
          <label>版本 / 清单<input disabled placeholder="release key 或 manifest hash"></label>
          <button type="button" disabled>查询发布</button>
        </div>
        <div class="asset-table-empty"><span>↗</span><strong>暂无发布版本</strong><p>发布报告需列出资源增删差异、每档尺寸和总体积、完整性校验及将受影响的大厅/游戏范围。</p></div>
      </section>
      <section class="asset-release-workspace">
        <div class="asset-release-checks"><div><h2>发布前检查</h2><p>检查项由资源策略和 manifest validator 返回；任一硬检查失败即不可发布。</p></div><ul><li v-for="check in releaseChecks" :key="check"><span>—</span>{{ check }}</li></ul></div>
        <div class="asset-load-phase-panel"><h2>加载阶段</h2><p>资源清单可按首屏、入口、后台和可选阶段排序；网络空闲调度只处理已发布、可缓存的密文资源。</p><div><span>Shell</span><b>→</b><span>Entry</span><b>→</b><span>Background</span><b>→</b><span>Optional</span></div></div>
      </section>
      <section class="asset-security-note"><strong>版本与回滚</strong><p>发布后以新 manifest/hash 与缓存版本上线，不覆盖既有 URL 内容。回滚选择历史 release 并生成新的部署动作；不会改写旧发布清单。客户端解密后的明文不写入 Cache Storage 或 IndexedDB。</p></section>
      <div class="asset-action-row"><button type="button" disabled>发布检查通过版本</button><button type="button" disabled>回滚到历史版本</button></div>
    </template>
  </section>
</template>
