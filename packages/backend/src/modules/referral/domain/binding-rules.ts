/**
 * referral 模块纯领域规则（五级返点率表 + 域隔离 + 链连续性，无 IO）。
 *
 * 领域所有者：referral 模块（domain/binding-rules.ts；用例层 / 适配器层前置校验
 * 经本文件纯函数，不直接读表）。
 * 对应 SDD 章节：后端实施 SDD §4（构造注入 ports，用例纯函数前置校验）、
 * §9 第 6 步（邀请归因返佣）；数据库设计 SDD §5.5（referral_binding 链连续性
 * CHECK：parent_2 非空 ⇒ parent_1 非空，依此类推）；docs/04_domains/
 * 邀请归因返佣与数据规范.md（五级 10/8/5/3，本人第 1 级最多 4 个上级）。
 *
 * 五级返点率约定（docs 04_domains/邀请归因返佣与数据规范.md 第 4 节）：
 * - 本人为第 1 级，最多 4 个上级（关系边数 4）；
 * - 直属上级 depth=1 → 10%（1000 bps）；
 * - 上上级 depth=2 → 8%（800 bps）；
 * - 第三级 depth=3 → 5%（500 bps）；
 * - 第四级 depth=4 → 3%（300 bps）；
 * - 配置值落库为 INT `rate_bps`，奖励计算经 DECIMAL(38,12) 精确值
 *   `basis_subcents` / `exact_reward_subcents`（十进制字符串 wire）；
 * - 本人（来源客户）不占上级比例，不自返佣。
 *
 * 链连续性约定（SDD §5.5 CHECK 约束 + 应用层前置校验双兜底）：
 * - `parent_2` 非空 ⇒ `parent_1` 非空（依此类推）；
 * - 链中不得包含被绑用户本人（自绑定）；
 * - 链中不得出现重复用户（循环检测）。
 */

/**
 * 五级返点率表（depth 1~4 → rate_bps）；本人不计入（第 5 级无返点）。
 * 常量对齐 models/referral.ts `rate_bps` 列（INT UNSIGNED，默认 1000/800/500/300）。
 */
export const REWARD_RATES_BPS: Readonly<Record<1 | 2 | 3 | 4, number>> = Object.freeze({
  1: 1000, // 直属上级 10%
  2: 800, // 上上级 8%
  3: 500, // 第三级 5%
  4: 300, // 第四级 3%
});

/** 五级返点率查询（depth 1~4，越界 / 非整数 → null）。 */
export function rateBpsOf(depth: number): number | null {
  if (depth === 1 || depth === 2 || depth === 3 || depth === 4) {
    return REWARD_RATES_BPS[depth];
  }
  return null;
}

/** 五级返点率表最大 depth（1~4 有效；5 及以上无返点，本人不占比例）。 */
export const MAX_ANCESTOR_DEPTH = 4;

/**
 * 链连续性校验（SDD §5.5 CHECK 约束应用层前置双兜底）：
 * - 数组为完整上级链 [parent1, parent2, parent3, parent4]，其中后段允许 null；
 * - 链连续性：`parent_n` 非空 ⇒ `parent_{n-1}` 非空；
 * - 自绑定：被绑 userId 不得出现在链中；
 * - 循环：链内不得出现重复 userId。
 *
 * @returns 合法返回 `true`；不合法返回 `false`（用例层抛 `BINDING_CHAIN_BROKEN`）。
 */
export function isValidBindingChain(userId: string, chain: [string, string | null, string | null, string | null]): boolean {
  const [p1, p2, p3, p4] = chain;
  // 1. 被绑用户不得在链中（自绑定）
  if (p1 === userId || p2 === userId || p3 === userId || p4 === userId) return false;
  // 2. 链连续性：parent_2 非空 ⇒ parent_1 非空（依此类推）
  if (p2 !== null && p1 === null) return false;
  if (p3 !== null && p2 === null) return false;
  if (p4 !== null && p3 === null) return false;
  // 3. 循环：链内不得重复
  const seen = new Set<string>();
  for (const p of [p1, p2, p3, p4]) {
    if (p !== null) {
      if (seen.has(p)) return false;
      seen.add(p);
    }
  }
  return true;
}

