import { GameCatalogIntegrationType, GameCatalogStatus, type GameCatalogDto } from './game-catalog.js';
import type { GameExperienceDto } from './game-experience.js';

/** Built-in preview catalog used by the offline browser server and by the H5 lobby card list. */
export const LOBBY_GAME_REFERENCE: readonly GameCatalogDto[] = [
  { gameId: '990000000000000001', gameKey: 'slot5', gameCode: 'jump-high-high', name: '跳高高', category: 'Slot 类游戏', description: '5 列转轴 · 多线玩法 · 积分系统', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: null, coverAssetId: '991000000000000001', sortOrder: 10, status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: '2026-01-01T00:00:00.000Z' },
  { gameId: '990000000000000002', gameKey: 'slot3', gameCode: 'treasure-hero', name: '夺宝奇侠', category: 'Slot 类游戏', description: '3 列转轴 · 多线玩法 · 积分系统', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: null, coverAssetId: '991000000000000002', sortOrder: 20, status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: '2026-01-01T00:00:00.000Z' },
  { gameId: '990000000000000003', gameKey: 'mahjong-hule', gameCode: 'mahjong-hule', name: '麻将胡了', category: '麻将', description: '麻将主题游戏模块规划中', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: null, coverAssetId: '991000000000000003', sortOrder: 30, status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: '2026-01-01T00:00:00.000Z' },
  { gameId: '990000000000000004', gameKey: 'shisanshui', gameCode: 'shisanshui', name: '十三张', category: '棋牌', description: '整理三道，逐墩比牌', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: '@gameing/shisanshui-client', coverAssetId: '991000000000000004', sortOrder: 40, status: GameCatalogStatus.ACTIVE, isPlayable: true, updatedAt: '2026-01-01T00:00:00.000Z' },
  { gameId: '990000000000000005', gameKey: 'mahjong-hule-2', gameCode: 'mahjong-hule-2', name: '麻将胡了 2', category: '麻将', description: '麻将主题游戏模块规划中', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: null, coverAssetId: '991000000000000005', sortOrder: 50, status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: '2026-01-01T00:00:00.000Z' },
  { gameId: '990000000000000006', gameKey: 'fishing', gameCode: 'fishing', name: '捕鱼', category: '街机', description: '捕鱼游戏模块规划中', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: null, coverAssetId: '991000000000000006', sortOrder: 60, status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: '2026-01-01T00:00:00.000Z' },
  { gameId: '990000000000000007', gameKey: 'bounty-queen', gameCode: 'bounty-queen', name: '赏金女王', category: '老虎机', description: '赏金女王游戏模块规划中', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: null, coverAssetId: '991000000000000007', sortOrder: 70, status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: '2026-01-01T00:00:00.000Z' },
  { gameId: '990000000000000008', gameKey: 'three-fast', gameCode: 'three-fast', name: '3快', category: '数字开奖', description: '3快游戏模块规划中', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: null, coverAssetId: '991000000000000008', sortOrder: 80, status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: '2026-01-01T00:00:00.000Z' },
];

export const LOBBY_GAME_COVER_OPTIONS = LOBBY_GAME_REFERENCE.map((game, index) => ({
  assetId: `99100000000000000${index + 1}`,
  name: `${game.name} 游戏封面`,
  previewUrl: `/assets/game-icons/${game.gameCode}.webp`,
  mimeType: 'image/webp' as const,
}));

