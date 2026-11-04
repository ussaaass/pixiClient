/**
 * admin 模块应用用例 barrel（跨模块唯一入口经 public.ts；本文件
 * 供 assembly.ts 内部 import 各用例类 + DTO 类型，与 referral /
 * coin-market / ai-assets 模块 application/index.ts 同款纪律）。
 *
 * 领域所有者：admin 模块（application 层用例类，构造注入 ports，
 * 不用全局，SDD §4）。
 * 对应 SDD 章节：后端实施 SDD §4（application / ports / adapters
 * 布局；用例类经 ports 落库，领域规则经 domain 纯函数校验）、
 * §9 第 9 步（Admin 全量切换收口：11 个用例覆盖 agent_domain
 * 审批 / 暂停 / 撤销 + 审计写 + 争议裁决 + AI 审核 + Admin 用户
 * 列表 / 详情 + 提现审批 / 驳回 + Admin 登录）。
 */

export {
  AgentDomainApproveUseCase,
  type AgentDomainApprovedDto,
} from './agent-domain-approve.js';
export {
  AgentDomainSuspendUseCase,
  type AgentDomainSuspendedDto,
} from './agent-domain-suspend.js';
export {
  AgentDomainRevokeUseCase,
  type AgentDomainRevokedDto,
} from './agent-domain-revoke.js';
export {
  AdminAuditCreateUseCase,
  type AdminAuditCreatedDto,
} from './admin-audit.js';
export {
  CoinMarketAdjudicateUseCase,
  type TradeAdjudicatedDto,
} from './coin-market-adjudicate.js';
export {
  AiAssetsReviewUseCase,
  type AiJobReviewedDto,
} from './ai-assets-review.js';
export {
  AdminUserListUseCase,
  type AdminUserListFilters,
  type AdminUserItemDto,
  type AdminUserPageDto,
  ADMIN_USER_PAGE_LIMIT,
} from './admin-user-list.js';
export {
  AdminUserDetailUseCase,
  AdminUserDetailSection,
  type AdminUserDetailSectionValue,
  type AdminUserOverviewSectionDto,
  type AdminUserSecuritySectionDto,
  type AdminUserDetailSectionDto,
  isValidAdminUserDetailSection,
} from './admin-user-detail.js';
export {
  WithdrawalReviewUseCase,
  type WithdrawalApprovedDto,
  type WithdrawalRejectedDto,
} from './withdrawal-review.js';
export {
  AdminLoginUseCase,
  type AdminLoginInput,
  type AdminLoginResultDto,
} from './admin-login.js';
