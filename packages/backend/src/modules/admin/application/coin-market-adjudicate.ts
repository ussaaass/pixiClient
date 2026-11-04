/**
 * admin 模块用例：金币集市争议裁决（POST /admin-api/v1/coin-market/trades/:id/adjudicate，
 * DISPUTE 态 3/4/5/6 → RELEASED=7 / RESOLVED_RETURN=10；同事务
 * adjudicated_by_user_id + resolution_code + resolution_note +
 * adjudicated_at 落库 + 审计；support_conversation 关联经
 * trade.supportConversationId 读回，不写会话表）。
 *
 * 领域所有者：admin 模块（coin_market_trade 行锁读 + UPDATE status /
 * 裁决字段；admin_audit_event 同事务 append-only 写；asset_operation
 * 放币 / 返还分录经 wallet ledger 扩展点登记，§6.3 管线未建，
 * 登记决策点）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 coin_market_trade →
 * admin_audit_event，幂等先抢唯一约束）、§9 第 9 步（Admin 全量
 * 切换收口：coin-market DISPUTE 裁决端点，对齐 §9 第 7 步
 * coin-market 双轨差异登记——module 用 models 11 值权威，contracts
 * 9 值 P0 本地简化，对齐 = §9 第 9 步 Admin cutover）；数据库设计
 * SDD §5.13（coin_market_trade 11 态 DDL 权威 + adjudicated_by_user_id
 * + resolution_code ∈ {1,2} + adjudicated_at）。
 *
 * 用例语义：
 * - 行锁读 trade（缺行 → AD_TRADE_NOT_FOUND 404 语义）；
 * - 幂等重放：已 RELEASED=7 / RESOLVED_RETURN=10 → 静默返回既有值
 *   `inserted: false`（200，验收红线"裁决幂等"）；
 * - 状态机前置校验：from ∈ DISPUTE 态 {3,4,5,6} 经
 *   `canTradeAdjudicate` 纯函数（models/coin-market.ts 11 态 DDL 权威）；
 *   非 DISPUTE → 抛 AD_TRADE_NOT_DISPUTE（409 语义）；
 * - `resolutionCode` RELEASE_TO_BUYER=1 → targetStatus RELEASED=7；
 *   RETURN_TO_SELLER=2 → targetStatus RESOLVED_RETURN=10（纯函数
 *   `resolutionCodeOfTarget` 映射，防路由层传参错位）；
 * - 同事务写 admin_audit_event（request_key =
 *   `coin-market:{tradeId}:adjudicate:{resolutionCode}` 幂等兜底；
 *   snapshot 含 supportConversationId 关联，不含会话正文，
 *   经 `validateAuditSnapshot` 脱敏校验）；
 * - 影响行数 0 → 读回既有值（并发推进兜底）；读回非终态 →
 *   STORAGE_UNAVAILABLE（可重试）。
 *
 * 错误码映射（AD → 触发条件）：
 * - `AD_TRADE_NOT_FOUND`：trade 行缺失（404 语义）。
 * - `AD_TRADE_NOT_DISPUTE`：非 DISPUTE 态（3/4/5/6），不可裁决
 *   （409 语义，状态机前置校验失败）。
 * - `AD_PERMISSION_DENIED`：resolutionCode 非法（非 1/2，409 语义）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 状态机影响行数 0
 *   （可重试，503 语义）。
 *
 * 锁顺序（SDD §4）：coin_market_trade（行锁读 + UPDATE status /
 * 裁决字段）→ admin_audit_event（append-only create，同事务），
 * 两表操作无跨表锁竞争（审计经 U(request_key) 幂等兜底，无锁）。
 *
 * 登记决策点（Lead 确认）：
 * 1. 放币 / 返还 asset_operation 分录经 wallet ledger
 *    COIN_MARKET_TRADE=13 / COIN_MARKET_RELEASE=14 扩展点登记，
 *    §6.3 worker 未建，本用例只推进状态 + 裁决字段 + 审计，
 *    出账闭环归 §6.3 管线；
 * 2. adjudicated_at 列存在（models/coin-market.ts L579），与
 *    §9 第 7 步 coin-market 模块"trade 表无 confirmed_at /
 *    released_at / cancelled_at / expired_at"登记决策点一致，
 *    裁决字段经本端点同事务回填，不另建 0017 迁移。
 */

import type { TradeAdjudicationRepo, AdminAuditEventRepo, Tx } from '../ports/admin-repository.js';
import { AdminDomainError, AD } from '../domain/errors.js';
import {
  canTradeAdjudicate,
  TRADE_ADJUDICATE_RELEASED,
  TRADE_ADJUDICATE_RETURN,
  ResolutionCode,
} from '../domain/audit-rules.js';

/** 裁决结果（wire DTO；status 数值常量 wire；时间戳十进制字符串 wire）。 */
export interface TradeAdjudicatedDto {
  tradeId: string;
  status: number;
  resolutionCode: number | null;
  adjudicatedAt: string | null;
  supportConversationId: string | null;
  inserted: boolean;
}

export class CoinMarketAdjudicateUseCase {
  constructor(
    private readonly tradeRepo: TradeAdjudicationRepo,
    private readonly auditRepo: AdminAuditEventRepo,
  ) {}

