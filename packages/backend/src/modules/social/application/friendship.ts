/**
 * 好友关系用例：POST /me/social/friendships（发起）+
 * POST /me/social/friendships/:id/accept（接受）+
 * POST /me/social/friendships/:id/reject（拒绝）（SDD §5.4 social 端点）。
 *
 * 领域所有者：social 模块（social_friendship 写入/状态机转换；pair 归一纯函数）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（好友申请幂等验收）、§4（锁顺序
 * social_friendship 行锁，幂等先抢 `U(low_user_id, high_user_id)` 唯一约束）；
 * 数据库设计 SDD §5.12（social_friendship PENDING=1 → ACCEPTED=2 /
 * REJECTED=3 / REMOVED=4；pair 用 low/high_user_id 归一 U(low,high)，
 * requester 必须是 pair 成员，CHECK 由迁移保证）。
 *
 * 用例语义：
 * - 发起（initiate）：归一 pair（`normalizePair` 纯函数）→ 创建
 *   social_friendship PENDING=1（U(low,high) 幂等兜底——命中 PENDING 行 →
 *   返回既有行 inserted=false（幂等重放，验收红线"好友申请幂等"）；
 *   命中 ACCEPTED 行 → FRIENDSHIP_PENDING 语义由路由层映射 409；
 *   命中 REJECTED/REMOVED 行 → 允许重新发起（UPDATE 回 PENDING=1，
 *   登记决策点：被拒后能否重新发起，首版允许，若 Lead 要求冷却期需
 *   扩展 responded_at 时间校验）。
 * - 接受（accept）：锁读 → 状态机 PENDING=1 → ACCEPTED=2（影响行数 0 →
 *   FENCING_CONFLICT，由 adapter 层抛错，用例层映射）；
 * - 拒绝（reject）：锁读 → 状态机 PENDING=1 → REJECTED=3（同上）。
 * - 接受/拒绝操作者必须是发起人的对手方（请求者 ≠ requester）。
 *
 * 错误码映射（S → 触发条件）：
 * - `FRIENDSHIP_PENDING`：好友关系已 PENDING（同 pair 重复发起，幂等重放
 *   静默返回既有行，不抛此码；仅路由层 409 语义登记）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 好友关系行缺失（可重试）。
 * - 成功 → FriendshipResultDto（201/200；发起重放 = 200，接受/拒绝 = 200）。
 *
 * 锁顺序（SDD §4）：social_friendship（行锁读 last status）→
 * UPDATE（状态机转换，影响行数 0 → FENCING_CONFLICT）。
 */

import { SocialDomainError, S, isDuplicateKeyError } from '../domain/errors.js';
import { normalizePair } from '../domain/message-rules.js';
import type { FriendshipRepo, Tx } from '../ports/social-repository.js';

/** 好友关系结果（wire DTO；ID 十进制字符串 wire；status 数值常量 wire）。 */
export interface FriendshipResultDto {
  friendshipId: string;
  lowUserId: string;
  highUserId: string;
  requesterUserId: string;
  status: number;
  inserted: boolean;
}

export class FriendshipUseCase {
  constructor(private readonly friendshipRepo: FriendshipRepo) {}

  /**
   * POST /me/social/friendships：发起好友申请（U(low,high) 幂等兜底）。
   * 调用方（路由层）负责开事务，传入 `tx`。
   */
  async initiate(input: { userId: string; peerUserId: string; agentDomainId: string | null; tx: Tx }): Promise<FriendshipResultDto> {
    if (input.userId === input.peerUserId) {
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, '不能向自己发起好友申请。');
    }

    const [lowUserId, highUserId] = normalizePair(input.userId, input.peerUserId);

