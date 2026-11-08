/**
 * admin 模块仓储适配器（Sequelize 实现各 Repo 端口；models/admin.ts
 * 4 model + 跨模块 model（coin_market_trade / withdrawal / ai_asset_job
 * / user）经本层落库；每表一类，实体前缀命名）。
 *
 * 领域所有者：admin 模块（models/admin.ts 为其唯一 model 定义；
 * agent_domain 行锁/幂等/状态机转换 + admin_audit_event append-only
 * 全在此层落库；跨模块 model 只读投影 + 状态机 UPDATE，经本层
 * 端口封装，admin 模块不直接 import 各模块 ports，保持模块边界
 * SDD §3.2 实体归属矩阵）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 agent_domain /
 * coin_market_trade / withdrawal / ai_asset_job → admin_audit_event，
 * 幂等先抢唯一约束）、§9 第 9 步（Admin 全量切换收口）；数据库设计
 * SDD §5.2.1 / §5.8（agent_domain 5 态 + admin_audit_event
 * U(request_key) append-only DDL 权威）。
 *
 * 行锁与并发约定（与 rooms / social / referral / coin-market /
 * ai-assets 适配器同款纪律）：
 * - `lock: 'FOR UPDATE'` 字符串字面量写法（InnoDB 行锁，§4 锁顺序）；
 * - 不可变表 `admin_audit_event` 只 create，model hooks 拦截
 *   update/destroy（_shared.ts A.12 第 5 条；appendOnlyModelOptions
 *   + appendOnlyHooks 经 models/admin.ts register 注册）；
 * - 唯一约束幂等兜底：`U(request_key)`（admin_audit_event）命中 →
 *   读回既有行（`inserted: false`，不产生第二行，验收红线"审计幂等"）；
 * - `as never` 桥接（Sequelize 6 严格模式下 BIGINT 列 create/update
 *   attrs + options 对象 `exactOptionalPropertyTypes` 同款写法，
 *   rooms 适配器先例）；
 * - `Op` unique symbol 索引经 `as unknown as string` 桥接（TS2538，
 *   referral 适配器同款写法）。
 *
 * 结构约定（每表一类，不混类；7 个 Repo 接口拆 7 个独立类）：
 * - `SequelizeAgentDomainRepo`（agent_domain 写）
 * - `SequelizeAdminAuditEventRepo`（admin_audit_event append-only）
 * - `SequelizeAdminPermissionRepo`（admin_permission 只读）
 * - `SequelizeTradeAdjudicationRepo`（coin_market_trade 裁决）
 * - `SequelizeWithdrawalReviewRepo`（withdrawal 审批 / 驳回）
 * - `SequelizeAiJobReviewRepo`（ai_asset_job 审核推进）
 * - `SequelizeAdminUserRepo`（user admin 视角只读）
 * 共享 `txOf` 辅助函数保留在文件顶部，各 Repo 类都调。
 */

import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import type { AgentDomainModel, AdminAuditEventModel, AdminPermissionModel } from '../../../infrastructure/database/models/admin.js';
import { AgentDomainStatus, RecordStatus } from '../../../infrastructure/database/models/admin.js';
import type { CoinMarketTradeModel } from '../../../infrastructure/database/models/coin-market.js';
import type { WithdrawalModel } from '../../../infrastructure/database/models/payments.js';
import { WithdrawalStatus } from '../../../infrastructure/database/models/payments.js';
import type { AiAssetJobModel } from '../../../infrastructure/database/models/assets.js';
import { AiJobStatus } from '../../../infrastructure/database/models/assets.js';
import type { UserModel } from '../../../infrastructure/database/models/identity.js';
import type {
  AgentDomainRepo,
  AdminAuditEventRepo,
  AdminPermissionRepo,
  TradeAdjudicationRepo,
  WithdrawalReviewRepo,
  AiJobReviewRepo,
  AdminUserRepo,
  Tx,
} from '../ports/admin-repository.js';
import { isDuplicateKeyError } from '../domain/errors.js';

/** 取事务（Sequelize Transaction 鸭子类型；与 rooms 适配器同款约定）。
 * 返回 `Transaction | null`（exactOptionalPropertyTypes 下 undefined 不可赋给
 * null 槽，统一 null 化；options 经 `as never` 整体桥接后直传）。 */