  /**
   * POST /admin-api/v1/coin-market/trades/:id/adjudicate：争议裁决
   * （DISPUTE 态 → RELEASED=7 / RESOLVED_RETURN=10 + 同事务审计）。
   * 调用方（路由层）负责开事务 + Admin audience 鉴权 + 前置 role_type
   * 校验 + 双人复核校验（裁决经 Admin，登记决策点：是否需双人
   * 复核——首版单 Admin 裁决，§9 第 9 步后续运维闭环），传入 `tx`。
   */
  async run(input: {
    tradeId: string;
    adminUserId: string;
    resolutionCode: number;
    resolutionNote: string;
    requestKey: string;
    snapshot: Record<string, unknown>;
    tx: Tx;
  }): Promise<TradeAdjudicatedDto> {
    // 1. 行锁读 trade（缺行 → 领域错误 404 语义）
    const trade = await this.tradeRepo.lockTrade(input.tradeId, input.tx);
    if (trade === null) {
      throw new AdminDomainError(AD.AD_TRADE_NOT_FOUND, `成交不存在：${input.tradeId}`);
    }

    // 2. resolutionCode 合法性校验（RELEASE_TO_BUYER=1 / RETURN_TO_SELLER=2）
    if (input.resolutionCode !== ResolutionCode.RELEASE_TO_BUYER && input.resolutionCode !== ResolutionCode.RETURN_TO_SELLER) {
      throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '裁决结果码非法（须 1=放币 / 2=返还）。', {
        retryable: false,
      });
    }
    const targetStatus =
      input.resolutionCode === ResolutionCode.RELEASE_TO_BUYER
        ? TRADE_ADJUDICATE_RELEASED
        : TRADE_ADJUDICATE_RETURN;

    // 3. 幂等重放：已 RELEASED=7 / RESOLVED_RETURN=10 → 静默返回既有值
    if (trade.status === TRADE_ADJUDICATE_RELEASED || trade.status === TRADE_ADJUDICATE_RETURN) {
      return {
        tradeId: trade.id,
        status: trade.status,
        resolutionCode: trade.resolutionCode,
        adjudicatedAt:
          trade.adjudicatedAt === null
            ? null
            : typeof trade.adjudicatedAt === 'string'
              ? trade.adjudicatedAt
              : trade.adjudicatedAt.toISOString(),
        supportConversationId: trade.supportConversationId,
        inserted: false,
      };
    }

    // 4. 状态机前置校验（from ∈ DISPUTE 态 3/4/5/6）
    if (!canTradeAdjudicate(trade.status)) {
      throw new AdminDomainError(AD.AD_TRADE_NOT_DISPUTE, `成交状态非 DISPUTE 态，不可裁决（status=${trade.status}）。`, {
        retryable: false,
      });
    }

    // 5. 同事务推进 trade 状态 + 裁决字段 + 审计 append-only
    const now = new Date();
    const result = await this.tradeRepo.adjudicateTrade({
      tradeId: trade.id,
      targetStatus,
      resolutionCode: input.resolutionCode,
      resolutionNote: input.resolutionNote,
      adjudicatedByUserId: input.adminUserId,
      adjudicatedAt: now,
      tx: input.tx,
    });
    if (result === null) {
      // 影响行数 0 = 并发推进 → 读回既有值（幂等兜底）
      const re = await this.tradeRepo.lockTrade(input.tradeId, input.tx);
      if (re !== null && (re.status === TRADE_ADJUDICATE_RELEASED || re.status === TRADE_ADJUDICATE_RETURN)) {
        return {
          tradeId: re.id,
          status: re.status,
          resolutionCode: re.resolutionCode,
          adjudicatedAt:
            re.adjudicatedAt === null
              ? null
              : typeof re.adjudicatedAt === 'string'
                ? re.adjudicatedAt
                : re.adjudicatedAt.toISOString(),
          supportConversationId: re.supportConversationId,
          inserted: false,
        };
      }
      throw new AdminDomainError(AD.STORAGE_UNAVAILABLE, '争议裁决状态机转换失败（影响行数 0），请重试。', {
        retryable: true,
      });
    }

    // 6. 同事务写审计（append-only；request_key 幂等兜底；
    //    snapshot 含 supportConversationId 关联，不含会话正文）
    await this.auditRepo.createAuditEvent({
      adminUserId: input.adminUserId,
      adminSessionKey: null,
      userId: null,
      targetAdminUserId: null,
      assetOperationId: null,
      withdrawalId: null,
      systemConfigId: null,
      gameConfigId: null,
      agentDomainId: null,
      referralBindingEventId: null,
      supportConversationId: trade.supportConversationId,
      coinMarketTradeId: trade.id,
      requestKey: input.requestKey,
      actionCode: 'COIN_MARKET_ADJUDICATE',
      resultType: 1,
      reason: input.resolutionNote,
      snapshot: { ...input.snapshot, supportConversationId: trade.supportConversationId },
      ipHashHex: '0'.repeat(64),
      tx: input.tx,
    });

    return {
      tradeId: result.id,
      status: result.status,
      resolutionCode: result.resolutionCode,
      adjudicatedAt:
        result.adjudicatedAt === null
          ? null
          : typeof result.adjudicatedAt === 'string'
            ? result.adjudicatedAt
            : result.adjudicatedAt.toISOString(),
      supportConversationId: result.supportConversationId,
      inserted: true,
    };
  }
}
