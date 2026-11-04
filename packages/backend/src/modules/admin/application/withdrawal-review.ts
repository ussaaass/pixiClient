/**
 * admin 模块用例：提现审批 / 驳回（POST /admin-api/v1/withdrawals/:id/approve
 * + POST /admin-api/v1/withdrawals/:id/reject；REQUESTED=1 / REVIEWING=2
 * → APPROVED=3 / REJECTED=6；双人复核 operated_by ≠ approved_by 服务端
 * 强制；同事务审计经 admin_audit_event append-only；出款经 payout
 * worker 闭环，登记决策点）。
 *
 * 领域所有者：admin 模块（withdrawal 行锁读 + UPDATE status /
 * approved_at；admin_audit_event 同事务 append-only 写；SDD §6.3
 * "所有分录 / outbox 同事务"约定；A.12 第 5 条不可变审计；
 * 数据库设计 SDD §5.6 withdrawal 9 态 DDL 权威 + U(approval_key)）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 withdrawal →
 * admin_audit_event，幂等先抢唯一约束）、§9 第 9 步（Admin 全量
 * 切换收口：withdrawals 工作区 → 审批 / 驳回端点 + 双人复核
 * 服务端强制 + 审计）；数据库设计 SDD §5.6（withdrawal
 * WithdrawalStatus 1~9 + approval_key U(approval_key) +
 * asset_operation 双人复核 CHECK ck_asset_operation_reviewer）。
 *
 * 用例语义（审批）：
 * - 行锁读 withdrawal（缺行 → AD_WITHDRAWAL_NOT_FOUND 404 语义）；
 * - 双人复核服务端强制：`operatedBy`（申请占款操作人）≠
 *   `approvedBy`（本 Admin 操作人）经用例层前置校验（同 admin
 *   操作 → 抛 AD_PERMISSION_DENIED 409 语义；DDL CHECK
 *   ck_asset_operation_reviewer 兜底，models/payments.ts
 *   asset_operation 双人复核约束）；
 * - 幂等重放：已 APPROVED=3 → 静默返回既有值 `inserted: false`
 *   （200，验收红线"审批幂等"）；
 * - 状态机前置校验：from ∈ {REQUESTED=1, REVIEWING=2} 经
 *   `canWithdrawalApprove` 纯函数（models/payments.ts WithdrawalStatus
 *   9 态 DDL 权威）；非可审批态 → 抛 AD_WITHDRAWAL_NOT_REVIEWABLE
 *   （409 语义）；
 * - 同事务写 admin_audit_event（request_key =
 *   `withdrawal:{id}:approve` 幂等兜底；snapshot 含 approvalKey +
 *   cashCents 摘要，不含收款账户明文，经 `validateAuditSnapshot`
 *   脱敏校验）；
 * - 影响行数 0 → 读回既有值（并发推进兜底）。
 *
 * 用例语义（驳回）：
 * - 行锁读 withdrawal（缺行 → AD_WITHDRAWAL_NOT_FOUND）；
 * - 幂等重放：已 REJECTED=6 → 静默返回既有值；
 * - 状态机前置校验：from ∈ {REQUESTED=1, REVIEWING=2} 经
 *   `canWithdrawalApprove`（驳回同审批前置）；
 * - `failureReason` 经路由层校验（minLength 1 / maxLength 500）；
 * - 同事务写 admin_audit_event（request_key = `withdrawal:{id}:reject`
 *   幂等兜底）。
 *
 * 错误码映射（AD → 触发条件）：
 * - `AD_WITHDRAWAL_NOT_FOUND`：withdrawal 行缺失（404 语义）。
 * - `AD_WITHDRAWAL_NOT_REVIEWABLE`：非 REQUESTED=1 / REVIEWING=2
 *   （409 语义，状态机前置校验失败）。
 * - `AD_PERMISSION_DENIED`：双人复核同 admin 操作 / failureReason
 *   缺失（409 语义）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 状态机影响行数 0
 *   （可重试，503 语义）。
 *
 * 登记决策点（Lead 确认）：
 * 1. 出款经 payout worker 闭环（APPROVED=3 → PAYING=4 → SUCCEEDED=5
 *    / FAILED=9），§6.3 worker 未建，本用例只推进 APPROVED=3 +
 *    审计，出账闭环归 §6.3 管线；
 * 2. 双人复核 operated_by 经 withdrawal 行读回（首版经
 *    created_by / operated_by 字段近似，登记决策点：Lead 确认
 *    operated_by 取值来源——经 withdrawal.asset_operation_id
 *    反查 asset_operation.operated_by_admin_user_id）；
 * 3. 驳回 REJECTED=6 后占款释放经 wallet ledger 扩展点登记
 *    （asset_hold 释放），§6.3 管线未建。
 */