function txOf(tx: Tx): Transaction | null {
  return (tx.transaction as Transaction | undefined) ?? null;
}

/** hex(64) → Buffer(32)（BINARY(32) 落库用）。 */
function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/** 稳定游标解析 `{createdAt ISO}~{id}`。 */
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
// AgentDomainRepo（agent_domain 写：审批 / 暂停 / 撤销）
// ---------------------------------------------------------------------------

export class SequelizeAgentDomainRepo implements AgentDomainRepo {
  constructor(private readonly model: typeof AgentDomainModel) {}

  async lockAgentDomain(domainId: string, tx: Tx): Promise<AgentDomainModel | null> {
    const txq = txOf(tx);
    return this.model.findByPk(domainId, { lock: 'FOR UPDATE', transaction: txq } as never);
  }

  async approveAgentDomain(input: { domainId: string; approvedAt: Date; tx: Tx }): Promise<AgentDomainModel | null> {
    const txq = txOf(input.tx);
    const [affected] = await this.model.update(
      {
        status: AgentDomainStatus.ACTIVE as never,
        approvedAt: input.approvedAt,
      } as never,
      {
        where: { id: input.domainId as never, status: AgentDomainStatus.PENDING_REVIEW } as never,
        transaction: txq,
      } as never,
    );
    if (affected === 0) return null;
    const row = await this.model.findByPk(input.domainId, { transaction: txq } as never);
    return row;
  }

  async suspendAgentDomain(input: { domainId: string; suspendedAt: Date; tx: Tx }): Promise<AgentDomainModel | null> {
    const txq = txOf(input.tx);
    const [affected] = await this.model.update(
      {
        status: AgentDomainStatus.SUSPENDED as never,
        suspendedAt: input.suspendedAt,
      } as never,
      {
        where: { id: input.domainId as never, status: AgentDomainStatus.ACTIVE } as never,
        transaction: txq,
      } as never,
    );
    if (affected === 0) return null;
    const row = await this.model.findByPk(input.domainId, { transaction: txq } as never);
    return row;
  }

  async revokeAgentDomain(input: { domainId: string; revokedAt: Date; tx: Tx }): Promise<AgentDomainModel | null> {
    const txq = txOf(input.tx);
    const [affected] = await this.model.update(
      {
        status: AgentDomainStatus.REVOKED as never,
        revokedAt: input.revokedAt,
      } as never,
      {
        where: {
          id: input.domainId as never,
          status: { [Op.in as unknown as string]: [AgentDomainStatus.ACTIVE, AgentDomainStatus.SUSPENDED] },
        } as never,
        transaction: txq,
      } as never,
    );
    if (affected === 0) return null;
    const row = await this.model.findByPk(input.domainId, { transaction: txq } as never);
    return row;
  }
}

// ---------------------------------------------------------------------------
// AdminAuditEventRepo（admin_audit_event append-only；U(request_key) 幂等）
// ---------------------------------------------------------------------------

export class SequelizeAdminAuditEventRepo implements AdminAuditEventRepo {
  constructor(private readonly model: typeof AdminAuditEventModel) {}

  async createAuditEvent(input: {
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
  }): Promise<{ inserted: boolean; event: AdminAuditEventModel }> {
    const txq = txOf(input.tx);

    // U(request_key) 幂等兜底：命中 → 读回既有行（append-only 不可改写，
    // 不产生第二行，验收红线"审计幂等"）
    try {
      const event = await this.model.create(
        {
          status: RecordStatus.RECORDED as never,
          adminUserId: input.adminUserId as never,
          adminSessionKey: input.adminSessionKey,
          userId: input.userId as never,
          targetAdminUserId: input.targetAdminUserId as never,
          assetOperationId: input.assetOperationId as never,
          withdrawalId: input.withdrawalId as never,
          systemConfigId: input.systemConfigId as never,
          gameConfigId: input.gameConfigId as never,
          agentDomainId: input.agentDomainId as never,
          referralBindingEventId: input.referralBindingEventId as never,
          supportConversationId: input.supportConversationId as never,
          coinMarketTradeId: input.coinMarketTradeId as never,
          requestKey: input.requestKey,
          actionCode: input.actionCode,
          resultType: input.resultType as never,
          reason: input.reason,
          snapshot: input.snapshot as never,
          ipHash: hexToBuffer(input.ipHashHex),
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, event };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const existing = await this.findAuditEventByRequestKey(input.requestKey, input.tx);
        if (existing !== null) return { inserted: false, event: existing };
      }
      throw err;
    }
  }

