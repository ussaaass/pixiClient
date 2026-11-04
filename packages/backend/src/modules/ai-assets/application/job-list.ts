/**
 * ai-assets 模块用例：列出用户 AI 素材生成任务（GET /me/ai-assets/jobs）。
 *
 * 领域所有者：ai-assets 模块（读 ai_asset_job；经 assetKey 归属筛选，
 * 首版无 user_id 列，登记决策点：0018 迁移补 created_by_user_id 列）。
 * 对应 SDD 章节：后端实施 SDD §9 第 8 步；§4（游标分页 50/页约定）。
 *
 * 用例语义：
 * - 按 `assetKey`（素材语义键）+ `createdAt` DESC + `id` DESC 稳定游标分页
 *   50/页；
 * - 首版登记决策点：`ai_asset_job` 表无 `created_by_user_id` 列（DDL 0017
 *   未设计），经 `assetKey` 做用户归属近似筛选（同一 assetKey 只应被一个
 *   用户创建，登记 0018 迁移补 `created_by_user_id` 决策点由 Lead 确认）。
 *
 * 错误码映射：无领域错误（纯读路径）；Sequelize 故障上抛。
 */

import type { AiAssetJobRepo, Tx } from '../ports/ai-assets-repository.js';

/** 单页条数上限（50/页，SDD §4 游标分页约定）。 */
export const JOB_PAGE_LIMIT = 50;

/** 单条 job DTO（wire 十进制字符串 ID）。 */
export interface JobItemDto {
  jobId: string;
  jobKey: string;
  assetKey: string;
  assetKind: number;
  providerCode: string;
  mainModelCode: string;
  apiMode: number;
  status: number;
  createdAt: string;
}

/** 列表响应（游标分页）。 */
export interface JobListDto {
  items: JobItemDto[];
  nextCursor: string | null;
}

export class JobListUseCase {
  constructor(private readonly jobRepo: AiAssetJobRepo) {}

  async run(input: { assetKey: string; cursor: string | null; limit: number; tx: Tx }): Promise<JobListDto> {
    const result = await this.jobRepo.listJobsByUser({
      assetKey: input.assetKey,
      cursor: input.cursor,
      limit: Math.min(input.limit, JOB_PAGE_LIMIT),
      tx: input.tx,
    });
    return {
      items: result.items.map((job) => ({
        jobId: job.id,
        jobKey: job.jobKey,
        assetKey: job.assetKey,
        assetKind: job.assetKind,
        providerCode: job.providerCode,
        mainModelCode: job.mainModelCode,
        apiMode: job.apiMode,
        status: job.status,
        createdAt: typeof job.createdAt === 'string' ? job.createdAt : job.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  }
}
