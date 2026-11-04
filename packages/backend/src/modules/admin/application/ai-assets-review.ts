/**
 * admin 模块用例：AI 素材审核推进（POST /admin-api/v1/ai-assets/jobs/:id/review，
 * REVIEW_REQUIRED=6 → SUCCEEDED=3（通过）/ FAILED=4（驳回），同事务
 * completed_at 回填 + 审计；asset_operation 出账经生成台账对接，
 * 登记 KMS 未闭环）。
 *
 * 领域所有者：admin 模块（ai_asset_job 行锁读 + UPDATE status /
 * completed_at；admin_audit_event 同事务 append-only 写；SDD §6.3
 * "所有分录 / outbox 同事务"约定；A.12 第 5 条不可变审计）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 ai_asset_job →
 * admin_audit_event）、§9 第 8 步（AI 素材台账：job 审核推进
 * REVIEW_REQUIRED=6 → SUCCEEDED=3 / FAILED=4，Admin 审核路径
 * 归 §9 第 9 步闭环——本用例即该闭环端点）；数据库设计 SDD §5.10
 * （ai_asset_job 6 态 DDL 权威 + U(job_key) + cost_micro_usd）。
 *
 * 用例语义：
 * - 行锁读 job（缺行 → AD_JOB_NOT_FOUND 404 语义）；
 * - 幂等重放：已 SUCCEEDED=3 / FAILED=4 → 静默返回既有值
 *   `inserted: false`（200，验收红线"审核幂等"）；
 * - 状态机前置校验：REVIEW_REQUIRED=6 → SUCCEEDED=3 / FAILED=4 经
 *   `canAiJobReview` 纯函数（models/assets.ts AiJobStatus 6 态 DDL
 *   权威）；非 REVIEW_REQUIRED → 抛 AD_JOB_NOT_REVIEW（409 语义）；
 * - `decision` SUCCEEDED=3 / FAILED=4 经路由层传入（防传参错位，
 *   纯函数 `aiJobReviewTargetStatus` 映射）；
 * - 同事务写 admin_audit_event（request_key = `ai-asset:{jobId}:review:{decision}`
 *   幂等兜底；snapshot 经 `validateAuditSnapshot` 脱敏校验）；
 * - 影响行数 0 → 读回既有值（并发推进兜底）；读回非终态 →
 *   STORAGE_UNAVAILABLE（可重试）。
 *
 * 错误码映射（AD → 触发条件）：
 * - `AD_JOB_NOT_FOUND`：ai_asset_job 行缺失（404 语义）。
 * - `AD_JOB_NOT_REVIEW`：非 REVIEW_REQUIRED=6，不可审核（409 语义）。
 * - `AD_PERMISSION_DENIED`：decision 非法（非 3/4，409 语义）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 状态机影响行数 0
 *   （可重试，503 语义）。
 *
 * 登记决策点（Lead 确认）：
 * 1. costMicroUsd 回填经生成台账对接（tools/asset-generation），
 *    KMS 密钥设施未闭环，首版审核只推进状态 + completed_at + 审计，
 *    费用回填归 §9 第 9 步后续运维闭环；
 * 2. 审核通过（SUCCEEDED）后 ai_asset_artifact 行创建经
 *    ai-assets 模块扩展点登记（U(asset_id) 一资产一产物行），
 *    本用例不直接写 artifact。
 */

import type { AiJobReviewRepo, AdminAuditEventRepo, Tx } from '../ports/admin-repository.js';
import { AdminDomainError, AD } from '../domain/errors.js';
import {
  AI_JOB_REVIEW_FROM,
  AI_JOB_REVIEW_TO_SUCCEEDED,
  AI_JOB_REVIEW_TO_FAILED,
} from '../domain/audit-rules.js';

/** 审核结果（wire DTO；status 数值常量 wire；时间戳十进制字符串 wire）。 */
export interface AiJobReviewedDto {
  jobId: string;
  status: number;
  completedAt: string | null;
  inserted: boolean;
}

/** 审核目标状态映射（decision 1=通过 → SUCCEEDED=3；2=驳回 → FAILED=4；
 * 防路由层传参错位，纯函数校验）。 */