  async findAuditEventByRequestKey(requestKey: string, tx: Tx): Promise<AdminAuditEventModel | null> {
    const txq = txOf(tx);
    return this.model.findOne({
      where: { requestKey } as never,
      transaction: txq,
    } as never);
  }
}

// ---------------------------------------------------------------------------
// AdminPermissionRepo（admin_permission 只读目录）
// ---------------------------------------------------------------------------

export class SequelizeAdminPermissionRepo implements AdminPermissionRepo {
  constructor(private readonly model: typeof AdminPermissionModel) {}

  async findPermissionByCode(permissionCode: string, tx: Tx): Promise<AdminPermissionModel | null> {
    const txq = txOf(tx);
    return this.model.findOne({
      where: { permissionCode } as never,
      transaction: txq,
    } as never);
  }

  async findPermissionByRoute(httpMethod: string, pathPattern: string, tx: Tx): Promise<AdminPermissionModel | null> {
    const txq = txOf(tx);
    return this.model.findOne({
      where: { httpMethod, pathPattern } as never,
      transaction: txq,
    } as never);
  }
}

// ---------------------------------------------------------------------------
// TradeAdjudicationRepo（coin_market_trade 裁决；跨模块读经本端口）
// ---------------------------------------------------------------------------

export class SequelizeTradeAdjudicationRepo implements TradeAdjudicationRepo {
  constructor(private readonly model: typeof CoinMarketTradeModel) {}

  async lockTrade(tradeId: string, tx: Tx): Promise<CoinMarketTradeModel | null> {
    const txq = txOf(tx);
    return this.model.findByPk(tradeId, { lock: 'FOR UPDATE', transaction: txq } as never);
  }

  async adjudicateTrade(input: {
    tradeId: string;
    targetStatus: number;
    resolutionCode: number;
    resolutionNote: string;
    adjudicatedByUserId: string;
    adjudicatedAt: Date;
    tx: Tx;
  }): Promise<CoinMarketTradeModel | null> {
    const txq = txOf(input.tx);
    const [affected] = await this.model.update(
      {
        status: input.targetStatus as never,
        resolutionCode: input.resolutionCode as never,
        resolutionNote: input.resolutionNote,
        adjudicatedByUserId: input.adjudicatedByUserId as never,
        adjudicatedAt: input.adjudicatedAt,
      } as never,
      {
        where: {
          id: input.tradeId as never,
          // DISPUTE 态 3/4/5/6（防并发已终态推进）
          status: { [Op.in as unknown as string]: [3, 4, 5, 6] },
        } as never,
        transaction: txq,
      } as never,
    );
    if (affected === 0) return null;
    const row = await this.model.findByPk(input.tradeId, { transaction: txq } as never);
    return row;
  }
}

// ---------------------------------------------------------------------------
// WithdrawalReviewRepo（withdrawal 审批 / 驳回；双人复核经用例层强制）
// ---------------------------------------------------------------------------

export class SequelizeWithdrawalReviewRepo implements WithdrawalReviewRepo {
  constructor(private readonly model: typeof WithdrawalModel) {}

  async lockWithdrawal(withdrawalId: string, tx: Tx): Promise<WithdrawalModel | null> {
    const txq = txOf(tx);
    return this.model.findByPk(withdrawalId, { lock: 'FOR UPDATE', transaction: txq } as never);
  }

  async approveWithdrawal(input: { withdrawalId: string; approvedAt: Date; tx: Tx }): Promise<WithdrawalModel | null> {
    const txq = txOf(input.tx);
    const [affected] = await this.model.update(
      {
        status: WithdrawalStatus.APPROVED as never,
        approvedAt: input.approvedAt,
      } as never,
      {
        where: {
          id: input.withdrawalId as never,
          status: { [Op.in as unknown as string]: [WithdrawalStatus.REQUESTED, WithdrawalStatus.REVIEWING] },
        } as never,
        transaction: txq,
      } as never,
    );
    if (affected === 0) return null;
    const row = await this.model.findByPk(input.withdrawalId, { transaction: txq } as never);
    return row;
  }

