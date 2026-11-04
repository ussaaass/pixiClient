/**
 * ai-assets 模块用例：AI 素材生成任务详情（GET /me/ai-assets/jobs/:id）。
 *
 * 领域所有者：ai-assets 模块（读 ai_asset_job + ai_asset_artifact；
 * 不可变表 ai_asset_reference 只读登记流水）。
 * 对应 SDD 章节：后端实施 SDD §9 第 8 步；§4（读路径无锁，纯投影）。
 *
 * 用例语义：
 * - 按 jobId 读 job 行（缺行 → JOB_NOT_FOUND 404 语义）；
 * - 按 jobId 读 artifact 列表（ai_asset_artifact，一资产一产物行）；
 * - wire DTO：job 全量可写字段 + artifact 列表（assetId/artifactType/status/
 *   reviewNote 十进制字符串 ID + 状态常量）。
 */

import type { AiAssetJobRepo, AiAssetArtifactRepo, Tx } from '../ports/ai-assets-repository.js';
import { AiAssetsDomainError, AIAS } from '../domain/errors.js';

export interface JobDetailInput {
  jobId: string;
  tx: Tx;
}

export interface JobDetailDto {
  jobId: string;
  jobKey: string;
  assetKey: string;
  assetKind: number;
  providerCode: string;
  mainModelCode: string;
  imageModelCode: string;
  apiMode: number;
  styleVersion: string;
  status: number;
  costMicroUsd: string | null;
  attempts: number;
  completedAt: string | null;
  artifacts: {
    artifactId: string;
    assetId: string;
    artifactType: number;
    status: number;
    reviewNote: string | null;
  }[];
}

export class JobDetailUseCase {
  constructor(
    private readonly jobRepo: AiAssetJobRepo,
    private readonly artifactRepo: AiAssetArtifactRepo,
  ) {}

  async run(input: JobDetailInput): Promise<JobDetailDto> {
    const { jobId, tx } = input;

    // 1. 读 job 行（无锁；缺行 → 404）
    const job = await this.jobRepo.lockJob(jobId, tx);
    if (job === null) {
      throw new AiAssetsDomainError(AIAS.JOB_NOT_FOUND, `job 不存在：${jobId}`);
    }

    // 2. 读 artifact 列表
    const artifacts = await this.artifactRepo.listArtifactsByJob(jobId, tx);

    return {
      jobId: job.id,
      jobKey: job.jobKey,
      assetKey: job.assetKey,
      assetKind: job.assetKind,
      providerCode: job.providerCode,
      mainModelCode: job.mainModelCode,
      imageModelCode: job.imageModelCode,
      apiMode: job.apiMode,
      styleVersion: job.styleVersion,
      status: job.status,
      costMicroUsd: job.costMicroUsd,
      attempts: job.attempts,
      completedAt: job.completedAt === null ? null : toIso(job.completedAt),
      artifacts: artifacts.map((a) => ({
        artifactId: a.id,
        assetId: a.assetId,
        artifactType: a.artifactType,
        status: a.status,
        reviewNote: a.reviewNote,
      })),
    };
  }
}

function toIso(d: Date | string): string {
  return typeof d === 'string' ? d : d.toISOString();
}
