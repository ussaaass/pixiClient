/**
 * ai-assets 模块用例：取消 AI 素材生成任务（POST /me/ai-assets/jobs/:id/cancel）。
 *
 * 领域所有者：ai-assets 模块（写 ai_asset_job status QUEUED=1 → CANCELLED=5）。
 * 对应 SDD 章节：后端实施 SDD §9 第 8 步；§4（状态机前置校验经
 * domain/job-rules.ts `canJobTransition`，幂等先抢行锁）；
 * 数据库设计 SDD §5.11（AiJobStatus CANCELLED=5 终态）。
 *
 * 用例语义：
 * - 锁读 job 行（SELECT ... FOR UPDATE；缺行 → JOB_NOT_FOUND 404 语义）；
 * - 状态机前置校验：`canJobTransition(status, CANCELLED=5)`，
 *   非 QUEUED=1 → JOB_NOT_CANCELLABLE 409 语义；
 * - QUEUED=1 → CANCELLED=5（幂等重放：已 CANCELLED → 静默返回既有值，
 *   `inserted: false`）；
 * - 不产生第二行。
 *
 * 错误码映射（AIAS → 触发条件）：
 * - `JOB_NOT_FOUND`：job 行缺失。
 * - `JOB_NOT_CANCELLABLE`：非 QUEUED=1 态。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 状态机影响行数 0（可重试）。
 */

import type { AiAssetJobRepo, Tx } from '../ports/ai-assets-repository.js';
import { AiAssetsDomainError, AIAS } from '../domain/errors.js';
import { AiJobStatus6, canJobTransition } from '../domain/job-rules.js';

export interface JobCancelInput {
  jobId: string;
  tx: Tx;
}

export interface JobCancelledDto {
  jobId: string;
  status: number; // CANCELLED=5
  replay: boolean; // true 表示幂等重放（已 CANCELLED 时静默返回）
}

export class JobCancelUseCase {
  constructor(private readonly jobRepo: AiAssetJobRepo) {}

  async run(input: JobCancelInput): Promise<JobCancelledDto> {
    const { jobId, tx } = input;

    // 1. 锁读 job 行
    const job = await this.jobRepo.lockJob(jobId, tx);
    if (job === null) {
      throw new AiAssetsDomainError(AIAS.JOB_NOT_FOUND, `job 不存在：${jobId}`);
    }

    // 2. 幂等重放：已 CANCELLED → 静默返回
    if (job.status === AiJobStatus6.CANCELLED) {
      return { jobId, status: job.status, replay: true };
    }

    // 3. 状态机前置校验
    if (!canJobTransition(job.status, AiJobStatus6.CANCELLED)) {
      throw new AiAssetsDomainError(AIAS.JOB_NOT_CANCELLABLE, `job 非 QUEUED 态，不可取消（status=${job.status}）。`);
    }

    // 4. 推进 CANCELLED=5（影响行数 0 → 并发冲突，可重试）
    const updated = await this.jobRepo.cancelJob({ jobId, tx });
    if (updated === null) {
      throw new AiAssetsDomainError(AIAS.STORAGE_UNAVAILABLE, '取消 job 并发冲突，请重试。', { retryable: true });
    }
    return { jobId, status: updated.status, replay: false };
  }
}
