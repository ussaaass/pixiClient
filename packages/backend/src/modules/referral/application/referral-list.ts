/**
 * referral 模块用例：直属下级列表 + 返佣明细列表（GET 只读，游标分页 50/页）。
 *
 * 领域所有者：referral 模块（读 referral_binding / referral_reward_allocation，
 * 不写表；SDD §5.4 "不新增报表持久化表"）。
 * 对应 SDD 章节：后端实施 SDD §9 第 6 步（玩家"邀请与代理"页：直属邀请用户
 * 列表与返佣明细两分区）、§5.4（GET /me/referrals/direct-invitees +
 * /me/referrals/rewards，稳定游标分页 + 受当前 JWT 用户范围限制）；
 * docs/04_domains/邀请归因返佣与数据规范.md 第 3 节（直属列表只返回
 * 经归因事务实际建立的 parent_1_user_id = 当前用户关系，姓名只返回
 * 匿名展示名，不返回账号 ID / 联系方式 / 设备信息）。
 *
 * 用例语义：
 * - `listDirectInvitees`：列出当前用户作为直属上级的绑定（parent1UserId =
 *   me，游标 50/页）；被绑用户姓名经 identity 模块 `displayNameOf` 匿名化
 *   （首版用 `publicCode` 展示，不暴露 user.id / 联系方式）；
 * - `listRewards`：列出当前用户作为上级的返佣分配（rewardType 筛选，
 *   游标 50/页）；`CUSTOMER_LOSS_REBATE=2` 时平台明细为空值/零值
 *   （线下结算，不伪装平台返点，docs 第 3 节）；
 * - 金额全链路十进制字符串 wire（BIGINT / DECIMAL 经 row-mapper 格式化）。
 *
 * 错误码映射（REF → 触发条件）：
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 游标非法（可重试 / 400）。
 */

import type { ReferralBindingRepo, RewardAllocationRepo, Tx } from '../ports/referral-repository.js';

/** 单页条数上限（SDD §5.4 游标分页 50/页；登记决策点：可经 configuration 注入）。 */
export const REFERRAL_PAGE_LIMIT = 50;

/** 直属下级 DTO（wire；被绑用户匿名展示名 + 绑定时间 + 累计返点分）。 */
export interface DirectInviteeDto {
  userLabel: string;
  boundAt: string;
  rewardCnyFen: string;
}

export interface DirectInviteesPageDto {
  items: DirectInviteeDto[];
  totalCount: string;
  nextCursor: string | null;
}

/** 返佣明细 DTO（wire；对齐 contracts ReferralRewardDtoSchema）。 */
export interface RewardItemDto {
  rewardId: string;
  sourceUserLabel: string;
  paidAt: string;
  paidAmountCnyFen: string;
  rateBps: number;
  rewardCnyFen: string;
  state: 'FROZEN' | 'AVAILABLE' | 'PAID';
  releaseAt: string | null;
}

export interface RewardsPageDto {
  items: RewardItemDto[];
  rewardType: 1 | 2;
  totalRewardCnyFen: string;
  frozenRewardCnyFen: string;
  availableRewardCnyFen: string;
  nextCursor: string | null;
}

/**
 * 直属下级 + 返佣明细用例（构造注入 ReferralBindingRepo + RewardAllocationRepo +
 * 匿名化端口，不用全局，SDD §4）。
 *
 * `displayNameOf` 经 identity 模块端口注入（跨模块复用，不直接查 user 表，
 * 保持模块内聚；首版实现由 assembly.ts 提供，读 user.publicCode 匿名展示）。
 */
export class ReferralListUseCase {
  constructor(
    private readonly bindingRepo: ReferralBindingRepo,
    private readonly rewardRepo: RewardAllocationRepo,
    private readonly displayNameOf: (userId: string) => Promise<string>,
  ) {}

  /** GET /me/referrals/direct-invitees：列出直属下级（游标分页 50/页）。 */
  async listDirectInvitees(userId: string, cursor: string | null, tx: Tx): Promise<DirectInviteesPageDto> {
    const page = await this.bindingRepo.listBindingsByParent({
      parentUserId: userId,
      cursor,
      limit: REFERRAL_PAGE_LIMIT,
      tx,
    });
    // 匿名化：被绑用户姓名只返回匿名展示名（docs 第 3 节红线）；
    // 累计返点分 = 该上级绑定行 parent1BenefitCents（此用户为直属上级累计已发）。
    const items: DirectInviteeDto[] = [];
    for (const row of page.items) {
      const label = await this.displayNameOf(row.userId);
      items.push({
        userLabel: label,
        boundAt: toIso(row.boundAt),
        rewardCnyFen: row.parent1BenefitCents,
      });
    }
    return { items, totalCount: page.totalCount, nextCursor: page.nextCursor };
  }

  /**
   * GET /me/referrals/rewards?rewardType=1|2：列出当前用户作为上级的返佣
   * 分配（游标分页 50/页）。CUSTOMER_LOSS_REBATE=2 首版平台明细为空值/
   * 零值（线下结算，docs 第 3 节），不生成演示收益。
   */
  async listRewards(userId: string, rewardType: 1 | 2, cursor: string | null, tx: Tx): Promise<RewardsPageDto> {
    const page = await this.rewardRepo.listRewardsByUser({
      userId,
      rewardType,
      cursor,
      limit: REFERRAL_PAGE_LIMIT,
      tx,
    });

    let totalCents = 0n;
    let frozenCents = 0n;
    let availableCents = 0n;
    const items: RewardItemDto[] = [];
    const now = new Date();

    for (const row of page.items) {
      const label = await this.displayNameOf(row.userId);
      const state = toRewardState(row.unlockAt, row.status, now);
      const rewardCents = BigInt(row.rewardCents);
      totalCents += rewardCents;
      if (state === 'FROZEN') frozenCents += rewardCents;
      else availableCents += rewardCents;
      items.push({
        rewardId: row.id,
        sourceUserLabel: label,
        paidAt: toIso(row.createdAt),
        paidAmountCnyFen: row.basisSubcents,
        rateBps: row.rateBps,
        rewardCnyFen: row.rewardCents,
        state,
        releaseAt: row.unlockAt !== null ? toIso(row.unlockAt) : null,
      });
    }

    return {
      items,
      rewardType,
      totalRewardCnyFen: totalCents.toString(),
      frozenRewardCnyFen: frozenCents.toString(),
      availableRewardCnyFen: availableCents.toString(),
      nextCursor: page.nextCursor,
    };
  }
}

function toIso(d: Date | string): string {
  return typeof d === 'string' ? d : d.toISOString();
}

function toRewardState(unlockAt: Date | string | null, status: number, now: Date): 'FROZEN' | 'AVAILABLE' | 'PAID' {
  // status POSTED=1：按 unlockAt 判定 FROZEN / AVAILABLE
  if (unlockAt !== null) {
    const exp = typeof unlockAt === 'string' ? new Date(unlockAt) : unlockAt;
    return exp.getTime() > now.getTime() ? 'FROZEN' : 'AVAILABLE';
  }
  // 无冻结期 → 直接 AVAILABLE
  return status === 1 ? 'AVAILABLE' : 'PAID';
}
