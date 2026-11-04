/**
 * ai-assets 模块用例：发布资源发布版本（POST /me/ai-assets/releases/:id/publish，
 * DRAFT=1 → PUBLISHED=3，published_at 回填；幂等重放：已 PUBLISHED → 静默返回）。
 *
 * 领域所有者：ai-assets 模块（写 asset_release status PUBLISHED=3 + published_at）。
 * 对应 SDD 章节：后端实施 SDD §9 第 8 步；§4（状态机前置校验经
 * domain/job-rules.ts `canReleaseTransition`，行锁内 UPDATE）；
 * 数据库设计 SDD §5.11（asset_release ReleaseStatus DRAFT=1→PUBLISHED=3，
 * published_at 回填，Admin 审核路径 REVIEW=2 登记 §9 第 9 步扩展点）。
 *
 * 用例语义：
 * - 锁读 release 行（SELECT ... FOR UPDATE；缺行 → RELEASE_NOT_FOUND 404）；
 * - 幂等重放：已 PUBLISHED=3 → 静默返回 `replay: true`；
 * - 状态机前置校验：`canReleaseTransition(status, PUBLISHED=3)`，
 *   非 DRAFT=1/REVIEW=2 → RELEASE_NOT_DRAFT 409 语义；
 * - 推进 PUBLISHED=3 + published_at = now（影响行数 0 → 并发冲突可重试）。
 */

import type { AssetReleaseRepo, Tx } from '../ports/ai-assets-repository.js';
import { AiAssetsDomainError, AIAS } from '../domain/errors.js';
import { ReleaseStatus4, canReleaseTransition } from '../domain/job-rules.js';

export interface ReleasePublishInput {
  releaseId: string;
  tx: Tx;
}

export interface ReleasePublishedDto {
  releaseId: string;
  status: number; // PUBLISHED=3
  publishedAt: string;
  replay: boolean;
}

export class ReleasePublishUseCase {
  constructor(private readonly releaseRepo: AssetReleaseRepo) {}

  async run(input: ReleasePublishInput): Promise<ReleasePublishedDto> {
    const { releaseId, tx } = input;

    // 1. 锁读 release 行
    const release = await this.releaseRepo.lockRelease(releaseId, tx);
    if (release === null) {
      throw new AiAssetsDomainError(AIAS.RELEASE_NOT_FOUND, `release 不存在：${releaseId}`);
    }

    // 2. 幂等重放：已 PUBLISHED → 静默返回
    if (release.status === ReleaseStatus4.PUBLISHED) {
      return {
        releaseId,
        status: release.status,
        publishedAt: release.publishedAt !== null ? toIso(release.publishedAt) : toIso(new Date()),
        replay: true,
      };
    }

    // 3. 状态机前置校验（DRAFT=1 或 REVIEW=2 → PUBLISHED=3 合法）
    if (!canReleaseTransition(release.status, ReleaseStatus4.PUBLISHED)) {
      throw new AiAssetsDomainError(AIAS.RELEASE_NOT_DRAFT, `release 非 DRAFT/REVIEW 态，不可发布（status=${release.status}）。`);
    }

    // 4. 推进 PUBLISHED=3 + published_at 回填
    const updated = await this.releaseRepo.publishRelease({
      releaseId,
      publishedAt: new Date(),
      tx,
    });
    if (updated === null) {
      throw new AiAssetsDomainError(AIAS.STORAGE_UNAVAILABLE, '发布 release 并发冲突，请重试。', { retryable: true });
    }
    return {
      releaseId,
      status: updated.status,
      publishedAt: toIso(new Date()),
      replay: false,
    };
  }
}

function toIso(d: Date | string): string {
  return typeof d === 'string' ? d : d.toISOString();
}
