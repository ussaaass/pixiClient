/**
 * admin 模块装配工厂（inject 全部 ports 的 AdminModule，供 server 装配调用一次）。
 *
 * 领域所有者：admin 模块（agent_domain 审批/暂停/撤销 + admin_audit_event
 * append-only + coin_market_trade 裁决 + withdrawal 双人复核 +
 * ai_asset_job 审核推进 + Admin 用户列表/详情 + Admin 登录 全部用例）。
 * 对应 SDD 章节：后端实施 SDD §1（装配工厂 `createAdminModule({sequelize,
 * config})` 返回注入了全部 ports 的 AdminModule 对象）、§4（构造注入
 * ports，不用全局）、§9 第 9 步（Admin 全量切换收口：11 用例覆盖
 * agent-domain-review / admin-audit / mock-payment / game-operations /
 * system-config / referrals / social-moderation / support-desk 工作区
 * 后端端点）。
 *
 * 装配模式（参考 `modules/referral/assembly.ts` + `modules/ai-assets/assembly.ts`）：
 * - `sequelize`：Sequelize 实例（models 已 addModels 注册，admin 4 model +
 *   coin_market_trade + withdrawal + ai_asset_job + user）；
 * - **不依赖 walletModule**：审计 / 审批 / 裁决无资金操作；withdrawal
 *   推进经 status 列 UPDATE，不触资；出账经 payout worker 闭环
 *   （登记决策点，§6.3 管线未建）；
 * - `config`：Admin JWT 配置（issuer / audience='admin' / accessTtl）+
 *   时钟注入（首版 SystemClock 缺省；测试可传固定时钟）。
 *
 * 未闭环登记（完成报告给 Lead）：
 * - Admin audience JWT 签发经 identity JwtIssuerPort 扩展点（aud 参数
 *   传 'admin'，KID 经 env var 注入；KMS 密钥设施未闭环，登记决策点）；
 * - Redis admin session 经 identity SessionPort 扩展点登记
 *   （principal_type='ADMIN' 位标记，与 PLAYER 会话隔离；登记决策点）；
 * - 双人复核 operated_by 经 withdrawal.asset_operation_id 反查
 *   asset_operation.operated_by_admin_user_id（DDL CHECK
 *   ck_asset_operation_reviewer 兜底；登记决策点：反查经本模块端口
 *   封装还是经 wallet 模块端口）；
 * - 出款 payout worker（APPROVED=3 → PAYING=4 → SUCCEEDED=5 /
 *   FAILED=9）未建（§6.3 管线；登记决策点）；
 * - Admin 用户详情 section 读：REFERRAL / ASSETS / GAMES / SOCIAL
 *   四个 section 首版空数组占位（跨模块读经各模块 ports 封装归
 *   §9 第 9 步后续运维闭环；登记决策点）。
 */

import type { Sequelize, Transaction } from 'sequelize';
import { AgentDomainModel, AdminAuditEventModel, AdminPermissionModel } from '../../infrastructure/database/models/admin.js';
import { CoinMarketTradeModel } from '../../infrastructure/database/models/coin-market.js';
import { WithdrawalModel } from '../../infrastructure/database/models/payments.js';
import { AiAssetJobModel } from '../../infrastructure/database/models/assets.js';
import { UserModel } from '../../infrastructure/database/models/identity.js';

import {
  SequelizeAgentDomainRepo,
  SequelizeAdminAuditEventRepo,
  SequelizeAdminPermissionRepo,
  SequelizeTradeAdjudicationRepo,
  SequelizeWithdrawalReviewRepo,
  SequelizeAiJobReviewRepo,
  SequelizeAdminUserRepo,
} from './adapters/sequelize-admin.js';

import type {
  AgentDomainRepo,
  AdminAuditEventRepo,
  AdminPermissionRepo,
  TradeAdjudicationRepo,
  WithdrawalReviewRepo,
  AiJobReviewRepo,
  AdminUserRepo,
  Tx,
} from './ports/admin-repository.js';

import { AgentDomainApproveUseCase } from './application/agent-domain-approve.js';
import { AgentDomainSuspendUseCase } from './application/agent-domain-suspend.js';
import { AgentDomainRevokeUseCase } from './application/agent-domain-revoke.js';
import { AdminAuditCreateUseCase } from './application/admin-audit.js';
import { CoinMarketAdjudicateUseCase } from './application/coin-market-adjudicate.js';
import { AiAssetsReviewUseCase } from './application/ai-assets-review.js';
import { AdminUserListUseCase } from './application/admin-user-list.js';
import { AdminUserDetailUseCase } from './application/admin-user-detail.js';
import { WithdrawalReviewUseCase } from './application/withdrawal-review.js';
import { AdminLoginUseCase } from './application/admin-login.js';
import { SupportAdminCapabilityAuthorizeUseCase } from './application/support-capability-authorize.js';
import { AdminPermissionsManageUseCase } from './application/admin-permissions-manage.js';

import type { Clock } from '../wallet/ports/clock.js';
import { SystemClock } from '../wallet/ports/clock.js';

/** 装配配置（Admin JWT 配置 + 时钟注入；测试可传固定时钟）。 */
export interface AdminModuleConfig {
  /** 时钟注入（测试可传固定时钟；缺省 SystemClock，与 referral / ai-assets assembly 同款约定）。 */
  clock?: Clock;
  /** Admin audience 标识（JWT aud 参数；缺省 'admin'）。 */
  adminAudience?: string;
}

/** 装配依赖（Sequelize 实例 + 配置；模型类在装配内取，参考 referral / ai-assets assembly）。 */
export interface AdminModuleDeps {
  sequelize: Sequelize;
  config: AdminModuleConfig;
}

