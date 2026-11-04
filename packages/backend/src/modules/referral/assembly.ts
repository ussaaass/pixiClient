/**
 * referral 模块装配工厂（inject 全部 ports 的 ReferralModule，供 server 装配调用一次）。
 *
 * 领域所有者：referral 模块（referral_binding / referral_binding_event /
 * referral_reward_allocation / agent_domain 全部用例 + 邀请码读写 + 匿名展示名）。
 * 对应 SDD 章节：后端实施 SDD §1（装配工厂 `createReferralModule({sequelize,
 * config})` 返回注入了全部 ports 的 ReferralModule 对象）、§4（构造注入 ports，
 * 不用全局；归因同事务约定）、§9 实施顺序第 6 步（邀请归因返佣：五级
 * 10/8/5/3、归因幂等、域隔离、代理域申请 + 查询）。
 *
 * 装配模式（参考 `modules/rooms/assembly.ts` + `modules/social/assembly.ts`）：
 * - `sequelize`：Sequelize 实例（models 已 addModels 注册，referral 3 model +
 *   agent_domain（admin）+ user（identity））；
 * - **不依赖 walletModule**：归因无资金操作；reward_allocation 入账
 *   REFERRAL_REWARD=11 经 wallet ledger 扩展点登记，首版只写分配行 +
 *   benefit_cents 投影，不入账（Lead 统一验证时登记扩展点）；
 * - `displayNameOf` 经 identity model `UserModel.publicCode` 匿名展示
 *   （首版直读 publicCode，不暴露 user.id / 联系方式，docs 第 3 节红线）。
 *
 * 未闭环登记（完成报告给 Lead）：
 * - reward_allocation 入账经 wallet ledger（REFERRAL_REWARD=11 operation type）
 *   未挂接，首版只写分配行 + benefit 投影（扩展点登记）；
 * - 代理域审批 / 暂停 / 恢复 / 撤销端点归 §9 第 9 步 Admin（AdminAgentDomainEndpoint），
 *   本模块只建申请 + 查询（PENDING_REVIEW=1）；
 * - 客损返佣（CUSTOMER_LOSS_REBATE=2）平台明细首版为空值/零值（线下结算，
 *   docs 第 3 节），不生成演示收益；
 * - 归因候选 Redis 暂存（IP → 邀请码 + TTL）经 §9 第 6 步候选接口
 *   （POST /public/referral-attribution/candidate）落地，本模块归因用例
 *   只落库绑定 + 事件（路由层经 Redis 候选解析 parentChain 后调用）。
 */

import type { Sequelize, Transaction } from 'sequelize';
import {
  ReferralBindingModel,
  ReferralBindingEventModel,
  ReferralRewardAllocationModel,
} from '../../infrastructure/database/models/referral.js';
import { AgentDomainModel } from '../../infrastructure/database/models/admin.js';
import { UserModel } from '../../infrastructure/database/models/identity.js';

import {
  SequelizeReferralBindingRepo,
  SequelizeBindingEventRepo,
  SequelizeRewardAllocationRepo,
  SequelizeAgentDomainRepo,
  SequelizeUserInviteRepo,
} from './adapters/sequelize-referral.js';

import type {
  ReferralBindingRepo,
  BindingEventRepo,
  RewardAllocationRepo,
  AgentDomainRepo,
  UserInviteRepo,
  Tx,
} from './ports/referral-repository.js';

import { InviteLinkUseCase } from './application/invite-link.js';
import { ReferralListUseCase } from './application/referral-list.js';
import { AttributionUseCase } from './application/attribution.js';
import { AgentDomainUseCase } from './application/agent-domain.js';

/** 装配配置（首版无外部依赖；邀请码长度 / 有效期可经 configuration 模块注入，§9 第 7 步）。 */
export interface ReferralModuleConfig {
  /** 邀请链接基础 URL（首版硬编码示例域名；§9 第 7 步 configuration 落地后改经注入）。 */
  inviteBaseUrl?: string;
}

/** 装配依赖（Sequelize 实例 + 配置；模型类在装配内取，参考 rooms / social assembly）。 */
export interface ReferralModuleDeps {
  sequelize: Sequelize;
  config: ReferralModuleConfig;
}

