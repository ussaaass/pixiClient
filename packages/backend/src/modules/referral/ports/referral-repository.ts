/**
 * referral 模块仓储端口（referral_binding / referral_binding_event /
 * referral_reward_allocation / agent_domain 4 表）。
 *
 * 领域所有者：referral 模块（adapters/sequelize-referral.ts 各 Repo 类实现各端口；
 * models/referral.ts + models/admin.ts AgentDomainModel 为 model 定义）。
 * 对应 SDD 章节：后端实施 SDD §4（构造注入 ports，用例 / 适配器经端口落库）、
 * §9 第 6 步（邀请归因返佣：五级 10/8/5/3、归因幂等、域隔离）、§5.5
 * （referral_binding 链连续性 CHECK + U(user_id)、referral_binding_event
 * U(binding_key) 不可变、referral_reward_allocation U(order_id,user_id) +
 * U(asset_hold_id)）；数据库设计 SDD §5.2.1（agent_domain U(user_id) 状态机）。
 *
 * 约定（与 rooms / social 模块 ports 同款纪律）：
 * - 方法名经实体前缀区分（createBinding / lockBinding / listBindingsByParent /
 *   appendBindingEvent / createRewardAllocation / findRewardAllocation /
 *   createAgentDomain / lockAgentDomain / findAgentDomainByUserId 等，
 *   各表 CRUD 语义独立，无重名冲突）；
 * - `Tx` 复用 wallet 模块 `Tx`（Sequelize 事务句柄鸭子类型），用例内所有
 *   写操作共享同一事务（回滚即整事务回滚）；
 * - 幂等兜底：`U(user_id)`（referral_binding）/ `U(binding_key)`
 *   （referral_binding_event）/ `U(order_id,user_id)` + `U(asset_hold_id)`
 *   （referral_reward_allocation）命中 → 返回既有行（`inserted: false`，
 *   不产生第二行，验收红线"归因幂等"）；
 * - referral_binding_event 不可变表：只 create，model hooks 拦截 update/destroy
 *   （_shared.ts A.12 第 5 条）。
 *
 * 注：本文件声明首版 §9 第 6 步 5 端点（invite-link / direct-invitees /
 * rewards / agent-domain apply+query / 归因 capture）实际用到的方法；
 * Admin 换绑 / 审批端点（§9 第 9 步）与 reward 入账（经 wallet ledger）
 * 不在本端口首版范围。
 */

import type {
  ReferralBindingModel,
  ReferralBindingEventModel,
  ReferralRewardAllocationModel,
} from '../../../infrastructure/database/models/referral.js';
import type { AgentDomainModel } from '../../../infrastructure/database/models/admin.js';
import type { Tx } from '../../wallet/ports/wallet-repository.js';

export type { Tx };

// ---------------------------------------------------------------------------
// UserInviteRepo（user 表邀请码读写；跨模块复用 identity model，
// 经本端口内聚，不直接查 identity 表，SDD §3.2 实体归属矩阵：
// user.invite_code / invite_code_expires_at 属 identity 模块，
// referral 模块经端口读 / 写，不重定义两套）
// ---------------------------------------------------------------------------

export interface UserInviteRepo {
  /** 读用户邀请码 + 过期时间（null = 未签发）。 */
  findUserInvite(
    userId: string,
    tx: Tx,
  ): Promise<{ id: string; inviteCode: string | null; inviteCodeExpiresAt: Date | string | null } | null>;

  /** 签发 / 更新用户邀请码（有效期内重复签发不重写的判定由用例层前置）。 */
  updateUserInvite(userId: string, inviteCode: string, expiresAt: Date, tx: Tx): Promise<void>;
}

// ---------------------------------------------------------------------------
// ReferralBindingRepo（referral_binding）
// 方法名：createBinding / lockBinding / findBindingByUser / listBindingsByParent /
//         incrementParentBenefit
// ---------------------------------------------------------------------------

