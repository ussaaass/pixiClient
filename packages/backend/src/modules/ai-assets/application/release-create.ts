/**
 * ai-assets 模块用例：创建资源发布草稿（POST /me/ai-assets/releases，
 * 201 新创建 / 200 幂等重放；DRAFT=1 + U(release_key) 幂等；
 * manifestHash BINARY(32) 经 64 字符 hex 传入，本用例转 Buffer 落库）。
 *
 * 领域所有者：ai-assets 模块（写 asset_release DRAFT=1；不写
 * asset_release_item，清单项追加归发布时同事务，登记决策点）。
 * 对应 SDD 章节：后端实施 SDD §9 第 8 步；§4（幂等先抢唯一约束）；
 * 数据库设计 SDD §5.11（asset_release U(release_key) + manifest_hash
 * BINARY(32) + published_at NULL DRAFT 态）。
 *
 * 用例语义：
 * - U(release_key) 幂等兜底：命中 → 返回既有 release 行 `inserted: false`；
 * - manifestHashHex（64 字符）→ Buffer → BINARY(32) 落库；
 * - gameId NULL = 大厅公共资源；
 * - reviewNote 首版空字符串占位（登记决策点：Lead 确认 reviewNote 是否必填）。
 */

import type { AssetReleaseRepo, Tx } from '../ports/ai-assets-repository.js';
import { AiAssetsDomainError, AIAS, isDuplicateKeyError } from '../domain/errors.js';
import type { AssetReleaseModel } from '../../../infrastructure/database/models/assets.js';

export interface ReleaseCreateInput {
  releaseKey: string;
  gameId: string | null;
  assetId: string;
  manifestHashHex: string;
  reviewNote: string;
  tx: Tx;
}

export interface ReleaseCreatedDto {
  releaseId: string;
  releaseKey: string;
  status: number;
  createdAt: string;
  inserted: boolean;
}

export class ReleaseCreateUseCase {
  constructor(private readonly releaseRepo: AssetReleaseRepo) {}

  async run(input: ReleaseCreateInput): Promise<ReleaseCreatedDto> {
    let result: { inserted: boolean; release: AssetReleaseModel };
    try {
      result = await this.releaseRepo.createRelease({
        releaseKey: input.releaseKey,
        gameId: input.gameId,
        assetId: input.assetId,
        manifestHashHex: input.manifestHashHex,
        reviewNote: input.reviewNote,
        tx: input.tx,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // 幂等重放：读回既有 release 行
        const existing = await this.releaseRepo.lockRelease(input.releaseKey, input.tx).catch(() => null);
        if (existing === null) {
          throw new AiAssetsDomainError(AIAS.STORAGE_UNAVAILABLE, 'release 幂等重读失败，请重试。', { retryable: true });
        }
        return {
          releaseId: existing.id,
          releaseKey: existing.releaseKey,
          status: existing.status,
          createdAt: toIso(existing.createdAt),
          inserted: false,
        };
      }
      throw err;
    }

    return {
      releaseId: result.release.id,
      releaseKey: result.release.releaseKey,
      status: result.release.status,
      createdAt: toIso(result.release.createdAt),
      inserted: result.inserted,
    };
  }
}

function toIso(d: Date | string): string {
  return typeof d === 'string' ? d : d.toISOString();
}