import type { WithdrawalReviewRepo, AdminAuditEventRepo, Tx } from '../ports/admin-repository.js';
import { AdminDomainError, AD } from '../domain/errors.js';
import {
  AdminWithdrawalStatus9,
  canWithdrawalApprove,
} from '../domain/audit-rules.js';
import { toNullableIso } from '../domain/iso-utils.js';

/** 审批结果（wire DTO；status 数值常量 wire；时间戳十进制字符串 wire）。 */
export interface WithdrawalApprovedDto {
  withdrawalId: string;
  status: number;
  approvedAt: string | null;
  inserted: boolean;
}

/** 驳回结果（wire DTO；status 数值常量 wire）。 */
export interface WithdrawalRejectedDto {
  withdrawalId: string;
  status: number;
  failureReason: string;
  inserted: boolean;
}

export class WithdrawalReviewUseCase {
  constructor(
    private readonly withdrawalRepo: WithdrawalReviewRepo,
    private readonly auditRepo: AdminAuditEventRepo,
  ) {}

  /**
   * POST /admin-api/v1/withdrawals/:id/approve：提现审批
   * （REQUESTED=1 / REVIEWING=2 → APPROVED=3 + 同事务审计；
   * 双人复核 operated_by ≠ approved_by 服务端强制）。
   * 调用方（路由层）负责开事务 + Admin audience 鉴权 + 前置 role_type
   * 校验 + operated_by 读回（经 withdrawal.asset_operation_id 反查，
   * 登记决策点），传入 `tx`；`operatedBy` 经路由层解析后传入。
   */
  async approve(input: {
    withdrawalId: string;
    approvedBy: string;
    operatedBy: string | null;
    requestKey: string;
    snapshot: Record<string, unknown>;
    tx: Tx;
  }): Promise<WithdrawalApprovedDto> {
    // 1. 行锁读 withdrawal（缺行 → 领域错误 404 语义）
    const withdrawal = await this.withdrawalRepo.lockWithdrawal(input.withdrawalId, input.tx);
    if (withdrawal === null) {
      throw new AdminDomainError(AD.AD_WITHDRAWAL_NOT_FOUND, `提现申请不存在：${input.withdrawalId}`);
    }

    // 2. 双人复核服务端强制（operated_by ≠ approved_by；
    //    同 admin 操作 → AD_PERMISSION_DENIED 409 语义；
    //    DDL CHECK ck_asset_operation_reviewer 兜底）
    if (input.operatedBy !== null && input.operatedBy === input.approvedBy) {
      throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '双人复核：审批人不得同操作人。', {
        retryable: false,
      });
    }

    // 3. 幂等重放：已 APPROVED=3 → 静默返回既有值
    if (withdrawal.status === AdminWithdrawalStatus9.APPROVED) {
      return {
        withdrawalId: withdrawal.id,
        status: withdrawal.status,
        approvedAt: toNullableIso(withdrawal.approvedAt),
        inserted: false,
      };
    }

    // 4. 状态机前置校验（from ∈ {REQUESTED=1, REVIEWING=2}）
    if (!canWithdrawalApprove(withdrawal.status)) {
      throw new AdminDomainError(AD.AD_WITHDRAWAL_NOT_REVIEWABLE, `提现状态不可审批（status=${withdrawal.status}）。`, {
        retryable: false,
      });
    }

    // 5. 同事务推进 withdrawal 状态 + 审计 append-only
    const now = new Date();
    const result = await this.withdrawalRepo.approveWithdrawal({
      withdrawalId: withdrawal.id,
      approvedAt: now,
      tx: input.tx,
    });
    if (result === null) {
      const re = await this.withdrawalRepo.lockWithdrawal(input.withdrawalId, input.tx);
      if (re !== null && re.status === AdminWithdrawalStatus9.APPROVED) {
        return {
          withdrawalId: re.id,
          status: re.status,
          approvedAt: toNullableIso(re.approvedAt),
          inserted: false,
        };
      }
      throw new AdminDomainError(AD.STORAGE_UNAVAILABLE, '提现审批状态机转换失败（影响行数 0），请重试。', {
        retryable: true,
      });
    }