/** 全部 ports + 用例实例的 AdminModule（构造注入，不用全局，SDD §4）。 */
export interface AdminModule {
  // ports（共享实现，供测试 / 其他模块 mock 时参考）
  agentDomainRepo: AgentDomainRepo;
  auditRepo: AdminAuditEventRepo;
  permissionRepo: AdminPermissionRepo;
  tradeRepo: TradeAdjudicationRepo;
  withdrawalRepo: WithdrawalReviewRepo;
  jobRepo: AiJobReviewRepo;
  userRepo: AdminUserRepo;

  // 用例实例（构造注入 ports，不用全局，SDD §4）
  agentDomainApprove: AgentDomainApproveUseCase;
  agentDomainSuspend: AgentDomainSuspendUseCase;
  agentDomainRevoke: AgentDomainRevokeUseCase;
  adminAudit: AdminAuditCreateUseCase;
  coinMarketAdjudicate: CoinMarketAdjudicateUseCase;
  aiAssetsReview: AiAssetsReviewUseCase;
  adminUserList: AdminUserListUseCase;
  adminUserDetail: AdminUserDetailUseCase;
  withdrawalReview: WithdrawalReviewUseCase;
  adminLogin: AdminLoginUseCase;
  supportCapabilityAuthorize: SupportAdminCapabilityAuthorizeUseCase;
  adminPermissionsManage: AdminPermissionsManageUseCase;

  /** 时钟（测试可传固定时钟；缺省 SystemClock）。 */
  clock: Clock;

  /**
   * 在事务 scope 内构建同事务端口（§6.3 "所有分录/outbox 同事务"约定；
   * admin 无 outbox，withTx 只透传 tx，供用例写 agent_domain /
   * coin_market_trade / withdrawal / ai_asset_job + admin_audit_event
   * 同事务落库）。
   */
  withTx<T>(scope: { transaction: Transaction | null }, fn: (tx: Tx) => T | Promise<T>): Promise<T>;
}

/**
 * 装配 admin 模块（inject 全部 ports 的 AdminModule，供 server 装配调用一次）。
 * 用法（apps/server bootstrap）：
 * ```ts
 * const adminModule = createAdminModule({ sequelize, config });
 * ```
 */
export function createAdminModule(deps: AdminModuleDeps): AdminModule {
  const { sequelize, config } = deps;
  const clock: Clock = config.clock ?? new SystemClock();

  // 构建 Sequelize 仓储实现（每表一类，不混类；7 model 类构造注入，
  // 不用全局，SDD §4；各 Repo 独立实现，供按角色取用）。
  const agentDomainRepo = new SequelizeAgentDomainRepo(AgentDomainModel);
  const auditRepo = new SequelizeAdminAuditEventRepo(AdminAuditEventModel);
  const permissionRepo = new SequelizeAdminPermissionRepo(AdminPermissionModel);
  const tradeRepo = new SequelizeTradeAdjudicationRepo(CoinMarketTradeModel);
  const withdrawalRepo = new SequelizeWithdrawalReviewRepo(WithdrawalModel);
  const jobRepo = new SequelizeAiJobReviewRepo(AiAssetJobModel);
  const userRepo = new SequelizeAdminUserRepo(UserModel);

  // 用例实例（构造注入 ports，不用全局，SDD §4；各 Repo 独立类按角色传入）。
  const agentDomainApprove = new AgentDomainApproveUseCase(agentDomainRepo, auditRepo);
  const agentDomainSuspend = new AgentDomainSuspendUseCase(agentDomainRepo, auditRepo);
  const agentDomainRevoke = new AgentDomainRevokeUseCase(agentDomainRepo, auditRepo);
  const adminAudit = new AdminAuditCreateUseCase(auditRepo);
  const coinMarketAdjudicate = new CoinMarketAdjudicateUseCase(tradeRepo, auditRepo);
  const aiAssetsReview = new AiAssetsReviewUseCase(jobRepo, auditRepo);
  const adminUserList = new AdminUserListUseCase(userRepo);
  const adminUserDetail = new AdminUserDetailUseCase(userRepo);
  const withdrawalReview = new WithdrawalReviewUseCase(withdrawalRepo, auditRepo);
  const adminLogin = new AdminLoginUseCase(userRepo);
  const supportCapabilityAuthorize = new SupportAdminCapabilityAuthorizeUseCase(permissionRepo, userRepo);
  const adminPermissionsManage = new AdminPermissionsManageUseCase(permissionRepo, userRepo, auditRepo);

  const module: AdminModule = {
    agentDomainRepo,
    auditRepo,
    permissionRepo,
    tradeRepo,
    withdrawalRepo,
    jobRepo,
    userRepo,
    agentDomainApprove,
    agentDomainSuspend,
    agentDomainRevoke,
    adminAudit,
    coinMarketAdjudicate,
    aiAssetsReview,
    adminUserList,
    adminUserDetail,
    withdrawalReview,
    adminLogin,
    supportCapabilityAuthorize,
    adminPermissionsManage,
    clock,

    async withTx<T>(scope: { transaction: Transaction | null }, fn: (tx: Tx) => T | Promise<T>): Promise<T> {
      // 无 outbox，withTx 只透传 tx（用例写 agent_domain / coin_market_trade /
      // withdrawal / ai_asset_job + admin_audit_event 同事务落库，
      // 随事务提交 / 回滚）。
      const tx: Tx = { transaction: scope.transaction as Transaction | undefined };
      void sequelize; // 依赖登记（模型类已在构造注入，此处只透传 tx）
      void config;
      return fn(tx);
    },
  };

  return module;
}