  async rejectWithdrawal(input: {
    withdrawalId: string;
    rejectedAt: Date;
    failureReason: string;
    tx: Tx;
  }): Promise<WithdrawalModel | null> {
    const txq = txOf(input.tx);
    const [affected] = await this.model.update(
      {
        status: WithdrawalStatus.REJECTED as never,
        failureReason: input.failureReason,
      } as never,
      {
        where: {
          id: input.withdrawalId as never,
          status: { [Op.in as unknown as string]: [WithdrawalStatus.REQUESTED, WithdrawalStatus.REVIEWING] },
        } as never,
        transaction: txq,
      } as never,
    );
    if (affected === 0) return null;
    const row = await this.model.findByPk(input.withdrawalId, { transaction: txq } as never);
    return row;
  }
}

// ---------------------------------------------------------------------------
// AiJobReviewRepo（ai_asset_job 审核推进；跨模块读经本端口）
// ---------------------------------------------------------------------------

export class SequelizeAiJobReviewRepo implements AiJobReviewRepo {
  constructor(private readonly model: typeof AiAssetJobModel) {}

  async lockJob(jobId: string, tx: Tx): Promise<AiAssetJobModel | null> {
    const txq = txOf(tx);
    return this.model.findByPk(jobId, { lock: 'FOR UPDATE', transaction: txq } as never);
  }

  async reviewJob(input: { jobId: string; targetStatus: number; completedAt: Date; tx: Tx }): Promise<AiAssetJobModel | null> {
    const txq = txOf(input.tx);
    const [affected] = await this.model.update(
      {
        status: input.targetStatus as never,
        completedAt: input.completedAt,
      } as never,
      {
        where: {
          id: input.jobId as never,
          // 仅 REVIEW_REQUIRED=6 可推进（防并发已终态）
          status: AiJobStatus.REVIEW_REQUIRED,
        } as never,
        transaction: txq,
      } as never,
    );
    if (affected === 0) return null;
    const row = await this.model.findByPk(input.jobId, { transaction: txq } as never);
    return row;
  }
}

// ---------------------------------------------------------------------------
// AdminUserRepo（user admin 视角只读；经 identity UserModel，不写）
// ---------------------------------------------------------------------------

export class SequelizeAdminUserRepo implements AdminUserRepo {
  constructor(private readonly model: typeof UserModel) {}

  async listUsers(input: {
    cursor: string | null;
    limit: number;
    userId?: string | undefined;
    username?: string | undefined;
    roleType?: number | undefined;
    status?: number | undefined;
    tx: Tx;
  }): Promise<{ items: UserModel[]; nextCursor: string | null }> {
    const txq = txOf(input.tx);
    const cur = parseCursor(input.cursor);

    // 筛选条件经 Op.and 桥接（unique symbol，TS2538 经 as unknown as string）
    const where: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};
    if (input.userId !== undefined) filters.id = input.userId;
    if (input.username !== undefined) filters.username = input.username;
    if (input.roleType !== undefined) filters.roleType = input.roleType;
    if (input.status !== undefined) filters.status = input.status;
    Object.assign(where, filters);

    if (cur !== null) {
      // 稳定游标：created_at < cur.createdAt OR (created_at = cur.createdAt AND id < cur.id)
      where[Op.and as unknown as string] = [
        { createdAt: { [Op.lt as unknown as string]: cur.createdAt } },
        { createdAt: cur.createdAt, id: { [Op.lt as unknown as string]: cur.id as never } },
      ];
    }

    const items = await this.model.findAll({
      where: where as never,
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: input.limit,
      transaction: txq,
    } as never);

    // noUncheckedIndexedAccess 防护（与 referral / coin-market 适配器同款写法）
    const last = items.length === input.limit ? items[items.length - 1] : undefined;
    const nextCursor = last !== undefined ? formatCursor(last) : null;
    return { items, nextCursor };
  }

  async findUserByPk(userId: string, tx: Tx): Promise<UserModel | null> {
    const txq = txOf(tx);
    return this.model.findByPk(userId, { transaction: txq } as never);
  }

  async findUserByUsername(username: string, tx: Tx): Promise<UserModel | null> {
    const txq = txOf(tx);
    return this.model.findOne({
      where: { username } as never,
      transaction: txq,
    } as never);
  }
}
