/**
 * referral 仓储适配器（Sequelize 实现各 Repo 端口；models/referral.ts 3 model
 * + models/admin.ts AgentDomainModel 的唯一写入点，行锁/幂等/状态机转换全在此层）。
 *
 * 领域所有者：referral 模块（models/referral.ts 为其唯一 model 定义；
 * 各表行锁/幂等/链连续性约定经本层落库，领域规则经 domain/binding-rules.ts 校验）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 referral_binding →
 * referral_binding_event，幂等先抢唯一约束；归因无资金操作，reward 入账
 * 经 wallet ledger 扩展点登记）、§9 第 6 步（邀请归因返佣：五级 10/8/5/3、
 * 归因幂等、域隔离）、§3.2 实体归属矩阵（referral owns 3 referral_* 表 +
 * agent_domain 经 admin model 读）；数据库设计 SDD §5.5 / §5.2.1。
 *
 * 行锁与并发约定（与 rooms / social 适配器同款纪律）：
 * - `lock: 'FOR UPDATE'` 字符串字面量写法（InnoDB 行锁，§4 锁顺序）；
 * - 不可变表 referral_binding_event 只 create，model hooks 拦截 update/destroy
 *   （_shared.ts A.12 第 5 条）；
 * - 唯一约束幂等兜底：`U(user_id)`（referral_binding）/ `U(binding_key)`
 *   （referral_binding_event）/ `U(order_id,user_id)` + `U(asset_hold_id)`
 *   （referral_reward_allocation）/ `U(user_id)`（agent_domain）
 *   命中 → 返回既有行（不产生第二行，验收红线"归因幂等"）；
 * - 链连续性由用例层经 `domain/binding-rules.ts` `isValidBindingChain`
 *   前置校验，本层只做 INSERT / UPDATE 落库。
 *
 * 错误码映射（referral domain/errors.ts REF 表）：
 * - `REFERRAL_NOT_FOUND`：绑定行 / 奖励行缺失。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 行缺失 / 投影更新影响行数 0
 *   （可重试）。
 *
 * 结构约定（每表一类，不混类）：
 * 各 Repo 接口各有 `create` / `lockByPk` 等同名方法，一个类无法实现两个
 * 签名，故拆为 4 个独立类（`SequelizeReferralBindingRepo` /
 * `SequelizeBindingEventRepo` / `SequelizeRewardAllocationRepo` /
 * `SequelizeAgentDomainRepo`），各实现自己的接口；共享 `txOf` 辅助函数
 * 保留在文件顶部，各 Repo 类都调。装配层（assembly.ts）按角色独立构造，
 * 与 rooms 模块 5 个独立类同款模式。
 * 注：Sequelize 6 的 BIGINT 列在严格模式（string 属性接口）下 create/update
 * 入参经 `as never` 桥接（rooms 适配器同款写法，_shared.ts 第 8 条）。
 * `exactOptionalPropertyTypes` 下 Sequelize 查询 options 对象经 `as never`
 * 整体桥接（rooms 适配器同款写法；`lock: txq ? 'FOR UPDATE' : undefined`
 * + `transaction: txq` 直传，不写 `?? undefined`）。
 */

import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import type {
  ReferralBindingModel,
  ReferralBindingEventModel,
  ReferralRewardAllocationModel,
} from '../../../infrastructure/database/models/referral.js';
import { ActiveStatus, RecordStatus, ReferralRewardStatus } from '../../../infrastructure/database/models/referral.js';
import type { AgentDomainModel } from '../../../infrastructure/database/models/admin.js';
import { AgentDomainStatus } from '../../../infrastructure/database/models/admin.js';
import type { UserModel } from '../../../infrastructure/database/models/identity.js';
import type {
  ReferralBindingRepo,
  BindingEventRepo,
  RewardAllocationRepo,
  AgentDomainRepo,
  UserInviteRepo,
  Tx,
} from '../ports/referral-repository.js';

