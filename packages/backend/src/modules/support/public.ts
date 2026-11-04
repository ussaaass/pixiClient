/**
 * support 模块跨模块唯一入口（SDD §1 public.ts 约定：模块内聚，对外仅 public.ts）。
 *
 * 领域所有者：support 模块（support_conversation / support_message 2 表全部用例）。
 * 对应 SDD 章节：后端实施 SDD §1（"modules/…/public.ts 跨模块唯一入口"）、
 * §4（application / ports / adapters 布局；构造注入 ports，不用全局）、
 * §9 第 5 步（社交与客服：坐席队列 + 消息 outbox→Socket 双端投递 +
 * 断线补拉）。
 *
 * 导出约定（与 social / rooms 模块 public.ts 同款纪律）：
 * - 全部用例类（构造注入 ports，不用全局——SDD §4 "构造注入"）；
 * - ports 接口（供其他模块 / 测试 mock 依赖，不直接 import adapters）；
 * - 装配工厂 `createSupportModule`（由 `assembly.ts` 提供，本入口 re-export）；
 * - 领域纯函数与错误工具（domain/ 子目录；claim 幂等键/权限检查/状态机
 *   转换校验，无 IO）；
 * - 本地 ports（2 个 support 仓储端口）。
 *
 * 与跨模块集成点（装配层）：
 * - `Clock`（时钟注入，测试可传固定时钟）；
 * - `OutboxPort`（同事务 outbox，§6.3 "所有分录/outbox 同事务"；
 *   topic `support.message` 经 outbox worker 落地后投 /platform 与 /admin
 *   两侧，§6.3 未闭环项，本模块只写行）；
 * - `Sequelize` 实例（models 已 addModels 注册，support 2 model + outbox）。
 *
 * 注：support 模块不依赖 wallet assembly（不触 AssetLedger）；
 * 仅复用 wallet ports 的 `Tx` / `Clock` / `OutboxPort` 接口契约（跨模块
 * 复用，不重定义两套，与 social 模块同款纪律）。
 * 坐席 Admin audience 中间件归 §9 第 9 步；首版 claim/reply/resolve 端点
 * 同 player token + role_type 校验。
 */

// ---------------------------------------------------------------------------
// 用例类（application/；构造注入 ports，不用全局）
// ---------------------------------------------------------------------------
export {
  TicketCreateUseCase,
  type ConversationCreatedDto,
  TicketListUseCase,
  type ConversationListDto,
  TicketClaimUseCase,
  type ClaimResultDto,
  TicketReplyUseCase,
  type ReplyResultDto,
  TicketResolveUseCase,
  type ResolveResultDto,
} from './application/index.js';

// ---------------------------------------------------------------------------
// 装配工厂（inject 全部 ports 的 SupportModule 对象，供 server 装配调用一次）
// ---------------------------------------------------------------------------
export {
  createSupportModule,
  outboxForSupportModule,
  type SupportModule,
  type SupportModuleDeps,
  type SupportModuleConfig,
} from './assembly.js';

// ---------------------------------------------------------------------------
// ports（供其他模块 / 测试 mock；不直接 import adapters）
// ---------------------------------------------------------------------------
export type { TicketRepo, SupportMessageRepo } from './ports/support-repository.js';

// 跨模块复用 wallet ports（经 support-repository-exports 统一入口，
// 不直接跨模块 import 内部文件，保持模块内聚）
export type { OutboxPort, OutboxAppendInput, Clock, Tx } from './ports/support-repository-exports.js';
export { SystemClock } from './ports/support-repository-exports.js';

// ---------------------------------------------------------------------------
// 领域纯函数与错误工具（domain/；claim 幂等键/权限检查/状态机转换校验，无 IO）
// ---------------------------------------------------------------------------
export { SupportDomainError, SUP, isSupportDomainError, isDuplicateKeyError, type SupportErrorCode } from './domain/errors.js';
export { supportClaimKeyOf, canAdminReply, isValidConversationStatusTransition } from './domain/ticket-rules.js';

// ---------------------------------------------------------------------------
// 适配器（Sequelize 实现；每表一类；供测试直接构造，生产经 createSupportModule）
// ---------------------------------------------------------------------------
export { SequelizeTicketRepo, SequelizeSupportMessageRepo } from './adapters/sequelize-support.js';
