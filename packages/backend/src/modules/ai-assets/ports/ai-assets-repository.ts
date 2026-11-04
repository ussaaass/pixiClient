/**
 * ai-assets 模块仓储端口（asset / ai_asset_job / ai_asset_artifact /
 * asset_release 4 表；models/assets.ts 为 model 定义；job 6 态 DDL 权威
 * 状态机 + release 4 态 DDL 权威状态机）。
 *
 * 领域所有者：ai-assets 模块（adapters/sequelize-ai-assets.ts 各 Repo 类
 * 实现各端口；asset_release_item / ai_asset_reference 不可变表经
 * model hooks 拦截 update/destroy，A.12 第 5 条）。
 * 对应 SDD 章节：后端实施 SDD §4（构造注入 ports，用例 / 适配器经端口
 * 落库；锁顺序 ai_asset_job → ai_asset_artifact → asset_release，幂等先抢
 * 唯一约束）、§9 第 8 步（AI 素材台账：asset/ai_asset_* 与发布，与现有
 * tools/asset-generation 台账对接）；数据库设计 SDD §5.10 / §5.11
 * （U(job_key) / U(content_hash, byte_size) / U(release_key) 幂等；
 * ai_asset_reference U(ai_asset_job_id, asset_id, reference_role) 不可变）。
 *
 * 约定（与 rooms / social / referral / coin-market 模块 ports 同款纪律）：
 * - 方法名经实体前缀区分（findJobByPk / lockJob / createJob / listJobsByUser
 *   / listArtifactsByJob / createArtifact / findReleaseByPk / lockRelease /
 *   createRelease / listReleasesByUser，各表 CRUD 语义独立，无重名冲突）；
 * - `Tx` 复用 wallet 模块 `Tx`（Sequelize 事务句柄鸭子类型），用例内所有
 *   写操作共享同一事务（回滚即整事务回滚）；
 * - 幂等兜底：`U(job_key)`（ai_asset_job）/ `U(content_hash, byte_size)`
 *   （asset）/ `U(release_key)`（asset_release）命中 → 返回既有行
 *   （`inserted: false`，不产生第二行，验收红线"台账幂等"）；
 * - 不可变表：`ai_asset_reference` 只 create（model hooks 拦截
 *   update/destroy），本端口不声明 update/destroy 方法。
 *
 * 状态机（DDL 权威，models/assets.ts）：
 * - job：QUEUED=1 → RUNNING=2 → {SUCCEEDED=3/FAILED=4/CANCELLED=5/
 *   REVIEW_REQUIRED=6}；REVIEW_REQUIRED=6 → SUCCEEDED=3 推进归 §9 第 9 步
 *   Admin 审核路径（登记扩展点）；首版玩家侧只覆盖 QUEUED=1 → CANCELLED=5。
 * - release：DRAFT=1 → REVIEW=2 → PUBLISHED=3 → RETIRED=4；首版覆盖
 *   DRAFT=1 → PUBLISHED=3（Admin 审核路径 REVIEW=2 登记扩展点）。
 */

import type {
  AssetModel,
  AiAssetJobModel,
  AiAssetArtifactModel,
  AssetReleaseModel,
} from '../../../infrastructure/database/models/assets.js';
import type { Tx } from '../../wallet/ports/wallet-repository.js';

export type { Tx };

// ---------------------------------------------------------------------------
// AssetRepo（asset，统一文件资产元数据；U(content_hash, byte_size) 幂等）
// ---------------------------------------------------------------------------

export interface AssetRepo {
  /**
   * 创建 asset 行（U(content_hash, byte_size) 幂等兜底：命中 → 返回既有行
   * `inserted: false`；contentHash BINARY(32) SHA-256 摘要，byteSize
   * BIGINT wire 十进制字符串）。
   * @param input.contentHashHex 内容 SHA-256 十六进制字符串（64 字符，
   *   路由层经 crypto.createHash('sha256').update(data).digest('hex') 计算）。
   */
  createAsset(input: {
    assetType: number;
    storageProvider: number;
    bucketName: string;
    objectKey: string;
    contentHashHex: string;
    mimeType: string;
    byteSize: string;
    width: number | null;
    height: number | null;
    durationMs: string | null;
    codec: string | null;
    visibility: number;
    tx: Tx;
  }): Promise<{ inserted: boolean; asset: AssetModel }>;

  /** 按 id 读 asset 行（无锁；缺失返回 null）。 */
  findAssetByPk(assetId: string, tx: Tx): Promise<AssetModel | null>;
}

// ---------------------------------------------------------------------------
// AiAssetJobRepo（ai_asset_job，素材任务台账；U(job_key) 幂等）
// ---------------------------------------------------------------------------