/** 全部 ports + 用例实例的 ReferralModule（构造注入，不用全局，SDD §4）。 */
export interface ReferralModule {
  // ports（共享实现，供测试 / 其他模块 mock 时参考）
  bindingRepo: ReferralBindingRepo;
  eventRepo: BindingEventRepo;
  rewardRepo: RewardAllocationRepo;
  agentDomainRepo: AgentDomainRepo;
  userInviteRepo: UserInviteRepo;

  /** 匿名展示名端口（首版直读 user.publicCode，不暴露 user.id / 联系方式）。 */
  displayNameOf: (userId: string) => Promise<string>;

  // 用例实例（构造注入 ports，不用全局，SDD §4）
  inviteLink: InviteLinkUseCase;
  referralList: ReferralListUseCase;
  attribution: AttributionUseCase;
  agentDomain: AgentDomainUseCase;

  /**
   * 在事务 scope 内构建同事务端口（§6.3 "所有分录/outbox 同事务"约定；
   * referral 归因无 outbox，withTx 只透传 tx，供用例写 referral_binding +
   * referral_binding_event + referral_reward_allocation 同事务落库）。
   */
  withTx<T>(scope: { transaction: Transaction | null }, fn: (tx: Tx) => T | Promise<T>): Promise<T>;
}

/**
 * 装配 referral 模块（inject 全部 ports 的 ReferralModule，供 server 装配调用一次）。
 * 用法（apps/server bootstrap）：
 * ```ts
 * const referralModule = createReferralModule({ sequelize, config });
 * ```
 */
export function createReferralModule(deps: ReferralModuleDeps): ReferralModule {
  const { sequelize, config } = deps;

  // 构建 Sequelize 仓储实现（每表一类，不混类；5 model 类构造注入，
  // 不用全局，SDD §4；各 Repo 独立实现，供按角色取用）。
  const bindingRepo = new SequelizeReferralBindingRepo(ReferralBindingModel);
  const eventRepo = new SequelizeBindingEventRepo(ReferralBindingEventModel);
  const rewardRepo = new SequelizeRewardAllocationRepo(ReferralRewardAllocationModel);
  const agentDomainRepo = new SequelizeAgentDomainRepo(AgentDomainModel);
  const userInviteRepo = new SequelizeUserInviteRepo(UserModel);

  // 匿名展示名端口（首版直读 user.publicCode，不暴露 user.id / 联系方式；
  // docs 第 3 节"姓名只返回匿名展示名，不返回账号 ID、联系方式或设备信息"）。
  const displayNameOf = async (userId: string): Promise<string> => {
    const user = await UserModel.findByPk(userId);
    if (user === null) return `user_${userId.slice(-8)}`;
    return user.publicCode || `user_${userId.slice(-8)}`;
  };

  // 用例实例（构造注入 ports，不用全局，SDD §4；各 Repo 独立类按角色传入）。
  const inviteLink = new InviteLinkUseCase(userInviteRepo);
  const referralList = new ReferralListUseCase(bindingRepo, rewardRepo, displayNameOf);
  const attribution = new AttributionUseCase(bindingRepo, eventRepo);
  const agentDomain = new AgentDomainUseCase(agentDomainRepo);

  const module: ReferralModule = {
    bindingRepo,
    eventRepo,
    rewardRepo,
    agentDomainRepo,
    userInviteRepo,
    displayNameOf,
    inviteLink,
    referralList,
    attribution,
    agentDomain,

    async withTx<T>(scope: { transaction: Transaction | null }, fn: (tx: Tx) => T | Promise<T>): Promise<T> {
      // 归因无 outbox，withTx 只透传 tx（用例写 referral_binding + event +
      // reward_allocation 同事务落库，随事务提交 / 回滚）。
      const tx: Tx = { transaction: scope.transaction as Transaction | undefined };
      void sequelize; // 依赖登记（模型类已在构造注入，此处只透传 tx）
      void config;
      return fn(tx);
    },
  };

  return module;
}