/**
 * 域隔离校验（agent_domain 非空时归因结果绑定到该域，跨域不可见）：
 * - 被绑用户与归因上下文（邀请人）必须同属一个 agent_domain，
 *   或两者之一 agent_domain_id 为 NULL（平台公共，无域隔离）；
 * - 归因来源 IP_ATTRIBUTION=1（Redis 候选）或 INVITE_CODE=2 时，
 *   邀请人的 agent_domain_id 决定域归属；ADMIN=3 换绑由 Admin 跨域操作
 *   （§9 第 9 步 Admin 端点，本规则不拦截）。
 *
 * @param requesterDomainId 邀请人（归因发起方）的 agent_domain_id（NULL = 平台公共）
 * @param inviteeDomainId   被绑用户的 agent_domain_id（NULL = 平台公共）
 * @param sourceType 归因来源（1=IP_ATTRIBUTION / 2=INVITE_CODE / 3=ADMIN）
 * @returns 域隔离合法返回 `true`；跨域冲突返回 `false`（用例层抛
 *   `REFERRAL_NOT_FOUND` 语义"该归因不可见"，登记决策点：首版跨域归因静默
 *   降级为平台公共域归因而非 403，与社交模块域隔离语义对齐）。
 */
export function isDomainIsolationLegal(requesterDomainId: string | null, inviteeDomainId: string | null, sourceType: 1 | 2 | 3): boolean {
  // Admin 换绑（sourceType=3）不受域隔离限制（§9 第 9 步 Admin 端点）
  if (sourceType === 3) return true;
  // 平台公共域（NULL）与任何域均可归因
  if (requesterDomainId === null || inviteeDomainId === null) return true;
  // 同域归因合法
  return requesterDomainId === inviteeDomainId;
}

/**
 * 奖励发放门禁（充值返点 2 天 / 客损 1 天，SDD §4 约定）：
 * - `unlockAt` 为 null（未冻结 / 已解冻）→ 可发放；
 * - `unlockAt` 非空且 `now >= unlockAt` → 可发放；
 * - `unlockAt` 非空且 `now < unlockAt` → 不可发放（用例层抛 `REWARD_LOCKED`）。
 */
export function isRewardUnlockable(unlockAt: Date | string | null, now: Date): boolean {
  if (unlockAt === null) return true;
  const unlock = typeof unlockAt === 'string' ? new Date(unlockAt) : unlockAt;
  return now.getTime() >= unlock.getTime();
}

/** 代理域状态常量（对齐 models/admin.ts AgentDomainStatus + contracts invite-agent.ts）。 */
export const AgentDomainStatus = {
  PENDING_REVIEW: 1,
  ACTIVE: 2,
  SUSPENDED: 3,
  REVOKED: 4,
  WITHDRAWN: 5,
} as const;

/** 代理域状态值联合类型。 */
export type AgentDomainStatusValue = (typeof AgentDomainStatus)[keyof typeof AgentDomainStatus];

/**
 * 代理域可写性校验（申请 / 查询端点前置；SDD §9 第 6 步"首版只建申请 + 查询"）：
 * - PENDING_REVIEW=1 → 不可重申请（幂等返回既有行）；
 * - ACTIVE=2 → 不可重申请（幂等返回既有行）；
 * - SUSPENDED=3 / REVOKED=4 / WITHDRAWN=5 → 不可重申请（Admin 审批端点
 *   §9 第 9 步处理恢复 / 撤销，本端点只读返回现状）。
 *
 * @returns `true` 表示该状态可发起新申请（首版仅 NULL / 无行可写）；
 *   `false` 表示已有域行，幂等返回既有值。
 */
export function canApplyAgentDomain(status: AgentDomainStatusValue | null): boolean {
  // 无行（null）可新申请；任何已有行状态均返回既有值（幂等）
  return status === null;
}