const demoHalls = [
  { difficultyKey: 'entry', title: '体验厅', summary: '低门槛熟悉操作', minBetCoins: '10', currentMultiplier: 1, maxMultiplier: 5, sortOrder: 1, enabled: true },
  { difficultyKey: 'regular', title: '标准厅', summary: '标准节奏与投入范围', minBetCoins: '100', currentMultiplier: 1, maxMultiplier: 10, sortOrder: 2, enabled: true },
  { difficultyKey: 'advanced', title: '进阶厅', summary: '较高投入范围', minBetCoins: '1000', currentMultiplier: 1, maxMultiplier: 20, sortOrder: 3, enabled: true },
] as const;
const shisanshuiDemoHalls = [
  { difficultyKey: 'beginner', title: '新手厅', summary: '熟悉规则 · 练习摆牌', minBetCoins: '10', currentMultiplier: 1, maxMultiplier: 5, sortOrder: 1, enabled: true },
  { difficultyKey: 'advanced', title: '进阶厅', summary: '练习手动摆牌与比较', minBetCoins: '50', currentMultiplier: 1, maxMultiplier: 10, sortOrder: 2, enabled: true },
  { difficultyKey: 'strategy', title: '策略厅', summary: '练习牌型组合与取舍', minBetCoins: '100', currentMultiplier: 1, maxMultiplier: 20, sortOrder: 3, enabled: true },
] as const;

const subhallBackgroundAssetIds: Record<string, string> = {
  slot5: '992000000000000001',
  slot3: '992000000000000002',
  'mahjong-hule': '992000000000000003',
  shisanshui: '992000000000000004',
  'mahjong-hule-2': '992000000000000005',
  fishing: '992000000000000006',
  'bounty-queen': '992000000000000007',
  'three-fast': '992000000000000008',
};

