/**
 * ai-assets 模块装配工厂（inject 全部 ports 的 AiAssetsModule，
 * 供 server 装配调用一次）。
 *
 * 领域所有者：ai-assets 模块（models/assets.ts 为其唯一 model 定义；
 * 本 factory 构造 4 个独立 Repo 类 + 7 个用例实例，不依赖 walletModule
 * —— 无资金操作，登记 §9 第 9 步 Admin 审核路径扩展点）。
 * 对应 SDD 章节：后端实施 SDD §1（装配工厂 `createAiAssetsModule({sequelize,
 * config})`）、§4（构造注入 ports，不用全局）、§9 第 8 步（AI 素材台账：
 * asset/ai_asset_* 与发布，与现有 tools/asset-generation 台账对接）。
 *
 * 装配模式（参考 `modules/referral/assembly.ts` + `modules/coin-market/assembly.ts`）：
 * - `sequelize`：Sequelize 实例（models/assets.ts 6 model 已注册）；
 * - **不依赖 walletModule**：无资金操作；
 * - `config`：首版无外部依赖（KMS key ref 经 configuration 模块注入，§9 第 7 步）。
 *
 * 未闭环登记：
 * - KMS 密钥注入 / 真实 OpenAI / Kling 网关回调推进 job RUNNING→SUCCEEDED/FAILED
 *   归 §6.3 outbox worker + §9 第 9 步 Admin 审核路径（本模块只写台账，
 *   不实际调外部 API）；
 * - `ai_asset_job` 表无 `created_by_user_id` 列（DDL 0017 未设计），
 *   列表端点经 `assetKey` 做用户归属近似筛选，登记 0018 迁移补列决策点；
 * - release 发布首版 DRAFT=1 → PUBLISHED=3 直推（不经 REVIEW=2），
 *   Admin 审核路径 REVIEW=2 归 §9 第 9 步登记。
 */

import type { Sequelize, Transaction } from 'sequelize';
import { AssetModel, AiAssetJobModel, AiAssetArtifactModel, AssetReleaseModel } from '../../infrastructure/database/models/assets.js';

import {
  SequelizeAssetRepo,
  SequelizeAiAssetJobRepo,
  SequelizeAiAssetArtifactRepo,
  SequelizeAssetReleaseRepo,
} from './adapters/sequelize-ai-assets.js';
import type { AssetRepo, AiAssetJobRepo, AiAssetArtifactRepo, AssetReleaseRepo, Tx } from './ports/ai-assets-repository.js';

import { JobCreateUseCase } from './application/job-create.js';
import { JobCancelUseCase } from './application/job-cancel.js';
import { JobListUseCase } from './application/job-list.js';
import { JobDetailUseCase } from './application/job-detail.js';
import { ReleaseCreateUseCase } from './application/release-create.js';
import { ReleasePublishUseCase } from './application/release-publish.js';
import { ReleaseListUseCase } from './application/release-list.js';

/** 装配配置（首版无外部依赖；KMS key ref 经 configuration 模块注入，§9 第 7 步）。 */
export interface AiAssetsModuleConfig {
  /** 占位，首版不读；KMS / 网关密钥注入归 §9 第 9 步。 */
  readonly _placeholder?: never;
}

/** 装配依赖（Sequelize 实例 + 配置；模型类在装配内取，参考 referral assembly）。 */
export interface AiAssetsModuleDeps {
  sequelize: Sequelize;
  config: AiAssetsModuleConfig;
}

/** 全部 ports + 用例实例的 AiAssetsModule（构造注入，不用全局，SDD §4）。 */
export interface AiAssetsModule {
  // ports（共享实现，供测试 / 其他模块 mock 时参考）
  assetRepo: AssetRepo;
  jobRepo: AiAssetJobRepo;
  artifactRepo: AiAssetArtifactRepo;
  releaseRepo: AssetReleaseRepo;

  // 用例实例（构造注入 ports，不用全局，SDD §4）
  jobCreate: JobCreateUseCase;
  jobCancel: JobCancelUseCase;
  jobList: JobListUseCase;
  jobDetail: JobDetailUseCase;
  releaseCreate: ReleaseCreateUseCase;
  releasePublish: ReleasePublishUseCase;
  releaseList: ReleaseListUseCase;

  /**
   * 在事务 scope 内构建同事务端口（§6.3 "所有分录/outbox 同事务"约定；
   * ai-assets 无 outbox，withTx 只透传 tx，供用例写 ai_asset_job +
   * ai_asset_artifact + asset_release 同事务落库）。
   */
  withTx<T>(scope: { transaction: Transaction | null }, fn: (tx: Tx) => T | Promise<T>): Promise<T>;
}

/**
 * 装配 ai-assets 模块（inject 全部 ports 的 AiAssetsModule，供 server 装配调用一次）。
 * 用法（apps/server bootstrap）：
 * ```ts
 * const aiAssetsModule = createAiAssetsModule({ sequelize, config });
 * ```
 */
export function createAiAssetsModule(deps: AiAssetsModuleDeps): AiAssetsModule {
  const { sequelize, config } = deps;

  // 构建 Sequelize 仓储实现（每表一类，不混类；4 model 类构造注入，
  // 不用全局，SDD §4；各 Repo 独立实现，供按角色取用）。
  const assetRepo = new SequelizeAssetRepo(AssetModel);
  const jobRepo = new SequelizeAiAssetJobRepo(AiAssetJobModel);
  const artifactRepo = new SequelizeAiAssetArtifactRepo(AiAssetArtifactModel);
  const releaseRepo = new SequelizeAssetReleaseRepo(AssetReleaseModel);

  // 用例实例（构造注入 ports，不用全局，SDD §4；各 Repo 独立类按角色传入）。
  const jobCreate = new JobCreateUseCase(jobRepo);
  const jobCancel = new JobCancelUseCase(jobRepo);
  const jobList = new JobListUseCase(jobRepo);
  const jobDetail = new JobDetailUseCase(jobRepo, artifactRepo);
  const releaseCreate = new ReleaseCreateUseCase(releaseRepo);
  const releasePublish = new ReleasePublishUseCase(releaseRepo);
  const releaseList = new ReleaseListUseCase(releaseRepo);

  const module: AiAssetsModule = {
    assetRepo,
    jobRepo,
    artifactRepo,
    releaseRepo,
    jobCreate,
    jobCancel,
    jobList,
    jobDetail,
    releaseCreate,
    releasePublish,
    releaseList,

    async withTx<T>(scope: { transaction: Transaction | null }, fn: (tx: Tx) => T | Promise<T>): Promise<T> {
      // ai-assets 无 outbox，withTx 只透传 tx（用例写 ai_asset_job +
      // ai_asset_artifact + asset_release 同事务落库，随事务提交 / 回滚）。
      const tx: Tx = { transaction: scope.transaction as Transaction | undefined };
      void sequelize;
      void config;
      return fn(tx);
    },
  };

  return module;
}