/** 取事务（Sequelize Transaction 鸭子类型；与 rooms 适配器同款约定）。
 * 返回 `Transaction | null`（exactOptionalPropertyTypes 下 undefined 不可赋给
 * null 槽，统一 null 化；options 经 `as never` 整体桥接后直传）。 */
function txOf(tx?: Tx): Transaction | null {
  return (tx?.transaction as Transaction | undefined) ?? null;
}

/** 稳定游标解析 `{createdAt ISO}~{id}`（SDD §5.4 邀请列表约定）。 */
function parseCursor(cursor: string | null): { createdAt: string; id: string } | null {
  if (cursor === null) return null;
  const idx = cursor.lastIndexOf('~');
  if (idx <= 0) return null;
  return { createdAt: cursor.slice(0, idx), id: cursor.slice(idx + 1) };
}

function formatCursor(item: { createdAt: Date | string; id: string }): string {
  const iso = typeof item.createdAt === 'string' ? item.createdAt : item.createdAt.toISOString();
  return `${iso}~${item.id}`;
}

// ---------------------------------------------------------------------------
// ReferralBindingRepo（referral_binding）
// ---------------------------------------------------------------------------

/**
 * 邀请绑定仓储（ReferralBindingRepo；Sequelize 实现）。
 * 创建（U(user_id) 幂等兜底，命中 → 返回既有行）+ 行锁读 +
 * 按直属上级列出（游标分页）+ 上级返点投影 read-then-write 更新。
 */
export class SequelizeReferralBindingRepo implements ReferralBindingRepo {
  constructor(private readonly model: typeof ReferralBindingModel) {}