const hallCopy: Record<string, Pick<GameExperienceDto, 'title' | 'description' | 'gameplay' | 'subhallBackgroundUrl' | 'entryMode' | 'attribution' | 'references'>> = {
  slot5: {
    title: '跳高高', description: '五轴多路主题老虎机，以跃动灯光、连线组合与积分记录营造轻快节奏。',
    gameplay: [
      { title: '一局怎么玩', body: '选择当前难度和投入档位后开始旋转。转轴停止后，系统检查图标组合并展示本轮得分；没有命中时，本轮结束并进入下一次旋转。' },
      { title: '243 路组合', body: '公开原版资料采用 5 轴 243 路：不需要预选固定线，图标从最左轴开始连续相邻出现 3 个或以上即可形成组合；中间断开则该组合不成立。' },
      { title: '普通得分', body: '每种图标有对应的连中数量和分值。多条有效组合可以在同一旋转中分别结算，最终得分按当前投入档和已发布的符号表计算。' },
      { title: '金球与免费游戏', body: '金球是分散图标，不按普通连线计算。公开原版资料中，金球分布达到触发条件后进入免费游戏；金球数量也会影响奖励倍数的起点和递增幅度。' },
      { title: '免费游戏过程', body: '免费游戏内的有效组合会乘上当前奖励倍数，倍数随免费游戏进度提高；触发次数、起始倍数和每轮增幅以实际游戏版本的规则面板为准。' },
      { title: '项目奖励轮', body: '本项目可按游戏配置启用免费轮或翻倍轮。未启用时不会触发；启用后的触发条件、次数与倍数由当前公布的游戏规则说明。' },
      { title: '结算与积分', body: '每次旋转先按当前投入记账，再累加本轮普通组合与奖励轮得分。此游戏模块尚未接入，当前页面不会随机旋转、改变积分或派发金币。' },
      { title: '本项目规则边界', body: '243 路与金球玩法用于说明公开原版机制。本项目的图标、符号表、分值、免费轮参数和积分结算尚未发布，不代表原厂赔率或真实派奖。' },
    ],
    subhallBackgroundUrl: '/assets/game-subhalls/jump-high-high.webp', entryMode: 'MODULE_STUB',
    attribution: '玩法摘要参考 CQ9《跳高高》公开介绍；本项目规则、赔率与素材均独立配置。',
    references: [],
  },
  slot3: {
    title: '夺宝奇侠', description: '三轴多线 Slot 概念厅，围绕寻宝主题与积分累计展示玩法入口。',
    gameplay: [
      { title: '一局怎么玩', body: '选择难度和投入档位后启动三列转轴。停轮后，系统逐条检查已启用的连线，再把本轮命中结果计入积分；随后可以开始下一轮。' },
      { title: '多线判定', body: '每条有效线由转轴位置组成。只有该线规定位置上的图标按规则连续匹配时才算命中；同一轮可以有多条线分别命中并累计得分。' },
      { title: '组合与得分', body: '命中图标种类、连续数量和对应分值决定单条线结果；多条命中结果汇总为本轮得分。实际连线图、替代图标和分值表需在游戏模块内展示。' },
      { title: '积分过程', body: '本项目规划为积分型玩法：每轮记录投入、命中组合和积分变化。当前卡片中的投入档和倍率是演示参数，未连接正式积分账户。' },
      { title: '免费轮与翻倍轮', body: '本项目可配置积分事件或指定触发条件，奖励一次或多次免费轮，也可触发翻倍轮。触发概率、次数、倍率及其是否连锁均须以已发布配置为准。' },
      { title: '自动模式', body: '游戏模块上线后可由玩家选择自动轮数和每轮投入；停止、余额不足或连接中断时按自动模式规则暂停。奖励轮是否计入自动轮数由 handler 明确显示。' },
      { title: '本项目规则边界', body: '已确认的产品方向是三列、多线与积分；具体线数、符号、命中优先级、奖励条件和积分公式仍待 slot3 handler 与期望计算器定稿。' },
    ],
    subhallBackgroundUrl: '/assets/game-subhalls/treasure-hero.webp', entryMode: 'MODULE_STUB',
    attribution: '按本项目已确认的 Slot3 多线+积分定位编写；没有可核验的同名厂商规则资料。', references: [],
  },
  'mahjong-hule': {
    title: '麻将胡了', description: '麻将主题卷轴玩法，以相邻图标组合、消除级联和免费旋转构成回合节奏。',
    gameplay: [
      { title: '卷轴与 ways', body: '公开原版为 5 轴 4 行、最多 1024 ways。它不要求图标落在固定横线：从最左轴起，连续相邻卷轴出现相同图标即可组成中奖方式。' },
      { title: '组合如何计数', body: '每一轴上符合条件的相同图标位置数相乘，得到该图标的 ways 数；例如连续三轴分别有 1、2、3 个可用位置，就形成 6 种组合。' },
      { title: '百搭与金牌', body: 'Wild 可替代普通图标参与组合，但不替代 Scatter。部分普通图标会以金牌样式出现；若金牌参与命中，后续级联中可转成 Wild。' },
      { title: '消除级联', body: '结算本次命中后，中奖图标从卷轴移除，上方图标下落并由新图标补位。新局面会再次检查组合，重复到没有新中奖组合为止。' },
      { title: '免费旋转', body: '公开原版中，任意位置出现 3 个 Scatter 可触发 12 次免费旋转；每多 1 个 Scatter 增加 2 次。免费旋转带有递增倍数，并可再次触发。' },
      { title: '奖励结算顺序', body: '一轮中每次级联的有效组合依次计奖，最后汇总为本轮结果。免费旋转奖励与普通旋转分开展示，具体规则以游戏内规则面板为准。' },
      { title: '本项目规则边界', body: '以上玩法参考公开版《Mahjong Ways》。本项目模块尚未接入；实际符号、Wild/Scatter、级联、奖励次数、倍率与分值以本项目已发布配置为准。' },
    ],
    subhallBackgroundUrl: '/assets/game-subhalls/mahjong-hule.webp', entryMode: 'MODULE_STUB',
    attribution: '玩法类型参考 PG SOFT《Mahjong Ways》官方资料；本项目配置尚未发布。',
    references: [],
  },
  shisanshui: {
    title: '十三张', description: '整理十三张牌，分成头、中、底三道，与桌上牌友逐墩比较。',
    gameplay: [
      { title: '人数与牌数', body: '四人使用一副去掉大小王的 52 张牌，每人 13 张。' },
      { title: '分墩与摆牌', body: '头墩 3 张，中墩与底墩各 5 张；头墩 ≤ 中墩 ≤ 底墩，倒道按相公处理。' },
      { title: '牌型与计分', body: '牌型从同花顺、铁支、葫芦、同花、顺子、三条、两对、对子到乌龙；特殊牌型与打枪奖励按牌桌配置。' },
    ],
    subhallBackgroundUrl: '/assets/game-subhalls/shisanshui.webp', entryMode: 'LOCAL_PRACTICE',
    attribution: '按项目十三张规则说明；当前只提供本地免费练习，不涉及真实金币结算。', references: [],
  },
  'mahjong-hule-2': {
    title: '麻将胡了 2', description: '麻将主题的级联卷轴玩法，加入金牌转化与递增倍率的免费旋转模式。',
    gameplay: [
      { title: '卷轴与 ways', body: '公开原版采用 5 轴结构：第 2、3、4 轴比基础布局各多一行，共形成最多 2000 ways。组合从最左轴开始，按相邻卷轴的匹配位置计算。' },
      { title: '命中与级联', body: '普通图标按连中数量对应分值。命中后中奖图标消除，上方图标下落并补入新图标；每次下落后的新组合都会继续检查并计入同一轮。' },
      { title: 'Wild 与金牌', body: 'Wild 可替代普通图标参与 ways 组合，不替代 Scatter。免费旋转中，第 3 轴的普通图标会显示为金牌；参与中奖的金牌在后续级联中转成 Wild。' },
      { title: '免费旋转触发', body: '公开原版中，任意位置出现 3 个 Scatter 可获得 10 次免费旋转；每多 1 个 Scatter 增加 2 次，免费旋转也可能重新触发。' },
      { title: '免费旋转倍数', body: '免费旋转的奖励倍数随连锁阶段提升，公开规则列出 x2、x4、x6、x10 档。倍率作用与累计方式以实际版本的规则面板说明为准。' },
      { title: '单轮结果', body: '普通旋转中的多个级联结果合并结算；免费旋转另行累计奖励，结束时汇总显示。本项目当前没有接入原版结算服务或原厂符号表。' },
      { title: '本项目规则边界', body: '以上玩法参考公开版《Mahjong Ways 2》，不代表本项目当前赔率。游戏模块尚未接入，本项目触发条件、奖励次数、倍率和得分表上线前须经配置及模拟验算。' },
    ],
    subhallBackgroundUrl: '/assets/game-subhalls/mahjong-hule-2.webp', entryMode: 'MODULE_STUB',
    attribution: '玩法类型参考 PG SOFT《Mahjong Ways 2》官方资料；本项目配置尚未发布。',
    references: [],
  },
  fishing: {
    title: '捕鱼', description: '多人实时街机主题，瞄准游动目标、发射炮弹并与房间内玩家协同游玩。',
    gameplay: [
      { title: '实时操作', body: '进入渔场后选择炮台档位，点按或按住目标方向发射。炮台档位决定单发消耗；切换档位会同步改变每次射击投入。' },
      { title: '目标与捕获', body: '鱼群会持续移动，不同目标具有不同捕获难度和奖励配置。子弹命中不等于必定捕获，是否捕获及奖励结果由服务端统一判定。' },
      { title: '多人同场', body: '玩家共享同一渔场画面，可以同时瞄准游动目标。Boss、特殊鱼种和限时事件属于单独配置的玩法，不应仅凭动画推断奖励结果。' },
      { title: '投入与结算', body: '每发炮弹按当前炮档扣除投入；成功捕获后按目标规则结算，未捕获的射击也会消耗对应投入。具体消耗、奖励和倍率必须在开炮前清楚展示。' },
      { title: '网络与断线', body: '捕鱼属于实时同步玩法。断线期间客户端不应自行补算捕获或派奖；重连后应以服务端房间状态和已确认的射击回执恢复画面。' },
      { title: '本项目规则边界', body: '本项目捕鱼 handler 和实时房间尚未接入。当前页面仅说明操作流程，不模拟命中、消耗、Boss 奖励或真实积分变化。' },
    ],
    subhallBackgroundUrl: '/assets/game-subhalls/fishing.webp', entryMode: 'MODULE_STUB',
    attribution: '按捕鱼类实时射击游戏的一般交互和本项目模块规划概述；不是某一厂商的具体规则。', references: [],
  },
  'bounty-queen': {
    title: '赏金女王', description: '海盗寻宝主题的级联卷轴玩法，组合命中后继续消除并累计回合倍率。',
    gameplay: [
      { title: '卷轴与中奖线', body: '公开原版为 5 轴 3 行、20 条固定中奖线。每条线按规则指定的位置从左向右检查连续相同图标；不同图标与连中长度有各自分值。' },
      { title: '消除级联', body: '出现中奖组合后，中奖符号消失，新符号落下补位；补位后若形成新组合，就在同一旋转里继续结算，直到无法再组成中奖线。' },
      { title: '递增倍数', body: '公开原版的普通旋转中，中奖后倍数会提高，后续级联赢分应用当时的倍数；本轮结束后按规则重置或保留，具体看对应游戏模式。' },
      { title: '免费旋转触发', body: '公开原版中，3 个或以上 Scatter 可触发免费旋转。触发后可在不同免费次数与倍数方案中选择，选项与对应奖励会在确认前展示。' },
      { title: '免费旋转结算', body: '免费旋转期间继续按中奖线和级联规则结算，并使用所选方案的奖励倍数；公开规则中免费旋转倍数最高可到 x40。' },
      { title: '一轮结果', body: '单次付费旋转的基础命中、后续级联和倍数奖励汇总为一笔结果；免费旋转单独累计，结束后再显示奖励合计。' },
      { title: '本项目规则边界', body: '以上机制参考公开版《Queen of Bounty》。本项目 handler 尚未接入，线数、图标、倍数、免费旋转选择和积分规则以本项目后续发布版本为准。' },
    ],
    subhallBackgroundUrl: '/assets/game-subhalls/bounty-queen.webp', entryMode: 'MODULE_STUB',
    attribution: '玩法类型参考 PG SOFT《Queen of Bounty》官方资料；本项目配置尚未发布。',
    references: [],
  },
  'three-fast': {
    title: '3快', description: '外部数据源驱动的快开彩种：每期开放三分钟投注，随后按来源数据开奖。',
    gameplay: [
      { title: '一期的时间', body: '每期开放 3 分钟投注，截止后封盘并等待开奖。页面应同时显示期号、剩余投注时间、封盘状态和预计开奖状态。' },
      { title: '如何投注', body: '玩家从当期开放的投注项目中选择内容和投入，确认前查看本期投注说明与可能的结算方式；已封盘的期次不能再新增投注。' },
      { title: '开奖与核验', body: '开奖号码由配置的数据源提供。服务端记录来源、期号和原始开奖结果并进行校验，客户端不得生成、修改或补齐开奖结果。' },
      { title: '结果结算', body: '开奖确认后，handler 按该期已接受的投注和对应玩法规则逐单核算，展示开奖号码、命中项、结算明细和下一期状态。' },
      { title: '异常期次', body: '数据源延迟、缺期或结果校验失败时，期次应标记为处理中并提供客服入口；不能显示猜测结果，也不能提前结算。' },
      { title: '本项目规则边界', body: '当前已确认的产品节奏是 3 分钟投注、随后开奖；具体彩种、投注项、封盘缓冲、开奖供应商和派彩公式尚未配置，因此本页面不模拟下注或开奖。' },
    ],
    subhallBackgroundUrl: '/assets/game-subhalls/three-fast.webp', entryMode: 'MODULE_STUB',
    attribution: '开奖节奏与数据来源按本项目已确认需求；未绑定真实数据供应商。', references: [],
  },
};

export const LOBBY_GAME_EXPERIENCE_REFERENCE: readonly GameExperienceDto[] = LOBBY_GAME_REFERENCE.map((game) => ({
  source: 'LOCAL_DEMO',
  game,
  ...hallCopy[game.gameKey]!,
  subhallBackgroundAssetId: subhallBackgroundAssetIds[game.gameKey]!,
  difficultyHalls: (game.gameKey === 'shisanshui' ? shisanshuiDemoHalls : demoHalls).map((hall) => ({ ...hall })),
}));
