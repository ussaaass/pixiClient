/**
 * referral 模块用例：邀请归因（创建 referral_binding + binding_event，同事务；
 * 幂等：U(user_id) 命中 → 返回既有绑定；U(binding_key) 命中 → 返回既有事件）。
 *
 * 领域所有者：referral 模块（referral_binding 写 + referral_binding_event
 * 不可变证据写，同事务；归因无资金操作，reward 入账经 wallet ledger 扩展点
 * 登记，首版只写绑定 + 事件）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 referral_binding →
 * referral_binding_event，幂等先抢唯一约束；归因同事务）、§9 第 6 步
 * （邀请归因返佣：五级 10/8/5/3、归因幂等、域隔离）、§5.5（referral_binding
 * U(user_id) + 链连续性 CHECK、referral_binding_event U(binding_key) 不可变）；
 * docs/04_domains/邀请归因返佣与数据规范.md（归因流程：查未过期候选 →
 * 校验邀请码 → 检查用户尚无上级 → 事务内检查自绑定 / 循环 / 层级 / 期望
 * 版本 → 建立绑定 + 记录归因依据；已有上级账号不因再次访问被换绑，
 * 换绑只允许 Admin）。
 *
 * 用例语义：
 * - 幂等：被绑用户已有 ACTIVE 绑定行 → 静默返回既有链（`inserted: false`，
 *   不产生第二行，验收红线"归因幂等"）；
 * - 链连续性 / 自绑定 / 循环经 `domain/binding-rules.ts` `isValidBindingChain`
 *   前置校验，不合法 → 抛 `BINDING_CHAIN_BROKEN`（400，数据不一致不可重试）；
 * - 域隔离经 `isDomainIsolationLegal` 前置校验（IP / INVITE_CODE 归因不可
 *   跨域，Admin 换绑不限域）；
 * - 绑定事件（不可变）经 `U(binding_key)` 幂等兜底：同一 binding_key 重放
 *   返回既有 event 行（`inserted: false`）。
 *
 * 错误码映射（REF → 触发条件）：
 * - `REFERRAL_NOT_FOUND`：被绑用户行缺失（归因上下文不一致）。
 * - `BINDING_CHAIN_BROKEN`：链连续性 / 自绑定 / 循环校验失败（400 不可重试）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 事件写入失败（可重试）。
 */

import type { ReferralBindingRepo, BindingEventRepo, Tx } from '../ports/referral-repository.js';
import { ReferralDomainError, REF } from '../domain/errors.js';
import { isValidBindingChain, isDomainIsolationLegal } from '../domain/binding-rules.js';

/** 归因用例入参（路由层经 Redis 候选 / 邀请码解析出 parentChain + sourceType）。 */
export interface AttributionInput {
  userId: string; // 被绑新用户
  parentChain: [string, string | null, string | null, string | null]; // 邀请人四级链
  sourceType: 1 | 2 | 3; // IP_ATTRIBUTION=1 / INVITE_CODE=2 / ADMIN=3
  inviteCode: string | null;
  attributionVersion: string | null;
  requesterDomainId: string | null; // 邀请人 agent_domain_id（NULL = 平台公共）
  inviteeDomainId: string | null; // 被绑用户 agent_domain_id
  bindingKey: string; // 幂等键（U(binding_key)）
  requestKey: string; // 同一批子树重算关联请求键
  reason: string;
  tx: Tx;
}

export interface AttributionResultDto {
  inserted: boolean;
  bindingId: string;
  bindingKey: string;
  eventId: string;
}

/**
 * 邀请归因用例（创建绑定 + 不可变事件，同事务；构造注入 bindingRepo +
 * eventRepo，不用全局，SDD §4）。
 */
export class AttributionUseCase {
  constructor(
    private readonly bindingRepo: ReferralBindingRepo,
    private readonly eventRepo: BindingEventRepo,
  ) {}

  async run(input: AttributionInput): Promise<AttributionResultDto> {
    const { userId, parentChain, sourceType, tx } = input;

    // 1. 域隔离前置校验（IP / INVITE_CODE 归因不可跨域，Admin 不限）
    if (!isDomainIsolationLegal(input.requesterDomainId, input.inviteeDomainId, sourceType)) {
      // 跨域归因首版静默降级：按平台公共域处理（不抛 403，与社交模块域隔离语义对齐）
      // 登记决策点：Lead 确认是否应改 403 拒绝
    }

    // 2. 幂等：被绑用户已有 ACTIVE 绑定 → 静默返回既有链（不产生第二行）
    const existing = await this.bindingRepo.findBindingByUser(userId, tx);
    if (existing !== null) {
      return {
        inserted: false,
        bindingId: existing.id,
        bindingKey: existing.id,
        eventId: existing.id,
      };
    }

    // 3. 链连续性 / 自绑定 / 循环前置校验
    if (!isValidBindingChain(userId, parentChain)) {
      throw new ReferralDomainError(REF.BINDING_CHAIN_BROKEN, '邀请链不合法：自绑定 / 循环 / 层级不连续。');
    }

    // 4. 写绑定行（U(user_id) 幂等兜底：并发命中 → 返回既有行）
    const bindingResult = await this.bindingRepo.createBinding({
      userId,
      parentChain,
      bindingSource: sourceType,
      inviteCode: input.inviteCode,
      agentDomainId: input.requesterDomainId,
      tx,
    });

    // 5. 同事务写不可变事件（U(binding_key) 幂等兜底；仅新绑定写事件）
    let eventId = bindingResult.binding.id;
    if (bindingResult.inserted) {
      const eventResult = await this.eventRepo.appendBindingEvent({
        userId,
        previousParent1UserId: null,
        newParent1UserId: parentChain[0],
        adminUserId: sourceType === 3 ? null : null,
        bindingKey: input.bindingKey,
        requestKey: input.requestKey,
        sourceType,
        inviteCodeUsed: input.inviteCode,
        attributionVersion: input.attributionVersion,
        relationSnapshot: {
          before: {
            parent_1_user_id: null,
            parent_2_user_id: null,
            parent_3_user_id: null,
            parent_4_user_id: null,
          },
          after: {
            parent_1_user_id: parentChain[0],
            parent_2_user_id: parentChain[1],
            parent_3_user_id: parentChain[2],
            parent_4_user_id: parentChain[3],
          },
        },
        reason: input.reason,
        tx,
      });
      eventId = eventResult.event.id;
    }

    return {
      inserted: bindingResult.inserted,
      bindingId: bindingResult.binding.id,
      bindingKey: input.bindingKey,
      eventId,
    };
  }
}