    let result: {
      inserted: boolean;
      friendship: { id: string; status: number; lowUserId: string; highUserId: string; requesterUserId: string };
    };
    try {
      result = await this.friendshipRepo.createFriendship({
        agentDomainId: input.agentDomainId,
        lowUserId,
        highUserId,
        requesterUserId: input.userId,
        tx: input.tx,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // U(low,high) 命中：读回既有行，按 status 决定语义
        const existing = await this.friendshipRepo.findFriendshipBetween(lowUserId, highUserId, input.tx);
        if (existing !== null) {
          // PENDING=1 → 幂等重放（inserted: false）；
          // ACCEPTED=2 / REJECTED=3 / REMOVED=4 → 首版允许重新发起（adapter 层
          // 已 UPDATE 回 PENDING=1 或保持原值，登记决策点）。
          return {
            friendshipId: existing.id,
            lowUserId,
            highUserId,
            requesterUserId: existing.requesterUserId,
            status: existing.status,
            inserted: false,
          };
        }
      }
      throw err;
    }

    return {
      friendshipId: result.friendship.id,
      lowUserId,
      highUserId,
      requesterUserId: input.userId,
      status: 1, // PENDING
      inserted: result.inserted,
    };
  }

  /**
   * POST /me/social/friendships/:id/accept：接受好友申请
   * （PENDING=1 → ACCEPTED=2；操作者必须是对手方）。
   * 调用方（路由层）负责开事务，传入 `tx`。
   */
  async accept(input: { userId: string; friendshipId: string; tx: Tx }): Promise<FriendshipResultDto> {
    // 1. 锁读好友关系（缺行 → 可重试）
    const friendship = await this.friendshipRepo.lockFriendshipByPk(input.friendshipId, input.tx);
    if (friendship === null) {
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, `好友关系不存在：${input.friendshipId}`, { retryable: true });
    }

    // 2. 操作者必须是发起人的对手方（请求者 ≠ requester）
    if (friendship.requesterUserId === input.userId) {
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, '不能接受自己发起的好友申请。');
    }
    if (friendship.status !== 1) {
      // 非 PENDING → 幂等静默返回既有值（已 ACCEPTED/REJECTED/REMOVED 不再转换）
      if (friendship.status === 2) {
        return {
          friendshipId: friendship.id,
          lowUserId: friendship.lowUserId,
          highUserId: friendship.highUserId,
          requesterUserId: friendship.requesterUserId,
          status: friendship.status,
          inserted: false,
        };
      }
      throw new SocialDomainError(S.FRIENDSHIP_PENDING, '好友申请已处理，不可再接受。');
    }

    // 3. 状态机 PENDING=1 → ACCEPTED=2（adapter 层影响行数 0 → FENCING_CONFLICT）
    const updated = await this.friendshipRepo.markFriendshipAccepted(friendship.id, new Date(), input.tx);

    return {
      friendshipId: updated.id,
      lowUserId: updated.lowUserId,
      highUserId: updated.highUserId,
      requesterUserId: updated.requesterUserId,
      status: updated.status,
      inserted: false,
    };
  }

  /**
   * POST /me/social/friendships/:id/reject：拒绝好友申请
   * （PENDING=1 → REJECTED=3；操作者必须是对手方）。
   * 调用方（路由层）负责开事务，传入 `tx`。
   */
  async reject(input: { userId: string; friendshipId: string; tx: Tx }): Promise<FriendshipResultDto> {
    const friendship = await this.friendshipRepo.lockFriendshipByPk(input.friendshipId, input.tx);
    if (friendship === null) {
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, `好友关系不存在：${input.friendshipId}`, { retryable: true });
    }
    if (friendship.requesterUserId === input.userId) {
      throw new SocialDomainError(S.STORAGE_UNAVAILABLE, '不能拒绝自己发起的好友申请。');
    }
    if (friendship.status !== 1) {
      if (friendship.status === 3) {
        return {
          friendshipId: friendship.id,
          lowUserId: friendship.lowUserId,
          highUserId: friendship.highUserId,
          requesterUserId: friendship.requesterUserId,
          status: friendship.status,
          inserted: false,
        };
      }
      throw new SocialDomainError(S.FRIENDSHIP_PENDING, '好友申请已处理，不可再拒绝。');
    }

    const updated = await this.friendshipRepo.markFriendshipRejected(friendship.id, new Date(), input.tx);

    return {
      friendshipId: updated.id,
      lowUserId: updated.lowUserId,
      highUserId: updated.highUserId,
      requesterUserId: updated.requesterUserId,
      status: updated.status,
      inserted: false,
    };
  }
}