    await this.auditRepo.createAuditEvent({
      adminUserId: input.approvedBy,
      adminSessionKey: null,
      userId: withdrawal.userId,
      targetAdminUserId: null,
      assetOperationId: withdrawal.assetOperationId,
      withdrawalId: withdrawal.id,
      systemConfigId: null,
      gameConfigId: null,
      agentDomainId: null,
      referralBindingEventId: null,
      supportConversationId: null,
      coinMarketTradeId: null,
      requestKey: input.requestKey,
      actionCode: 'WITHDRAWAL_APPROVE',
      resultType: 1,
      reason: `Admin 审批提现 ${withdrawal.id}（双人复核 operated_by=${input.operatedBy ?? 'N/A'} ≠ approved_by=${input.approvedBy}）。`,
      snapshot: { ...input.snapshot, approvalKey: withdrawal.approvalKey, cashCents: withdrawal.cashCents },
      ipHashHex: '0'.repeat(64),
      tx: input.tx,
    });

    return {
      withdrawalId: result.id,
      status: result.status,
      approvedAt: toNullableIso(result.approvedAt),
      inserted: true,
    };
  }

  /**
   * POST /admin-api/v1/withdrawals/:id/reject：提现驳回
   * （REQUESTED=1 / REVIEWING=2 → REJECTED=6 + failure_reason 回填
   * + 同事务审计；幂等重放：已 REJECTED → 静默返回既有值）。
   */
  async reject(input: {
    withdrawalId: string;
    approvedBy: string;
    failureReason: string;
    requestKey: string;
    snapshot: Record<string, unknown>;
    tx: Tx;
  }): Promise<WithdrawalRejectedDto> {
    // 1. failureReason 前置校验（minLength 1，DDL STRING(500)）
    if (input.failureReason === '') {
      throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '驳回理由必填。', {
        retryable: false,
      });
    }

    // 2. 行锁读 withdrawal（缺行 → 领域错误 404 语义）
    const withdrawal = await this.withdrawalRepo.lockWithdrawal(input.withdrawalId, input.tx);
    if (withdrawal === null) {
      throw new AdminDomainError(AD.AD_WITHDRAWAL_NOT_FOUND, `提现申请不存在：${input.withdrawalId}`);
    }

    // 3. 幂等重放：已 REJECTED=6 → 静默返回既有值
    if (withdrawal.status === AdminWithdrawalStatus9.REJECTED) {
      return {
        withdrawalId: withdrawal.id,
        status: withdrawal.status,
        failureReason: withdrawal.failureReason ?? input.failureReason,
        inserted: false,
      };
    }

    // 4. 状态机前置校验（from ∈ {REQUESTED=1, REVIEWING=2}）
    if (!canWithdrawalApprove(withdrawal.status)) {
      throw new AdminDomainError(AD.AD_WITHDRAWAL_NOT_REVIEWABLE, `提现状态不可驳回（status=${withdrawal.status}）。`, {
        retryable: false,
      });
    }

    // 5. 同事务推进 withdrawal 状态 + 审计 append-only
    const now = new Date();
    const result = await this.withdrawalRepo.rejectWithdrawal({
      withdrawalId: withdrawal.id,
      rejectedAt: now,
      failureReason: input.failureReason,
      tx: input.tx,
    });
    if (result === null) {
      const re = await this.withdrawalRepo.lockWithdrawal(input.withdrawalId, input.tx);
      if (re !== null && re.status === AdminWithdrawalStatus9.REJECTED) {
        return {
          withdrawalId: re.id,
          status: re.status,
          failureReason: re.failureReason ?? input.failureReason,
          inserted: false,
        };
      }
      throw new AdminDomainError(AD.STORAGE_UNAVAILABLE, '提现驳回状态机转换失败（影响行数 0），请重试。', {
        retryable: true,
      });
    }

    await this.auditRepo.createAuditEvent({
      adminUserId: input.approvedBy,
      adminSessionKey: null,
      userId: withdrawal.userId,
      targetAdminUserId: null,
      assetOperationId: withdrawal.assetOperationId,
      withdrawalId: withdrawal.id,
      systemConfigId: null,
      gameConfigId: null,
      agentDomainId: null,
      referralBindingEventId: null,
      supportConversationId: null,
      coinMarketTradeId: null,
      requestKey: input.requestKey,
      actionCode: 'WITHDRAWAL_REJECT',
      resultType: 1,
      reason: input.failureReason,
      snapshot: { ...input.snapshot, approvalKey: withdrawal.approvalKey },
      ipHashHex: '0'.repeat(64),
      tx: input.tx,
    });

    return {
      withdrawalId: result.id,
      status: result.status,
      failureReason: result.failureReason ?? input.failureReason,
      inserted: true,
    };
  }
}
