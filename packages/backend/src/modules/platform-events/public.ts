/**
 * platform-events 模块跨模块唯一入口（SDD §1 public.ts 约定：模块内聚，
 * 对外仅 public.ts）。
 *
 * 领域所有者：platform-events 模块（game_event_instance 活跃公告读用例 +
 * 公告投影；公告写路径归 configuration / Admin 模块，§9 第 7 步 / 第 9 步）。
 * 对应 SDD 章节：后端实施 SDD §1（"modules/…/public.ts 跨模块唯一入口"）、
 * §4（application / ports / adapters 布局；构造注入 ports，不用全局）、
 * §9 第 7 步（平台事件公告：活跃公告读 + 公告投影 wire，替换公告 stub）。
 *
 * 导出约定（与 rooms / social / support / referral 模块 public.ts 同款纪律）：
 * - 全部用例类（构造注入 ports，不用全局——SDD §4 "构造注入"）；
 * - ports 接口（供其他模块 / 测试 mock 依赖，不直接 import adapters）；
 * - 装配工厂 `createPlatformEventsModule`（由 `assembly.ts` 提供，本入口 re-export）；
 * - 领域纯函数与错误工具（domain/ 子目录；公告投影 / 事件类型映射，无 IO）；
 * - 本地 ports（1 个 platform-events 仓储端口）。
 *
 * 与跨模块集成点（装配层）：
 * - `Sequelize` 实例（models 已 addModels 注册，game_event_instance 经 game.ts）；
 * - **不依赖 wallet assembly**（读路径无资金操作）；
 * - 仅复用 wallet ports 的 `Tx` / `Clock` 接口契约（跨模块复用，不重定义两套，
 *   与 rooms / social / referral 模块同款纪律）。
 */

// ---------------------------------------------------------------------------
// 用例类（application/；构造注入 ports，不用全局）
// ---------------------------------------------------------------------------
export { ActiveAnnouncementsUseCase, type ActiveAnnouncementsDto, ANNOUNCEMENT_PAGE_LIMIT } from './application/active-announcements.js';

// ---------------------------------------------------------------------------
// 装配工厂（inject 全部 ports 的 PlatformEventsModule 对象，供 server 装配调用一次）
// ---------------------------------------------------------------------------
export {
  createPlatformEventsModule,
  type PlatformEventsModule,
  type PlatformEventsModuleDeps,
  type PlatformEventsModuleConfig,
} from './assembly.js';

// ---------------------------------------------------------------------------
// ports（供其他模块 / 测试 mock；不直接 import adapters）
// ---------------------------------------------------------------------------
export type { GameEventInstanceRepo, Tx } from './ports/platform-events-repository.js';

// ---------------------------------------------------------------------------
// 领域纯函数与错误工具（domain/；公告投影 / 事件类型映射，无 IO）
// ---------------------------------------------------------------------------
export {
  PlatformEventsDomainError,
  PE,
  isPlatformEventsDomainError,
  isDuplicateKeyError,
  type PlatformEventsErrorCode,
} from './domain/errors.js';
export {
  PlatformEventType,
  type PlatformEventTypeValue,
  eventTypeOf,
  projectAnnouncement,
  type AnnouncementWire,
  type AnnouncementSnapshot,
} from './domain/event-rules.js';

// ---------------------------------------------------------------------------
// 适配器（Sequelize 实现；每表一类；供测试直接构造，生产经 createPlatformEventsModule）
// ---------------------------------------------------------------------------
export { SequelizeGameEventInstanceRepo } from './adapters/sequelize-platform-events.js';
