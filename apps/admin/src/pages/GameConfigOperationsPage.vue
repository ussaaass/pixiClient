<script setup lang="ts">
import { ElSelect } from 'element-plus';
import AdminSelectOption from '../components/AdminSelectOption.vue';
import { computed, reactive, ref, toRaw } from 'vue';
import { Value } from '@sinclair/typebox/value';
import { useRoute } from 'vue-router';
import { GameMathSimulationReportSchema, GameMathSimulationRequestSchema } from '@gameing/contracts/game-math';
import { CLASSIC_V1_SCORING, SHISANSHUI_MATH_MODEL_VERSION, simulateShisanshui, type ScoringConfig } from '@gameing/shisanshui-rules';
import PageHelpOverlay from '../components/PageHelpOverlay.vue';

const route = useRoute();
const gameKey = computed(() => String(route.params.gameKey ?? 'unknown'));
const difficultyKey = computed(() => String(route.params.difficultyKey ?? 'unknown'));
const isExpectation = computed(() => route.meta.gameConfigPage === 'expectation');
const scopePath = computed(() => route.path.replace(/\/(config|expectation)$/, ''));
const hasModel = computed(() => gameKey.value === 'shisanshui');
const title = computed(() => isExpectation.value ? '期望计算器' : '游戏 / 难度配置');
const config = reactive(structuredClone(CLASSIC_V1_SCORING)) as ScoringConfig;
const runCount = ref<1000 | 10000>(1000);
const seed = ref<string>(crypto.randomUUID());
const report = ref<Awaited<ReturnType<typeof simulateShisanshui>> | null>(null);
const progress = ref(0);
const busy = ref(false);
const feedback = ref('');
const candidateValidated = ref(false);
const features = [
  ['frontThreeOfAKind', '头墩三条奖励'], ['middleFullHouse', '中墩葫芦奖励'], ['middleFourOfAKind', '中墩铁支奖励'],
  ['middleStraightFlush', '中墩同花顺奖励'], ['backFourOfAKind', '底墩铁支奖励'], ['backStraightFlush', '底墩同花顺奖励'],
  ['slam', '打枪倍数'], ['homeRun', '全垒打倍数'], ['foulPayout', '相公赔付'],
] as const;
const payouts = [
  ['frontThreeOfAKind', '头墩三条'], ['middleFullHouse', '中墩葫芦'], ['middleFourOfAKind', '中墩铁支'],
  ['middleStraightFlush', '中墩同花顺'], ['backFourOfAKind', '底墩铁支'], ['backStraightFlush', '底墩同花顺'], ['foul', '相公赔付'],
] as const;
const configHelp = [
  { heading: '当前数学模型', body: '十三张使用规则模块的 classic_v1 结算，预览采用固定排序策略，不代表实际玩家或生产机器人。' },
  { heading: '试算范围', body: '只发牌、理牌并执行三家对比规则；无下注、金币、钱包、持久化牌局、生产随机源或数据库写入。' },
  { heading: '生产发布', body: '候选和预览目前只在页面内存中。生产配置发布需要后端事务、权限校验和不可变审计；离线页面不会假装已经发布。' },
];
const metrics = computed(() => report.value ? [
  ['策略胜率', percent(report.value.winRate), '固定策略样本下净分大于 0'],
  ['平局率', percent(report.value.tieRate), '净水为 0'],
  ['净分为 0', percent(report.value.zeroNetRate), '玩家对战模型轮空率不适用'],
  ['相公率', percent(report.value.foulRate), '固定排序产生的违规墩率'],
  ['打枪率', percent(report.value.slamRate), '三墩均胜同一对手'],
  ['全垒打率', percent(report.value.homeRunRate), '一局中清扫全桌'],
  ['每局期望净水', report.value.meanNetScore.toFixed(2), '以水计，不代表金币收益'],
  ['净水标准差', report.value.standardDeviation.toFixed(2), '方差 ' + report.value.variance.toFixed(2)],
] : []);
const maxBucketCount = computed(() => Math.max(1, ...(report.value?.distribution.map((item) => item.count) ?? [])));
function percent(value: number): string { return `${(value * 100).toFixed(2)}%`; }
function validateCandidate(): void {
  const values = [...Object.values(config.payouts), config.slamMultiplier, config.homeRunMultiplier];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 1000)) {
    candidateValidated.value = false;
    feedback.value = '参数必须是 1–1000 的整数水值/倍数。';
    return;
  }
  candidateValidated.value = true;
  feedback.value = '候选通过本地规则校验；目前仅驻留此页面，未保存到服务端。';
}
async function simulate(): Promise<void> {
  if (!hasModel.value || busy.value) return;
  validateCandidate();
  if (!candidateValidated.value) return;
  const chosenSeed = seed.value.trim() || crypto.randomUUID();
  seed.value = chosenSeed;
  const request = {
    gameKey: gameKey.value,
    difficultyKey: difficultyKey.value,
    runs: runCount.value,
    seed: chosenSeed,
    configVersion: 'LOCAL_CANDIDATE',
    modelVersion: SHISANSHUI_MATH_MODEL_VERSION,
    config: {
      slamMultiplier: config.slamMultiplier,
      homeRunMultiplier: config.homeRunMultiplier,
      ...Object.fromEntries(Object.entries(config.features).map(([key, value]) => [`feature.${key}`, value])),
      ...Object.fromEntries(Object.entries(config.payouts).map(([key, value]) => [`payout.${key}`, value])),
    },
  };
  if (!Value.Check(GameMathSimulationRequestSchema, request)) {
    feedback.value = '共享模拟请求 DTO 校验失败。';
    return;
  }
  busy.value = true;
  progress.value = 0;
  report.value = null;
  feedback.value = '正在本机内存中模拟，不会创建牌局或写入业务数据。';
  try {
    const result = await simulateShisanshui({ runs: runCount.value, seed: chosenSeed, scoring: structuredClone(toRaw(config)), onProgress: (done, total) => { progress.value = Math.round(done / total * 100); }, yieldControl: () => new Promise((resolve) => window.setTimeout(resolve, 0)) });
    const dto = {
      gameKey: request.gameKey, difficultyKey: request.difficultyKey, configVersion: request.configVersion,
      modelVersion: result.modelVersion, rulesVersion: result.rulesVersion, seed: result.seed, runs: result.runs,
      strategyKey: result.strategyKey, theoreticalRtp: null, winRate: result.winRate, tieRate: result.tieRate,
      zeroNetRate: result.zeroNetRate, foulRate: result.foulRate, slamRate: result.slamRate,
      homeRunRate: result.homeRunRate, meanNetScore: result.meanNetScore, variance: result.variance,
      standardDeviation: result.standardDeviation, winRate95Ci: result.winRate95Ci,
      rate95Ci: result.rate95Ci, meanNetScore95Ci: result.meanNetScore95Ci,
      distribution: result.distribution, warnings: result.warnings,
    };
    if (!Value.Check(GameMathSimulationReportSchema, dto)) throw new Error('共享模拟报告 DTO 校验失败');
    report.value = result;
    progress.value = 100;
    feedback.value = `${result.runs.toLocaleString()} 局完成。结果仅对当前策略和 seed 有效。`;
  } catch (error) {
    feedback.value = error instanceof Error ? error.message : '模拟失败';
  } finally { busy.value = false; }
}
</script>

