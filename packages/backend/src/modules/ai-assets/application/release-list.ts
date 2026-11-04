/**
 * ai-assets 模块用例：列出资源发布版本（GET /me/ai-assets/releases）。
 *
 * 领域所有者：ai-assets 模块（读 asset_release；经 gameId 筛选，
 * null = 大厅公共资源；首版无 user_id 列，登记决策点）。
 * 对应 SDD 章节：后端实施 SDD §9 第 8 步；§4（游标分页 50/页约定）。
 *
 * 用例语义：
 * - 按 `gameId`（null = 大厅公共资源）+ `createdAt` DESC + `id` DESC
 *   稳定游标分页 50/页；
 * - wire DTO：releaseId/releaseKey/gameId/status/publishedAt/createdAt
 *   十进制字符串 ID + 状态常量。
 */

import type { AssetReleaseRepo, Tx } from '../ports/ai-assets-repository.js';

/** 单页条数上限（50/页，SDD §4 游标分页约定）。 */
export const RELEASE_PAGE_LIMIT = 50;

export interface ReleaseItemDto {
  releaseId: string;
  releaseKey: string;
  gameId: string | null;
  status: number;
  publishedAt: string | null;
  createdAt: string;
}

export interface ReleaseListDto {
  items: ReleaseItemDto[];
  nextCursor: string | null;
}

export class ReleaseListUseCase {
  constructor(private readonly releaseRepo: AssetReleaseRepo) {}

  async run(input: { gameId: string | null; cursor: string | null; limit: number; tx: Tx }): Promise<ReleaseListDto> {
    const result = await this.releaseRepo.listReleases({
      gameId: input.gameId,
      cursor: input.cursor,
      limit: Math.min(input.limit, RELEASE_PAGE_LIMIT),
      tx: input.tx,
    });
    return {
      items: result.items.map((r) => ({
        releaseId: r.id,
        releaseKey: r.releaseKey,
        gameId: r.gameId,
        status: r.status,
        publishedAt: r.publishedAt === null ? null : toIso(r.publishedAt),
        createdAt: toIso(r.createdAt),
      })),
      nextCursor: result.nextCursor,
    };
  }
}

function toIso(d: Date | string): string {
  return typeof d === 'string' ? d : d.toISOString();
}
