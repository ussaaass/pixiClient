/**
 * referral 模块跨模块唯一入口（SDD §1 public.ts 约定：模块内聚，对外仅 public.ts）。
 *
 * 领域所有者：referral 模块（referral_binding / referral_binding_event /
 * referral_reward_allocation 3 表 + agent_domain 申请 / 查询 + 邀请码读写
 * 全部用例；Admin 审批 / 暂停 / 撤销端点归 §9 第 9 步 Admin 模块）。
 * 对应 SDD 章节：后端实施 SDD §1（"modules/…/public.ts 跨模块唯一入口"）、
 * §4（application / ports / adapters 布局；构造注入 ports，不用全局）、
 * §9 第 6 步（邀请归因返佣：五级 10/8/5/3、归因幂等、域隔离、代理域申请
 * + 查询、消息补拉一致性）。
 *
 * 导出约定（与 rooms / social / support 模块 public.ts 同款纪律）：
 * - 全部用例类（构造注入 ports，不用全局——SDD §4 "构造注入"）；
 * - ports 接口（供其他模块 / 测试 mock 依赖，不直接 import adapters）；
 * - 装配工厂 `createReferralModule`（由 `assembly.ts` 提供，本入口 re-export）；
 * - 领域纯函数与错误工具（domain/ 子目录；五级返点率 / 域隔离 / 链连续性，
 *   无 IO）；
 * - 本地 ports（5 个 referral 仓储端口）。
 *
 * 与跨模块集成点（装配层）：
 * - `Sequelize` 实例（models 已 addModels 注册，referral 3 model +
 *   agent_domain + user）；
 * - **不依赖 wallet assembly**（归因无资金操作；reward 入账经 wallet ledger
 *   扩展点登记，首版只写分配行 + benefit 投影）；
 * - 仅复用 wallet ports 的 `Tx` 接口契约（跨模块复用，不重定义两套，
 *   与 rooms / social 模块同款纪律）。
 */

// ---------------------------------------------------------------------------
// 用例类（application/；构造注入 ports，不用全局）
// ---------------------------------------------------------------------------
export {
  InviteLinkUseCase,
  type InviteLinkDto,
  INVITE_CODE_LENGTH,
  INVITE_CODE_TTL_SECONDS,
  generateInviteCode,
} from './application/invite-link.js';
export {
  ReferralListUseCase,
  type DirectInviteeDto,
  type DirectInviteesPageDto,
  type RewardItemDto,
  type RewardsPageDto,
  REFERRAL_PAGE_LIMIT,
} from './application/referral-list.js';
export { AttributionUseCase, type AttributionInput, type AttributionResultDto } from './application/attribution.js';
export { AgentDomainUseCase, type AgentDomainDto, type AgentDomainApplyResultDto } from './application/agent-domain.js';

// ---------------------------------------------------------------------------
// 装配工厂（inject 全部 ports 的 ReferralModule 对象，供 server 装配调用一次）
// ---------------------------------------------------------------------------
export { createReferralModule, type ReferralModule, type ReferralModuleDeps, type ReferralModuleConfig } from './assembly.js';

// ---------------------------------------------------------------------------
// ports（供其他模块 / 测试 mock；不直接 import adapters）
// ---------------------------------------------------------------------------
export type {
  ReferralBindingRepo,
  BindingEventRepo,
  RewardAllocationRepo,
  AgentDomainRepo,
  UserInviteRepo,
  Tx,
} from './ports/referral-repository.js';

// ---------------------------------------------------------------------------
// 领域纯函数与错误工具（domain/；五级返点率 / 域隔离 / 链连续性，无 IO）
// ---------------------------------------------------------------------------
export { ReferralDomainError, REF, isReferralDomainError, isDuplicateKeyError, type ReferralErrorCode } from './domain/errors.js';
export {
  REWARD_RATES_BPS,
  rateBpsOf,
  MAX_ANCESTOR_DEPTH,
  isValidBindingChain,
  isDomainIsolationLegal,
  isRewardUnlockable,
  AgentDomainStatus,
  canApplyAgentDomain,
  type AgentDomainStatusValue,
} from './domain/binding-rules.js';

// ---------------------------------------------------------------------------
// 适配器（Sequelize 实现；每表一类；供测试直接构造，生产经 createReferralModule）
// ---------------------------------------------------------------------------
export {
  SequelizeReferralBindingRepo,
  SequelizeBindingEventRepo,
  SequelizeRewardAllocationRepo,
  SequelizeAgentDomainRepo,
  SequelizeUserInviteRepo,
} from './adapters/sequelize-referral.js';
