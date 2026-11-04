/**
 * support 模块纯函数（坐席 claim 幂等键生成、回复权限检查、
 * 会话状态机转换合法性校验）。
 *
 * 领域所有者：support 模块（纯函数，无 IO；用例层调用）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（坐席领取/回复/重开幂等验收）、
 * §4（幂等先抢唯一约束；所有分录/outbox 同事务）；数据库设计 SDD §5.9
 * （support_conversation 状态机 WAITING_SUPPORT=1 → WAITING_USER=2 →
 * CLOSED=3 + closed_at；closed_at 后不可再追加消息；未读计数与
 * 消息写入同事务更新）。
 */

// ---------------------------------------------------------------------------
// 坐席 claim 幂等键
// ---------------------------------------------------------------------------

/**
 * 坐席 claim 幂等键（`support:claim:{conversationId}:{adminUserId}`）。
 * U 约束 + 行值校验双兜底：
 * - 已 claim 同 admin → 静默返回既有值（不产生第二笔，验收红线"坐席领取幂等"）；
 * - 已 claim 异 admin → 抛 SUPPORT_IDEMPOTENCY_KEY_REUSED（跨坐席冲突）。
 */
export function supportClaimKeyOf(conversationId: string, adminUserId: string): string {
  return `support:claim:${conversationId}:${adminUserId}`;
}

// ---------------------------------------------------------------------------
// 回复权限检查（坐席 claim 后 + 会话未 CLOSED）
// ---------------------------------------------------------------------------

/**
 * 坐席回复权限校验（首版同 player token + role_type 校验；完整 Admin
 * audience 中间件归 §9 第 9 步）。
 * - 操作者 `role_type` 必须含 ADMIN=4 位标记（role_type 位标记：
 *   PLAYER=1 / AGENT=2 / ADMIN=4 / SYSTEM=8，合法组合 1、3、4、8）；
 * - 会话 `assigned_admin_user_id` 必须 = 操作者 userId（claim 后）；
 * - 会话 `status` 必须 ≠ CLOSED=3（closed_at 后不可再追加消息，§5.9）。
 *
 * @returns true = 允许回复；false = 拒绝（用例映射 SUPPORT_NOT_ASSIGNED /
 *   SUPPORT_CONVERSATION_CLOSED / 403 语义由路由层决定）。
 */
export function canAdminReply(input: {
  adminRoleType: number;
  adminUserId: string;
  assignedAdminUserId: string | null;
  conversationStatus: number;
}): boolean {
  // role_type 位标记：ADMIN=4 位必须置位（合法组合 4 或 3|4 等；
  // 首版只接受含 ADMIN=4 位的 operator，登记决策点：是否接受 AGENT=2 代客服）。
  if ((input.adminRoleType & 4) === 0) return false;
  if (input.conversationStatus === 3) return false; // CLOSED=3
  if (input.assignedAdminUserId === null) return false;
  if (input.assignedAdminUserId !== input.adminUserId) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 会话状态机转换合法性
// ---------------------------------------------------------------------------

/**
 * 校验会话状态机转换（WAITING_SUPPORT=1 → WAITING_USER=2 → CLOSED=3，
 * 单向推进，不可回退；用户回复后 1→2，坐席 resolve 后 2→3）。
 * @returns true = 合法转换；false = 非法（用例映射 STORAGE_UNAVAILABLE 可重试）。
 */
export function isValidConversationStatusTransition(fromStatus: number, toStatus: number): boolean {
  if (fromStatus === 1 && toStatus === 2) return true; // WAITING_SUPPORT → WAITING_USER
  if (fromStatus === 2 && toStatus === 3) return true; // WAITING_USER → CLOSED
  // 同状态重放（幂等）：1→1 / 2→2 / 3→3 允许（不影响行数 = 0 → 幂等静默）
  if (fromStatus === toStatus) return true;
  return false;
}