<template>
  <section class="game-config-operations-page">
    <div class="game-config-heading">
      <div><p class="eyebrow">游戏运营 / 配置安全</p><h1>{{ title }}</h1><p>{{ gameKey }} · {{ difficultyKey }}。各游戏只显示其已登记的规则 schema 与数学模型。</p></div>
      <PageHelpOverlay title="游戏配置操作说明" trigger-label="查看游戏配置操作说明" :sections="configHelp" />
    </div>
    <nav class="game-config-tabs" aria-label="游戏配置工作区">
      <RouterLink :to="`${scopePath}/config`" :class="{ active: !isExpectation }">配置与发布</RouterLink>
      <RouterLink :to="`${scopePath}/expectation`" :class="{ active: isExpectation }">期望计算器</RouterLink>
    </nav>

    <template v-if="!hasModel">
      <section class="game-config-empty model-not-ready"><span>∑</span><strong>数学模型尚未登记</strong><p>{{ gameKey }} 当前没有版本化规则 schema 与 math model。为避免伪造赔率、RTP 或概率结果，参数编辑和模拟在该游戏模块接入后开放。</p><RouterLink to="/admin/games">返回游戏目录</RouterLink></section>
    </template>
    <template v-else-if="!isExpectation">
      <section class="game-config-panel">
        <div class="game-config-panel-heading"><div><h2>十三张 classic_v1 计分规则候选</h2><p>修改即时影响下方试算；值以水计。游戏配置发布服务尚未接入。</p></div><span>LOCAL_CANDIDATE</span></div>
        <div class="shisanshui-config-layout">
          <fieldset><legend>计分规则开关</legend><label v-for="[key,label] in features" :key="key"><input v-model="config.features[key]" type="checkbox">{{ label }}</label></fieldset>
          <fieldset><legend>奖励水值</legend><label v-for="[key,label] in payouts" :key="key">{{ label }}<input v-model.number="config.payouts[key]" type="number" min="1" max="1000" step="1"></label><label>打枪倍数<input v-model.number="config.slamMultiplier" type="number" min="1" max="1000" step="1"></label><label>全垒打倍数<input v-model.number="config.homeRunMultiplier" type="number" min="1" max="1000" step="1"></label></fieldset>
        </div>
        <div class="game-config-actions"><button type="button" @click="validateCandidate">校验候选</button><RouterLink class="game-config-link-button" :to="`${scopePath}/expectation`">试算候选</RouterLink><button type="button" disabled title="需接入后端 game_config 与审计事务">发布配置（服务端未接入）</button></div>
        <p v-if="feedback" class="game-config-feedback" role="status">{{ feedback }}</p>
      </section>
      <section class="game-config-review-grid"><article><small>规则版本</small><strong>classic_v1</strong><p>调用十三张规则模块的同一套墩型与计分函数。</p></article><article><small>生效范围</small><strong>尚未发布</strong><p>此浏览器候选不影响任何正式牌局。</p></article><article><small>发布审计</small><strong>后端待接</strong><p>正式发布必须校验权限、版本冲突并写入不可变审计。</p></article></section>
    </template>
    <template v-else>
      <section class="game-simulation-controls">
        <div class="game-config-panel-heading"><div><h2>十三张 · 固定策略桌级模拟</h2><p>完整发牌给四个相同的 rank_sorted_partition_v1 策略玩家，并调用正式纯规则 settleRound。</p></div><span>{{ SHISANSHUI_MATH_MODEL_VERSION }}</span></div>
        <div class="simulation-control-grid">
          <label>模拟轮数<el-select v-model.number="runCount"><AdminSelectOption :value="1000">1000 局 · 快速预览</AdminSelectOption><AdminSelectOption :value="10000">10000 局 · 扩大样本</AdminSelectOption></el-select></label>
          <label>随机种子<input v-model="seed" maxlength="128"></label>
          <label>配置版本<input value="LOCAL_CANDIDATE" readonly></label>
          <button type="button" :disabled="busy" @click="simulate">{{ busy ? `模拟中 ${progress}%` : '开始模拟' }}</button>
        </div>
        <progress v-if="busy" class="simulation-progress" :value="progress" max="100" aria-label="模拟进度" />
        <p class="simulation-warning">玩家对战无单人 RTP。胜率依赖策略；固定排序样本不能代表真实玩家、机器人构成或长期收益。模拟全程只使用本机内存。</p>
        <p v-if="feedback" class="game-config-feedback" role="status">{{ feedback }}</p>
      </section>
      <section v-if="report" class="game-config-context-grid"><article><small>模拟样本</small><strong>{{ report.runs.toLocaleString() }} 局</strong><p>Seed: {{ report.seed }}</p></article><article><small>胜率 95% Wilson 区间</small><strong>{{ percent(report.winRate95Ci[0]) }} – {{ percent(report.winRate95Ci[1]) }}</strong><p>仅描述当前固定策略组合</p></article><article><small>规则与策略版本</small><strong>{{ report.rulesVersion }}</strong><p>{{ report.strategyKey }}</p></article><article><small>RTP</small><strong>不适用</strong><p>玩家之间按规则转移水分</p></article></section>
      <section v-if="report" class="simulation-metric-grid" aria-label="模拟指标"><article v-for="[label,value,detail] in metrics" :key="label"><small>{{ label }}</small><strong>{{ value }}</strong><p>{{ detail }}</p></article></section>
      <section v-if="report" class="simulation-results-grid"><article class="simulation-result-panel"><div><h2>净水分布</h2><span>每桌目标席位结果</span></div><div class="simulation-distribution"><div v-for="bucket in report.distribution" :key="bucket.netScore" class="simulation-distribution-row"><b>{{ bucket.netScore > 0 ? '+' : '' }}{{ bucket.netScore }}</b><span><i :style="{ width: `${Math.max(2, bucket.count / maxBucketCount * 100)}%` }"></i></span><small>{{ bucket.count }} · {{ percent(bucket.share) }}</small></div></div></article><article class="simulation-result-panel"><div><h2>结果解释</h2><span>范围与局限</span></div><ul class="simulation-warning-list"><li v-for="warning in report.warnings" :key="warning">{{ warning }}</li><li>本地结果没有持久化，也没有修改 game_config。</li></ul></article></section>
      <section v-else class="simulation-result-panel"><h2>结果分布</h2><div class="simulation-chart-empty"><span>♠</span><strong>选择样本数并开始模拟</strong><small>结果报告会显示固定策略胜率、零分率、相公率、打枪率、全垒打率、净水分布和方差。</small></div></section>
      <section class="game-config-integrity-note"><strong>受约束的参数优化</strong><p>十三张当前模型没有经验证的优化目标和参数搜索范围，因此优化器保持关闭。不会把 Slot RTP 或刺激用户继续下注等指标套用到对战游戏。</p></section>
    </template>
  </section>
</template>