export interface ReferralBindingRepo {
  /**
   * 创建邀请绑定行（referral_binding ACTIVE=1，U(user_id) 幂等兜底：
   * 命中 → 返回既有行 `inserted: false`）。
   * @param input.parentChain 完整四级上级链 [parent1, parent2, parent3, parent4]，
   *   后段允许 null（域隔离 / 链连续性由用例层经 binding-rules.ts 前置校验）。
   * @param input.inviteCode 归因来源邀请码快照（NULL = IP 归因无码）。
   */
  createBinding(input: {
    userId: string;
    parentChain: [string, string | null, string | null, string | null];
    bindingSource: 1 | 2 | 3;
    inviteCode: string | null;
    agentDomainId: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; binding: ReferralBindingModel }>;

  /** 行锁读绑定行（归因 / 奖励计算前置）。 */
  lockBinding(bindingId: string, tx: Tx): Promise<ReferralBindingModel | null>;

  /** 按用户查绑定行（幂等重放 / 归因去重；无锁读）。 */
  findBindingByUser(userId: string, tx: Tx): Promise<ReferralBindingModel | null>;

  /**
   * 列出某用户作为直属上级的全部绑定（GET /me/referrals/direct-invitees）。
   * 游标分页（created_at + id 稳定游标，50/页，SDD §5.4 邀请列表约定）。
   * @param input.cursor 游标字符串 `{createdAt}~{id}`（null = 首页）。
   */
  listBindingsByParent(input: {
    parentUserId: string;
    cursor: string | null;
    limit: number;
    tx: Tx;
  }): Promise<{ items: ReferralBindingModel[]; nextCursor: string | null; totalCount: string }>;

  /**
   * 累加上级返点投影（POSTED 时同事务更新 parent_n_benefit_cents，
   * DECIMAL → BIGINT 查询投影；read-then-write 经行锁保护）。
   * @returns 更新后的行（不存在 → null，由用例层映射 STORAGE_UNAVAILABLE）。
   */
  incrementParentBenefit(input: {
    parentUserId: string;
    depth: 1 | 2 | 3 | 4;
    deltaCents: string; // 十进制字符串 wire，正金额
    tx: Tx;
  }): Promise<ReferralBindingModel | null>;
}

// ---------------------------------------------------------------------------
// BindingEventRepo（referral_binding_event，不可变）
// 方法名：appendBindingEvent / findBindingEventByKey
// ---------------------------------------------------------------------------

export interface BindingEventRepo {
  /**
   * 追加绑定事件行（referral_binding_event RECORDED=1 不可变；
   * U(binding_key) 幂等兜底：命中 → 返回既有行 `inserted: false`，
   * 不产生第二行，验收红线"归因证据流水不可变"）。
   */
  appendBindingEvent(input: {
    userId: string;
    previousParent1UserId: string | null;
    newParent1UserId: string;
    adminUserId: string | null;
    bindingKey: string;
    requestKey: string;
    sourceType: 1 | 2 | 3;
    inviteCodeUsed: string | null;
    attributionVersion: string | null;
    relationSnapshot: Record<string, unknown>;
    reason: string;
    tx: Tx;
  }): Promise<{ inserted: boolean; event: ReferralBindingEventModel }>;

  /** 按 binding_key 查事件行（幂等重放读）。 */
  findBindingEventByKey(bindingKey: string, tx: Tx): Promise<ReferralBindingEventModel | null>;
}

// ---------------------------------------------------------------------------
// RewardAllocationRepo（referral_reward_allocation）
// 方法名：createRewardAllocation / findUniqueByOrderAndUser / listRewardsByUser
// ---------------------------------------------------------------------------

export interface RewardAllocationRepo {
  /**
   * 创建返佣分配行（POSTED=1 / SKIPPED=2；U(order_id,user_id) + U(asset_hold_id)
   * 幂等兜底：命中 → 返回既有行 `inserted: false`）。
   * 注：入账 REFERRAL_REWARD=11 经 wallet ledger 同事务完成（扩展点登记，
   * 首版只写分配行 + benefit_cents 投影，不入账）。
   */
  createRewardAllocation(input: {
    userId: string;
    orderId: string;
    assetOperationId: string;
    assetHoldId: string | null;
    rewardType: 1 | 2;
    ancestorDepth: 1 | 2 | 3 | 4;
    rateBps: number;
    basisSubcents: string;
    exactRewardSubcents: string;
    rewardCents: string;
    roundingSnapshot: Record<string, unknown>;
    unlockAt: Date | null;
    skipReason: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; allocation: ReferralRewardAllocationModel }>;

  /** 按 (order_id, user_id) 查分配行（幂等重放；U(order_id,user_id)）。 */
  findUniqueByOrderAndUser(orderId: string, userId: string, tx: Tx): Promise<ReferralRewardAllocationModel | null>;

  /**
   * 列出某用户作为上级的返佣分配（GET /me/referrals/rewards，游标分页 50/页，
   * 按 created_at + id 稳定游标；按 rewardType 筛选 RECHARGE_REBATE=1 /
   * CUSTOMER_LOSS_REBATE=2）。
   */
  listRewardsByUser(input: {
    userId: string;
    rewardType: 1 | 2;
    cursor: string | null;
    limit: number;
    tx: Tx;
  }): Promise<{ items: ReferralRewardAllocationModel[]; nextCursor: string | null }>;
}

// ---------------------------------------------------------------------------
// AgentDomainRepo（agent_domain）
// 方法名：createAgentDomain / lockAgentDomain / findAgentDomainByUserId
// ---------------------------------------------------------------------------

export interface AgentDomainRepo {
  /**
   * 申请代理域（agent_domain PENDING_REVIEW=1，U(user_id) 幂等兜底：
   * 命中 → 返回既有行 `inserted: false`，首版只建申请 + 查询，
   * 审批端点归 §9 第 9 步 Admin）。
   */
  createAgentDomain(input: {
    userId: string;
    capabilities: string[];
    tx: Tx;
  }): Promise<{ inserted: boolean; agentDomain: AgentDomainModel }>;

  /** 行锁读代理域（申请幂等 / 查询前置）。 */
  lockAgentDomain(agentDomainId: string, tx: Tx): Promise<AgentDomainModel | null>;

  /** 按用户查代理域（GET /me/agent-domain；U(user_id) 一行）。 */
  findAgentDomainByUserId(userId: string, tx: Tx): Promise<AgentDomainModel | null>;
}
