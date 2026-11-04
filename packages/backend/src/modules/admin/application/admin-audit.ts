/**
 * admin 模块用例：审计事件写（POST /admin-api/v1/audit，201 新写 /
 * 200 幂等重放；request_key 幂等 + snapshot 脱敏；append-only 不可变）。
 *
 * 领域所有者：admin 模块（admin_audit_event 唯一写入点；append-only
 * 经 model hooks 拦截 update/destroy，A.12 第 5 条；U(request_key)
 * 幂等兜底命中 → 返回既有行，不产生第二行，验收红线"审计幂等"）。
 * 对应 SDD 章节：后端实施 SDD §4（幂等先抢唯一约束；所有分录 /
 * outbox 同事务）、§9 第 9 步（Admin 全量切换收口：admin-audit
 * 工作区 → 审计查询 + 写路径）；数据库设计 SDD §5.8（admin_audit_event
 * U(request_key) + status 固定 RECORDED=1 + updated_at=created_at +
 * deleted_at 恒 NULL）。
 *
 * 用例语义：
 * - `requestKey` 经路由层生成（`admin:{actionCode}:{resourceKey}` 或
 *   客户端传入的幂等键；U(request_key) 命中 → 返回既有事件
 *   `inserted: false`（200 幂等重放）；
 * - `snapshot` 经 `validateAuditSnapshot` 脱敏校验（A.8 第 4 条红线：
 *   不含消息正文 / 认证秘密 / 支付凭证明文；黑名单键拒绝落库）；
 * - `ipHash` 经路由层 `crypto.createHash('sha256').update(ip +
 *   secret).digest('hex')` 带密钥摘要计算（32 字节 BINARY；
 *   登记 KMS 未闭环，首版经 env var 注入密钥）；
 * - 多目标引用列（withdrawal / system_config / game_config /
 *   referral_binding_event / support_conversation / coin_market_trade）
 *   按操作类型选择性传入，缺省 null；
 * - 审计行只 create，不 update / destroy（model hooks 拦截；
 *   审计事实不可改写，A.12 第 5 条）。
 *
 * 错误码映射（AD → 触发条件）：
 * - `AD_AUDIT_REQUIRED`：snapshot 脱敏校验失败（含敏感键，400 语义）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障（可重试，503 语义）。
 */

import type { AdminAuditEventRepo, Tx } from '../ports/admin-repository.js';
import { validateAuditSnapshot } from '../domain/audit-rules.js';

/** 审计事件写结果（wire DTO；ID 十进制字符串 wire；status 数值常量 wire）。 */
export interface AdminAuditCreatedDto {
  auditId: string;
  requestKey: string;
  actionCode: string;
  resultType: number;
  createdAt: string;
  inserted: boolean;
}

export class AdminAuditCreateUseCase {
  constructor(private readonly auditRepo: AdminAuditEventRepo) {}

  /**
   * POST /admin-api/v1/audit：写审计事件（201 新写 / 200 幂等重放）。
   * 调用方（路由层）负责开事务 + Admin audience 鉴权 + 前置 role_type
   * 校验 + snapshot 脱敏 + ipHash 带密钥摘要计算，传入 `tx`。
   */
  async run(input: {
    adminUserId: string;
    adminSessionKey: string | null;
    userId: string | null;
    targetAdminUserId: string | null;
    assetOperationId: string | null;
    withdrawalId: string | null;
    systemConfigId: string | null;
    gameConfigId: string | null;
    agentDomainId: string | null;
    referralBindingEventId: string | null;
    supportConversationId: string | null;
    coinMarketTradeId: string | null;
    requestKey: string;
    actionCode: string;
    resultType: number;
    reason: string;
    snapshot: Record<string, unknown>;
    ipHashHex: string;
    tx: Tx;
  }): Promise<AdminAuditCreatedDto> {
    // 1. snapshot 脱敏校验（A.8 第 4 条红线；黑名单键拒绝落库）
    const validated = validateAuditSnapshot(input.snapshot);

    // 2. 写审计事件（U(request_key) 幂等兜底；append-only 只 create）
    const result = await this.auditRepo.createAuditEvent({
      adminUserId: input.adminUserId,
      adminSessionKey: input.adminSessionKey,
      userId: input.userId,
      targetAdminUserId: input.targetAdminUserId,
      assetOperationId: input.assetOperationId,
      withdrawalId: input.withdrawalId,
      systemConfigId: input.systemConfigId,
      gameConfigId: input.gameConfigId,
      agentDomainId: input.agentDomainId,
      referralBindingEventId: input.referralBindingEventId,
      supportConversationId: input.supportConversationId,
      coinMarketTradeId: input.coinMarketTradeId,
      requestKey: input.requestKey,
      actionCode: input.actionCode,
      resultType: input.resultType,
      reason: input.reason,
      snapshot: validated,
      ipHashHex: input.ipHashHex,
      tx: input.tx,
    });

    const event = result.event;
    return {
      auditId: event.id,
      requestKey: input.requestKey,
      actionCode: input.actionCode,
      resultType: input.resultType,
      createdAt: typeof event.createdAt === 'string' ? event.createdAt : event.createdAt.toISOString(),
      inserted: result.inserted,
    };
  }
}
