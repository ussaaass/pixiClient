/**
 * ai-assets 模块唯一公开入口（server / 测试 / 其他模块经本入口取用；
 * 禁止直接 import 本模块内部 application / adapters 文件）。
 *
 * 领域所有者：ai-assets 模块（models/assets.ts 为其唯一 model 定义）。
 * 对应 SDD 章节：后端实施 SDD §1（modules/ai-assets/public.ts 唯一入口）、
 * §9 第 8 步（AI 素材台账：asset/ai_asset_* 与发布，与现有
 * tools/asset-generation 台账对接）。
 */

export { createAiAssetsModule, type AiAssetsModule, type AiAssetsModuleDeps, type AiAssetsModuleConfig } from './assembly.js';

export {
  JobCreateUseCase,
  type JobCreateInput,
  type JobCreatedDto,
  JobCancelUseCase,
  type JobCancelInput,
  type JobCancelledDto,
  JobListUseCase,
  type JobItemDto,
  type JobListDto,
  JOB_PAGE_LIMIT,
  JobDetailUseCase,
  type JobDetailInput,
  type JobDetailDto,
  ReleaseCreateUseCase,
  type ReleaseCreateInput,
  type ReleaseCreatedDto,
  ReleasePublishUseCase,
  type ReleasePublishInput,
  type ReleasePublishedDto,
  ReleaseListUseCase,
  type ReleaseItemDto,
  type ReleaseListDto,
  RELEASE_PAGE_LIMIT,
} from './application/index.js';

export { AiAssetsDomainError, AIAS, isAiAssetsDomainError, isDuplicateKeyError, type AiAssetsErrorCode } from './domain/errors.js';

export {
  AiJobStatus6,
  ReleaseStatus4,
  AI_JOB_TRANSITIONS,
  RELEASE_TRANSITIONS,
  canJobTransition,
  canReleaseTransition,
  type AiJobStatus6Value,
  type ReleaseStatus4Value,
} from './domain/job-rules.js';

export type { AssetRepo, AiAssetJobRepo, AiAssetArtifactRepo, AssetReleaseRepo, Tx } from './ports/ai-assets-repository.js';
