/**
 * admin 模块跨模块唯一入口（SDD §1 public.ts 约定：模块内聚，对外仅
 * public.ts）。
 *
 * 领域所有者：admin 模块（agent_domain 审批/暂停/撤销 + admin_audit_event
 * append-only + coin_market_trade 裁决 + withdrawal 双人复核 +
 * ai_asset_job 审核推进 + Admin 用户列表/详情 + Admin 登录 全部用例；
 * models/admin.ts 4 model 的唯一写入点 + 跨模块 model 经本层端口读）。
 * 对应 SDD 章节：后端实施 SDD §1（"modules/…/public.ts 跨模块唯一入口"）、
 * §4（application / ports / adapters 布局；构造注入 ports，不用全局）、
 * §9 第 9 步（Admin 全量切换收口：/admin-api/v1 端点 + Admin audience
 * 鉴权 + 双人复核 + 审计 append-only）。
 *
 * 导出约定（与 referral / coin-market / ai-assets 模块 public.ts 同款
 * 纪律）：
 * - 全部用例类（构造注入 ports，不用全局——SDD §4 "构造注入"）；
 * - ports 接口（供其他模块 / 测试 mock 依赖，不直接 import adapters）；
 * - 装配工厂 `createAdminModule`（由 `assembly.ts` 提供，本入口 re-export）；
 * - 领域纯函数与错误工具（domain/ 子目录；状态机转换表 / 审计脱敏校验，
 *   无 IO）；
 * - 本地 ports（7 个 admin 仓储端口）。
 *
 * 与跨模块集成点（装配层）：
 * - `Sequelize` 实例（models 已 addModels 注册，admin 4 model +
 *   coin_market_trade + withdrawal + ai_asset_job + user）；
 * - **不依赖 walletModule**（审计 / 审批 / 裁决无资金操作；withdrawal
 *   推进经 status 列 UPDATE，不触资；出账经 payout worker 闭环，
 *   登记决策点）；
 * - 仅复用 wallet ports 的 `Tx` 接口契约（跨模块复用，不重定义两套，
 *   与 referral / coin-market / ai-assets 模块同款纪律）；
 * - 复用 identity domain 纯函数（verifyPassword / verifyTotp /
 *   maskEmail / maskPhone，Admin 登录 + 用户详情脱敏；跨模块复用，
 *   不重定义两套，登记扩展点）。
 */

// ---------------------------------------------------------------------------
// 用例类（application/；构造注入 ports，不用全局）
// ---------------------------------------------------------------------------
export { AgentDomainApproveUseCase, type AgentDomainApprovedDto } from './application/agent-domain-approve.js';
export { AgentDomainSuspendUseCase, type AgentDomainSuspendedDto } from './application/agent-domain-suspend.js';
export { AgentDomainRevokeUseCase, type AgentDomainRevokedDto } from './application/agent-domain-revoke.js';
export { AdminAuditCreateUseCase, type AdminAuditCreatedDto } from './application/admin-audit.js';
export { CoinMarketAdjudicateUseCase, type TradeAdjudicatedDto } from './application/coin-market-adjudicate.js';
export { AiAssetsReviewUseCase, type AiJobReviewedDto } from './application/ai-assets-review.js';
export {
  AdminUserListUseCase,
  type AdminUserListFilters,
  type AdminUserItemDto,
  type AdminUserPageDto,
  ADMIN_USER_PAGE_LIMIT,
} from './application/admin-user-list.js';
export {
  AdminUserDetailUseCase,
  AdminUserDetailSection,
  type AdminUserDetailSectionValue,
  type AdminUserDetailSectionDto,
  isValidAdminUserDetailSection,
} from './application/admin-user-detail.js';
export { WithdrawalReviewUseCase, type WithdrawalApprovedDto, type WithdrawalRejectedDto } from './application/withdrawal-review.js';
export { AdminLoginUseCase, type AdminLoginInput, type AdminLoginResultDto } from './application/admin-login.js';
export {
  SupportAdminCapabilityAuthorizeUseCase,
  SUPPORT_ADMIN_PERMISSION_CODES,
  supportAdminRouteOf,
  type SupportAdminAction,
} from './application/support-capability-authorize.js';
export {
  AdminPermissionsManageUseCase,
  ADMIN_PERMISSIONS_MANAGE_CODE,
  ADMIN_PERMISSIONS_MANAGE_ROUTE,
  type ManagedAdminPermissionDto,
  type AdminPermissionAuditDto,
} from './application/admin-permissions-manage.js';

// ---------------------------------------------------------------------------
// 装配工厂（inject 全部 ports 的 AdminModule 对象，供 server 装配调用一次）
// ---------------------------------------------------------------------------
export { createAdminModule, type AdminModule, type AdminModuleDeps, type AdminModuleConfig } from './assembly.js';

// ---------------------------------------------------------------------------
// ports（供其他模块 / 测试 mock；不直接 import adapters）
// ---------------------------------------------------------------------------
export type {
  AgentDomainRepo,
  AdminAuditEventRepo,
  AdminPermissionRepo,
  TradeAdjudicationRepo,
  WithdrawalReviewRepo,
  AiJobReviewRepo,
  AdminUserRepo,
  Tx,
} from './ports/admin-repository.js';

// ---------------------------------------------------------------------------
// 领域纯函数与错误工具（domain/；状态机转换表 / 审计脱敏校验，无 IO）
// ---------------------------------------------------------------------------
export { AdminDomainError, AD, isAdminDomainError, isDuplicateKeyError, type AdminErrorCode } from './domain/errors.js';
export {
  AdminAgentDomainStatus5,
  AdminWithdrawalStatus9,
  AGENT_DOMAIN_TRANSITIONS,
  WITHDRAWAL_APPROVE_FROM,
  TRADE_ADJUDICATE_FROM,
  TRADE_ADJUDICATE_RELEASED,
  TRADE_ADJUDICATE_RETURN,
  ResolutionCode,
  AI_JOB_REVIEW_FROM,
  AI_JOB_REVIEW_TO_SUCCEEDED,
  AI_JOB_REVIEW_TO_FAILED,
  canAgentDomainTransition,
  canWithdrawalApprove,
  canTradeAdjudicate,
  validateAuditSnapshot,
  type AdminAgentDomainStatus5Value,
  type AdminWithdrawalStatus9Value,
  type ResolutionCodeValue,
} from './domain/audit-rules.js';
export { toIso, toNullableIso } from './domain/iso-utils.js';

// ---------------------------------------------------------------------------
// 适配器（Sequelize 实现；每表一类；供测试直接构造，生产经 createAdminModule）
// ---------------------------------------------------------------------------
export {
  SequelizeAgentDomainRepo,
  SequelizeAdminAuditEventRepo,
  SequelizeAdminPermissionRepo,
  SequelizeTradeAdjudicationRepo,
  SequelizeWithdrawalReviewRepo,
  SequelizeAiJobReviewRepo,
  SequelizeAdminUserRepo,
} from './adapters/sequelize-admin.js';
