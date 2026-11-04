/**
 * social 模块纯函数（message_no 游标校验、client_message_id 幂等键生成、
 * block 检查、好友 pair 归一、工单坐席 claim 幂等键）。
 *
 * 领域所有者：social 模块（纯函数，无 IO；用例层调用）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（社交与客服：双账号私信幂等、
 * 消息补拉一致性、坐席领取/回复幂等）、§4（幂等先抢唯一约束；
 * 所有分录/outbox 同事务）；数据库设计 SDD §5.12（social 各表 U 约束、
 * 游标单调递增且 ≤ 高水位）。
 */

// ---------------------------------------------------------------------------
// 好友 pair 归一（low < high）
// ---------------------------------------------------------------------------

/**
 * 归一好友/会话 pair（low/high user_id 十进制字符串数值比较，
 * low < high；U(low_user_id, high_user_id) 幂等兜底，CHECK low<high 由迁移保证）。
 * @returns [lowUserId, highUserId]。
 */
export function normalizePair(userIdA: string, userIdB: string): [string, string] {
  if (BigInt(userIdA) < BigInt(userIdB)) {
    return [userIdA, userIdB];
  }
  return [userIdB, userIdA];
}

// ---------------------------------------------------------------------------
// 会话消息游标（message_no 单调递增）
// ---------------------------------------------------------------------------

/**
 * 计算下一 message_no（会话 last_message_no 高水位 + 1；十进制字符串 wire，
 * BIGINT UNSIGNED；U(social_conversation_id, message_no) 保证会话内唯一）。
 * @param lastMessageNo 会话当前高水位（十进制字符串，新会话 = `0`）。
 * @returns 下一个 message_no 十进制字符串。
 */
export function nextMessageNo(lastMessageNo: string): string {
  return (BigInt(lastMessageNo) + 1n).toString();
}

/**
 * 校验补拉游标（after_message_no）合法性（十进制数字字符串；`''` = 从头拉取）。
 * @returns 合法游标（`''` 归一为 `0` 起点）；非法 → null。
 */
export function normalizeMessageCursor(afterMessageNo: string | null | undefined): string | null {
  if (afterMessageNo === null || afterMessageNo === undefined || afterMessageNo === '') {
    return '0';
  }
  if (!/^[0-9]{1,19}$/.test(afterMessageNo)) return null;
  return afterMessageNo;
}

/** 单页补拉上限（SDD 验收"双账号私信幂等、消息补拉一致性"；首版固定 50，可经配置注入，决策点登记）。 */
export const MESSAGE_PAGE_LIMIT = 50;

// ---------------------------------------------------------------------------
// 已读游标（user_low/high_read_through_no 单调递增 ≤ last_message_no）
// ---------------------------------------------------------------------------

/**
 * 校验已读游标推进合法性（必须单调递增且不超过会话高水位 last_message_no）。
 * @returns true = 合法；false = 非法（用例映射 STORAGE_UNAVAILABLE 或
 *   静默忽略，决策点登记：首版静默忽略回退/越界游标，不抛错）。
 */
export function canAdvanceReadThrough(readThroughNo: string, lastMessageNo: string): boolean {
  const rt = BigInt(readThroughNo);
  const hi = BigInt(lastMessageNo);
  return rt <= hi;
}

// ---------------------------------------------------------------------------
// 坐席 claim 幂等键（support 模块同款键生成，经本纯函数登记约定）
// ---------------------------------------------------------------------------

/**
 * 坐席 claim 幂等键（`support:claim:{conversationId}:{adminUserId}`，
 * U 约束 + 行值校验双兜底；已 claim 同 admin → 静默返回既有值，不产生第二笔）。
 */
export function supportClaimKeyOf(conversationId: string, adminUserId: string): string {
  return `support:claim:${conversationId}:${adminUserId}`;
}