  async createBinding(input: {
    userId: string;
    parentChain: [string, string | null, string | null, string | null];
    bindingSource: 1 | 2 | 3;
    inviteCode: string | null;
    agentDomainId: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; binding: ReferralBindingModel }> {
    const txq = txOf(input.tx);
    // U(user_id) 幂等兜底：先读既有行，命中 → 返回（inserted: false）
    const existing = await this.model.findOne({
      where: { userId: input.userId as never, status: ActiveStatus.ACTIVE },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (existing !== null) {
      return { inserted: false, binding: existing };
    }
    const [p1, p2, p3, p4] = input.parentChain;
    const binding = (await this.model.create(
      {
        userId: input.userId as never,
        parent1UserId: p1 as never,
        parent2UserId: p2 as never,
        parent3UserId: p3 as never,
        parent4UserId: p4 as never,
        parent1BenefitCents: '0',
        parent2BenefitCents: '0',
        parent3BenefitCents: '0',
        parent4BenefitCents: '0',
        status: ActiveStatus.ACTIVE,
        boundAt: new Date(),
        bindingSource: input.bindingSource,
      } as never,
      { transaction: txq } as never,
    )) as ReferralBindingModel;
    return { inserted: true, binding };
  }

  async lockBinding(bindingId: string, tx: Tx): Promise<ReferralBindingModel | null> {
    const txq = txOf(tx);
    const row = await this.model.findByPk(bindingId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    return row;
  }

  async findBindingByUser(userId: string, tx: Tx): Promise<ReferralBindingModel | null> {
    const txq = txOf(tx);
    const row = await this.model.findOne({
      where: { userId: userId as never, status: ActiveStatus.ACTIVE },
      transaction: txq,
    } as never);
    return row;
  }

  async listBindingsByParent(input: {
    parentUserId: string;
    cursor: string | null;
    limit: number;
    tx: Tx;
  }): Promise<{ items: ReferralBindingModel[]; nextCursor: string | null; totalCount: string }> {
    const txq = txOf(input.tx);
    const totalRow = await this.model.count({
      where: { parent1UserId: input.parentUserId as never, status: ActiveStatus.ACTIVE },
      transaction: txq,
    } as never);
    const baseWhere: Record<string, unknown> = {
      parent1UserId: input.parentUserId as never,
      status: ActiveStatus.ACTIVE,
    };
    const cur = parseCursor(input.cursor);
    if (cur !== null) {
      // 稳定游标：created_at < cursor.createdAt OR (created_at = cursor.createdAt AND id < cursor.id)
      const andClauses: Record<string, unknown>[] = [
        { createdAt: { [Op.lt]: cur.createdAt } },
        { createdAt: cur.createdAt, id: { [Op.lt]: cur.id as never } },
      ];
      baseWhere[Op.and as unknown as string] = andClauses as never;
    }
    const items = await this.model.findAll({
      where: baseWhere as never,
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: input.limit,
      transaction: txq,
    } as never);
    const last = items[items.length - 1];
    const nextCursor = items.length === input.limit && last !== undefined ? formatCursor(last) : null;
    return { items, nextCursor, totalCount: String(totalRow) };
  }

  async incrementParentBenefit(input: {
    parentUserId: string;
    depth: 1 | 2 | 3 | 4;
    deltaCents: string;
    tx: Tx;
  }): Promise<ReferralBindingModel | null> {
    const txq = txOf(input.tx);
    // 行锁读上级绑定行（被绑用户行不存在时 parent 可能无行，读被绑 user 的绑定行）
    // 注：benefit 投影在被绑用户的 referral_binding 行上（parent_n_benefit_cents），
    // 即"此用户为第 n 级上级时累计已发返点分"。按 parentUserId 定位被绑用户行：
    // 被绑用户行的 parent{depth}UserId === input.parentUserId。
    const rows = await this.model.findAll({
      where: {
        [Op.or]: [{ parent1UserId: input.parentUserId as never, status: ActiveStatus.ACTIVE }],
      },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    // 首版简化：直接更新被绑用户行的投影（经 parentUserId 反查）；
    // 影响行数 0 → null（由用例层映射 STORAGE_UNAVAILABLE，登记决策点）
    const colKey =
      input.depth === 1
        ? 'parent1BenefitCents'
        : input.depth === 2
          ? 'parent2BenefitCents'
          : input.depth === 3
            ? 'parent3BenefitCents'
            : 'parent4BenefitCents';
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row === undefined) return null;
    const current = BigInt(typeof row[colKey] === 'string' ? (row[colKey] as string) : '0');
    const next = (current + BigInt(input.deltaCents)).toString();
    await this.model.update({ [colKey]: next } as never, { where: { id: row.id }, transaction: txq } as never);
    return this.model.findByPk(row.id, { transaction: txq } as never);
  }
}

// ---------------------------------------------------------------------------
// BindingEventRepo（referral_binding_event，不可变）
// ---------------------------------------------------------------------------

/**
 * 绑定事件仓储（BindingEventRepo；Sequelize 实现）。
 * 不可变表：只 create（U(binding_key) 幂等兜底）+ 按 binding_key 查，
 * model hooks 拦截 update/destroy（_shared.ts A.12 第 5 条）。
 */
export class SequelizeBindingEventRepo implements BindingEventRepo {
  constructor(private readonly model: typeof ReferralBindingEventModel) {}

  async appendBindingEvent(input: {
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
  }): Promise<{ inserted: boolean; event: ReferralBindingEventModel }> {
    const txq = txOf(input.tx);
    // U(binding_key) 幂等兜底：先读既有行，命中 → 返回（inserted: false）
    const existing = await this.model.findOne({
      where: { bindingKey: input.bindingKey },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (existing !== null) {
      return { inserted: false, event: existing };
    }
    const now = new Date();
    const event = (await this.model.create(
      {
        userId: input.userId as never,
        previousParent1UserId: input.previousParent1UserId as never,
        newParent1UserId: input.newParent1UserId as never,
        adminUserId: input.adminUserId as never,
        bindingKey: input.bindingKey,
        requestKey: input.requestKey,
        sourceType: input.sourceType,
        inviteCodeUsed: input.inviteCodeUsed,
        ipLookupHash: null,
        attributionVersion: input.attributionVersion,
        relationSnapshot: input.relationSnapshot,
        reason: input.reason,
        status: RecordStatus.RECORDED,
        createdAt: now,
        updatedAt: now,
      } as never,
      { transaction: txq } as never,
    )) as ReferralBindingEventModel;
    return { inserted: true, event };
  }

  async findBindingEventByKey(bindingKey: string, tx: Tx): Promise<ReferralBindingEventModel | null> {
    const txq = txOf(tx);
    const row = await this.model.findOne({
      where: { bindingKey },
      transaction: txq,
    } as never);
    return row;
  }
}

// ---------------------------------------------------------------------------
// RewardAllocationRepo（referral_reward_allocation）
// ---------------------------------------------------------------------------

/**
 * 返佣分配仓储（RewardAllocationRepo；Sequelize 实现）。
 * 创建（U(order_id,user_id) + U(asset_hold_id) 幂等兜底）+ 按 (order,user)
 * 查（幂等重放）+ 按用户列出返佣（游标分页，按 rewardType 筛选）。
 * 注：入账 REFERRAL_REWARD=11 经 wallet ledger 扩展点登记，首版只写分配行。
 */
export class SequelizeRewardAllocationRepo implements RewardAllocationRepo {
  constructor(private readonly model: typeof ReferralRewardAllocationModel) {}

  async createRewardAllocation(input: {
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
  }): Promise<{ inserted: boolean; allocation: ReferralRewardAllocationModel }> {
    const txq = txOf(input.tx);
    // U(order_id,user_id) 幂等兜底：先读既有行，命中 → 返回（inserted: false）
    const existing = await this.model.findOne({
      where: { orderId: input.orderId as never, userId: input.userId as never },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (existing !== null) {
      return { inserted: false, allocation: existing };
    }
    const allocation = (await this.model.create(
      {
        userId: input.userId as never,
        orderId: input.orderId as never,
        assetOperationId: input.assetOperationId as never,
        assetHoldId: input.assetHoldId as never,
        rewardType: input.rewardType,
        ancestorDepth: input.ancestorDepth,
        rateBps: input.rateBps,
        basisSubcents: input.basisSubcents,
        exactRewardSubcents: input.exactRewardSubcents,
        rewardCents: input.rewardCents,
        roundingSnapshot: input.roundingSnapshot,
        unlockAt: input.unlockAt,
        skipReason: input.skipReason,
        status: input.skipReason !== null ? ReferralRewardStatus.SKIPPED : ReferralRewardStatus.POSTED,
      } as never,
      { transaction: txq } as never,
    )) as ReferralRewardAllocationModel;
    return { inserted: true, allocation };
  }

  async findUniqueByOrderAndUser(orderId: string, userId: string, tx: Tx): Promise<ReferralRewardAllocationModel | null> {
    const txq = txOf(tx);
    const row = await this.model.findOne({
      where: { orderId: orderId as never, userId: userId as never },
      transaction: txq,
    } as never);
    return row;
  }

  async listRewardsByUser(input: {
    userId: string;
    rewardType: 1 | 2;
    cursor: string | null;
    limit: number;
    tx: Tx;
  }): Promise<{ items: ReferralRewardAllocationModel[]; nextCursor: string | null }> {
    const txq = txOf(input.tx);
    const baseWhere: Record<string, unknown> = {
      userId: input.userId as never,
      rewardType: input.rewardType,
      status: ReferralRewardStatus.POSTED,
    };
    const cur = parseCursor(input.cursor);
    if (cur !== null) {
      const andClauses: Record<string, unknown>[] = [
        { createdAt: { [Op.lt]: cur.createdAt } },
        { createdAt: cur.createdAt, id: { [Op.lt]: cur.id as never } },
      ];
      baseWhere[Op.and as unknown as string] = andClauses as never;
    }
    const items = await this.model.findAll({
      where: baseWhere as never,
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: input.limit,
      transaction: txq,
    } as never);
    const last = items[items.length - 1];
    const nextCursor = items.length === input.limit && last !== undefined ? formatCursor(last) : null;
    return { items, nextCursor };
  }
}

// ---------------------------------------------------------------------------
// UserInviteRepo（user 表邀请码读写；跨模块复用 identity model，经端口内聚）
// ---------------------------------------------------------------------------

/**
 * 用户邀请码仓储（UserInviteRepo；Sequelize 实现）。
 * 读 user.invite_code / invite_code_expires_at + 签发 / 更新（有效期内
 * 重复签发不重写的判定由用例层前置，本层只落库）。
 * 注：user 表属 identity 模块（SDD §3.2 实体归属矩阵），referral 模块
 * 经本端口读 / 写，不直接查 identity 表（保持模块内聚，跨模块经端口）。
 */
export class SequelizeUserInviteRepo implements UserInviteRepo {
  constructor(private readonly model: typeof UserModel) {}

  async findUserInvite(
    userId: string,
    tx: Tx,
  ): Promise<{ id: string; inviteCode: string | null; inviteCodeExpiresAt: Date | string | null } | null> {
    const txq = txOf(tx);
    const row = await this.model.findOne({
      where: { id: userId as never },
      transaction: txq,
    } as never);
    if (row === null) return null;
    return {
      id: row.id,
      inviteCode: row.inviteCode,
      inviteCodeExpiresAt: row.inviteCodeExpiresAt,
    };
  }

  async updateUserInvite(userId: string, inviteCode: string, expiresAt: Date, tx: Tx): Promise<void> {
    const txq = txOf(tx);
    await this.model.update(
      { inviteCode, inviteCodeExpiresAt: expiresAt } as never,
      { where: { id: userId as never }, transaction: txq } as never,
    );
  }
}

/**
 * 代理域仓储（AgentDomainRepo；Sequelize 实现）。
 * 申请（PENDING_REVIEW=1，U(user_id) 幂等兜底）+ 行锁读 + 按用户查。
 * 首版只建申请 + 查询，审批 / 暂停 / 撤销端点归 §9 第 9 步 Admin。
 */
export class SequelizeAgentDomainRepo implements AgentDomainRepo {
  constructor(private readonly model: typeof AgentDomainModel) {}

  async createAgentDomain(input: {
    userId: string;
    capabilities: string[];
    tx: Tx;
  }): Promise<{ inserted: boolean; agentDomain: AgentDomainModel }> {
    const txq = txOf(input.tx);
    // U(user_id) 幂等兜底：先读既有行，命中 → 返回（inserted: false）
    const existing = await this.model.findOne({
      where: { userId: input.userId as never },
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    if (existing !== null) {
      return { inserted: false, agentDomain: existing };
    }
    const agentDomain = (await this.model.create(
      {
        userId: input.userId as never,
        status: AgentDomainStatus.PENDING_REVIEW,
        capabilities: input.capabilities.length > 0 ? input.capabilities : ['AGENT_DASHBOARD_READ'],
      } as never,
      { transaction: txq } as never,
    )) as AgentDomainModel;
    return { inserted: true, agentDomain };
  }

  async lockAgentDomain(agentDomainId: string, tx: Tx): Promise<AgentDomainModel | null> {
    const txq = txOf(tx);
    const row = await this.model.findByPk(agentDomainId, {
      transaction: txq,
      lock: txq ? 'FOR UPDATE' : undefined,
    } as never);
    return row;
  }

  async findAgentDomainByUserId(userId: string, tx: Tx): Promise<AgentDomainModel | null> {
    const txq = txOf(tx);
    const row = await this.model.findOne({
      where: { userId: userId as never },
      transaction: txq,
    } as never);
    return row;
  }
}
