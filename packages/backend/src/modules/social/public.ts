/**
 * social 模块跨模块唯一入口（SDD §1 public.ts 约定：模块内聚，对外仅 public.ts）。
 *
 * 领域所有者：social 模块（social_topic / social_post / social_post_reply /
 * social_friendship / social_conversation / social_message 6 表用例 +
 * 审核/屏蔽/举报/互动 4 表归 §9 第 9 步 Admin 模块）。
 * 对应 SDD 章节：后端实施 SDD §1（"modules/…/public.ts 跨模块唯一入口"）、
 * §4（application / ports / adapters 布局；构造注入 ports，不用全局）、
 * §9 第 5 步（社交与客服：双账号私信幂等、坐席领取/回复/重开、消息补拉
 * 一致性、消息 outbox→Socket 双端投递）。
 *
 * 导出约定（与 rooms / wallet 模块 public.ts 同款纪律）：
 * - 全部用例类（构造注入 ports，不用全局——SDD §4 "构造注入"）；
 * - ports 接口（供其他模块 / 测试 mock 依赖，不直接 import adapters）；
 * - 装配工厂 `createSocialModule`（由 `assembly.ts` 提供，本入口 re-export）；
 * - 领域纯函数与错误工具（domain/ 子目录；游标/幂等键/pair 归一，无 IO）；
 * - 本地 ports（4 个 social 仓储端口）。
 *
 * 与跨模块集成点（装配层）：
 * - `Clock`（时钟注入，测试可传固定时钟）；
 * - `OutboxPort`（同事务 outbox，§6.3 "所有分录/outbox 同事务"；
 *   topic `social.message` 经 outbox worker 投递 /platform 两侧，
 *   §6.3 未闭环项，本模块只写 outbox 行）；
 * - `Sequelize` 实例（models 已 addModels 注册，social 9 model + outbox）。
 *
 * 注：social 模块不依赖 wallet assembly（不触 AssetLedger）；
 * 仅复用 wallet ports 的 `Tx` / `Clock` / `OutboxPort` 接口契约（跨模块
 * 复用，不重定义两套，与 rooms 模块 ports/rooms-repository-exports.ts
 * 同款纪律）。
 */

// ---------------------------------------------------------------------------
// 用例类（application/；构造注入 ports，不用全局）
// ---------------------------------------------------------------------------
export {
  PostCreateUseCase,
  type PostCreatedDto,
  PostReplyUseCase,
  type ReplyCreatedDto,
  ConversationCreateUseCase,
  type ConversationCreatedDto,
  MessageSendUseCase,
  type MessageSentDto,
  MessageListUseCase,
  type MessageListDto,
  FriendshipUseCase,
  type FriendshipResultDto,
} from './application/index.js';

// ---------------------------------------------------------------------------
// 装配工厂（inject 全部 ports 的 SocialModule 对象，供 server 装配调用一次）
// ---------------------------------------------------------------------------
export {
  createSocialModule,
  outboxForSocialModule,
  type SocialModule,
  type SocialModuleDeps,
  type SocialModuleConfig,
} from './assembly.js';

// ---------------------------------------------------------------------------
// ports（供其他模块 / 测试 mock；不直接 import adapters）
// ---------------------------------------------------------------------------
export type { PostRepo, ConversationRepo, MessageRepo, FriendshipRepo } from './ports/social-repository.js';

// 跨模块复用 wallet ports（经 social-repository-exports 统一入口，
// 不直接跨模块 import 内部文件，保持模块内聚）
export type { OutboxPort, OutboxAppendInput, Clock, Tx } from './ports/social-repository-exports.js';
export { SystemClock } from './ports/social-repository-exports.js';

// ---------------------------------------------------------------------------
// 领域纯函数与错误工具（domain/；游标/幂等键/pair 归一，无 IO）
// ---------------------------------------------------------------------------
export { SocialDomainError, S, isSocialDomainError, isDuplicateKeyError, type SocialErrorCode } from './domain/errors.js';
export {
  normalizePair,
  nextMessageNo,
  normalizeMessageCursor,
  canAdvanceReadThrough,
  supportClaimKeyOf,
  MESSAGE_PAGE_LIMIT,
} from './domain/message-rules.js';

// ---------------------------------------------------------------------------
// 适配器（Sequelize 实现；每表一类；供测试直接构造，生产经 createSocialModule）
// ---------------------------------------------------------------------------
export {
  SequelizePostRepo,
  SequelizeConversationRepo,
  SequelizeMessageRepo,
  SequelizeFriendshipRepo,
} from './adapters/sequelize-social.js';