function aiJobReviewTargetStatus(decision: number): number {
  if (decision === 1) return AI_JOB_REVIEW_TO_SUCCEEDED;
  if (decision === 2) return AI_JOB_REVIEW_TO_FAILED;
  throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '审核结果码非法（须 1=通过 / 2=驳回）。', {
    retryable: false,
  });
}

export class AiAssetsReviewUseCase {
  constructor(
    private readonly jobRepo: AiJobReviewRepo,
    private readonly auditRepo: AdminAuditEventRepo,
  ) {}

  /**
   * POST /admin-api/v1/ai-assets/jobs/:id/review：AI 素材审核推进
   * （REVIEW_REQUIRED=6 → SUCCEEDED=3 / FAILED=4 + 同事务审计）。
   * 调用方（路由层）负责开事务 + Admin audience 鉴权 + 前置 role_type
   * 校验，传入 `tx`。
   */
  async run(input: {
    jobId: string;
    adminUserId: string;
    decision: 1 | 2;
    requestKey: string;
    snapshot: Record<string, unknown>;
    tx: Tx;
  }): Promise<AiJobReviewedDto> {
    const targetStatus = aiJobReviewTargetStatus(input.decision);

    // 1. 行锁读 job（缺行 → 领域错误 404 语义）
    const job = await this.jobRepo.lockJob(input.jobId, input.tx);
    if (job === null) {
      throw new AdminDomainError(AD.AD_JOB_NOT_FOUND, `AI 素材任务不存在：${input.jobId}`);
    }

    // 2. 幂等重放：已 SUCCEEDED=3 / FAILED=4 → 静默返回既有值（终态）
    if (job.status === AI_JOB_REVIEW_TO_SUCCEEDED || job.status === AI_JOB_REVIEW_TO_FAILED) {
      return {
        jobId: job.id,
        status: job.status,
        completedAt:
          job.completedAt === null
            ? null
            : typeof job.completedAt === 'string'
              ? job.completedAt
              : job.completedAt.toISOString(),
        inserted: false,
      };
    }

    // 3. 状态机前置校验（from = REVIEW_REQUIRED=6）
    if (job.status !== AI_JOB_REVIEW_FROM) {
      throw new AdminDomainError(AD.AD_JOB_NOT_REVIEW, `任务状态非 REVIEW_REQUIRED，不可审核（status=${job.status}）。`, {
        retryable: false,
      });
    }

    // 4. 同事务推进 job 状态 + 审计 append-only
    const now = new Date();
    const result = await this.jobRepo.reviewJob({
      jobId: job.id,
      targetStatus,
      completedAt: now,
      tx: input.tx,
    });
    if (result === null) {
      // 影响行数 0 = 并发推进 → 读回既有值（幂等兜底）
      const re = await this.jobRepo.lockJob(input.jobId, input.tx);
      if (re !== null && (re.status === AI_JOB_REVIEW_TO_SUCCEEDED || re.status === AI_JOB_REVIEW_TO_FAILED)) {
        return {
          jobId: re.id,
          status: re.status,
          completedAt:
            re.completedAt === null
              ? null
              : typeof re.completedAt === 'string'
                ? re.completedAt
                : re.completedAt.toISOString(),
          inserted: false,
        };
      }
      throw new AdminDomainError(AD.STORAGE_UNAVAILABLE, 'AI 素材审核状态机转换失败（影响行数 0），请重试。', {
        retryable: true,
      });
    }

    // 5. 同事务写审计（append-only；request_key 幂等兜底）
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
      supportConversationId: null,
      coinMarketTradeId: null,
      requestKey: input.requestKey,
      actionCode: input.decision === 1 ? 'AI_ASSET_APPROVE' : 'AI_ASSET_REJECT',
      resultType: 1,
      reason: input.decision === 1 ? 'Admin 审核通过 AI 素材任务。' : 'Admin 驳回 AI 素材任务。',
      snapshot: input.snapshot,
      ipHashHex: '0'.repeat(64),
      tx: input.tx,
    });

    return {
      jobId: result.id,
      status: result.status,
      completedAt:
        result.completedAt === null
          ? null
          : typeof result.completedAt === 'string'
            ? result.completedAt
            : result.completedAt.toISOString(),
      inserted: true,
    };
  }
}