export interface AiAssetJobRepo {
  /**
   * 创建 job 行（QUEUED=1，U(job_key) 幂等兜底：命中 → 返回既有行
   * `inserted: false`；job_key CHAR(36) 经 crypto.randomUUID() 生成，
   * 路由层注入，不实际调外部 KMS / Kling 网关（登记 KMS 未闭环，
   * §9 第 9 步）；secretReference 只登记 key ref（不存实际密钥））。
   * @param input.secretRef KMS key ref（只登记，不存实际密钥，登记决策点：
   *   KMS 网关未闭环，首版经 tools/asset-generation 台账对接）。
   */
  createJob(input: {
    jobKey: string;
    assetKey: string;
    assetKind: number;
    providerCode: string;
    mainModelCode: string;
    imageModelCode: string;
    apiMode: number;
    prompt: string;
    promptHashHex: string;
    styleVersion: string;
    generationConfig: Record<string, unknown>;
    secretRef: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; job: AiAssetJobModel }>;

  /** 按 id 行锁读 job 行（取消 / 详情前置；status + 状态机经用例层校验）。 */
  lockJob(jobId: string, tx: Tx): Promise<AiAssetJobModel | null>;

  /**
   * 列出用户 job（按 createdAt + id 游标分页 50/页；首版无 user_id 列，
   * 经 assetKey 归属校验，登记决策点：Lead 确认是否需 0018 迁移补
   * created_by_user_id 列）。
   * @param input.cursor 稳定游标 `{createdAt ISO}~{id}`；null 读首页。
   */
  listJobsByUser(input: {
    assetKey: string;
    cursor: string | null;
    limit: number;
    tx: Tx;
  }): Promise<{ items: AiAssetJobModel[]; nextCursor: string | null }>;

  /**
   * 取消 job（QUEUED=1 → CANCELLED=5；幂等重放：已 CANCELLED → 静默
   * 返回既有值；非 QUEUED → 用例层前置校验抛 JOB_NOT_CANCELLABLE）。
   * @returns 更新后的行（影响行数 0 → null，由用例层映射 JOB_NOT_CANCELLABLE）。
   */
  cancelJob(input: { jobId: string; tx: Tx }): Promise<AiAssetJobModel | null>;
}

// ---------------------------------------------------------------------------
// AiAssetArtifactRepo（ai_asset_artifact，生成产物；U(asset_id) 一资产一产物行）
// ---------------------------------------------------------------------------

export interface AiAssetArtifactRepo {
  /**
   * 创建 artifact 行（GENERATED=1，U(asset_id) 幂等兜底：命中 → 返回
   * 既有行 `inserted: false`；licenseSnapshot 记录生成条款及引用素材来源）。
   */
  createArtifact(input: {
    aiAssetJobId: string;
    assetId: string;
    artifactType: number;
    licenseSnapshot: Record<string, unknown>;
    reviewNote: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; artifact: AiAssetArtifactModel }>;

  /** 按 jobId 列出 artifact 行（详情端点用；只读无锁）。 */
  listArtifactsByJob(jobId: string, tx: Tx): Promise<AiAssetArtifactModel[]>;
}

// ---------------------------------------------------------------------------
// AssetReleaseRepo（asset_release，资源发布版本；U(release_key) 幂等）
// ---------------------------------------------------------------------------

export interface AssetReleaseRepo {
  /**
   * 创建 release 行（DRAFT=1，U(release_key) 幂等兜底：命中 → 返回既有行
   * `inserted: false`；manifestHash BINARY(32) 资源清单哈希；reviewNote
   * 首版空字符串占位（登记决策点：Lead 确认 reviewNote 是否必填））。
   * @param input.manifestHashHex 资源清单 SHA-256 十六进制字符串（64 字符）。
   */
  createRelease(input: {
    releaseKey: string;
    gameId: string | null;
    assetId: string;
    manifestHashHex: string;
    reviewNote: string;
    tx: Tx;
  }): Promise<{ inserted: boolean; release: AssetReleaseModel }>;

  /** 按 id 行锁读 release 行（发布前置；status + 状态机经用例层校验）。 */
  lockRelease(releaseId: string, tx: Tx): Promise<AssetReleaseModel | null>;

  /**
   * 列出 release（按 createdAt + id 游标分页 50/页；首版无 user_id 列，
   * 经 gameId 筛选（null = 大厅公共资源），登记决策点）。
   * @param input.cursor 稳定游标 `{createdAt ISO}~{id}`；null 读首页。
   */
  listReleases(input: {
    gameId: string | null;
    cursor: string | null;
    limit: number;
    tx: Tx;
  }): Promise<{ items: AssetReleaseModel[]; nextCursor: string | null }>;

  /**
   * 发布 release（DRAFT=1 → PUBLISHED=3；published_at 回填；幂等重放：
   * 已 PUBLISHED → 静默返回既有值；非 DRAFT → 用例层前置校验抛
   * RELEASE_NOT_DRAFT）。
   * @returns 更新后的行（影响行数 0 → null，由用例层映射 RELEASE_NOT_DRAFT）。
   */
  publishRelease(input: { releaseId: string; publishedAt: Date; tx: Tx }): Promise<AssetReleaseModel | null>;
}
