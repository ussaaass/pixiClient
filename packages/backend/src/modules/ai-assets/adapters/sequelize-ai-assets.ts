/**
 * ai-assets 模块仓储适配器（Sequelize 实现各 Repo 端口；
 * models/assets.ts 6 model 的唯一写入点；每表一类，实体前缀命名）。
 *
 * 领域所有者：ai-assets 模块（models/assets.ts 为其唯一 model 定义；
 * 各表行锁/幂等/状态机转换全在此层落库，领域规则经
 * domain/job-rules.ts 校验）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 ai_asset_job →
 * ai_asset_artifact → asset_release，幂等先抢唯一约束）、
 * §9 第 8 步（AI 素材台账：asset/ai_asset_* 与发布）；
 * 数据库设计 SDD §5.10 / §5.11（U(job_key)/U(content_hash,
 * byte_size)/U(release_key) 幂等；ai_asset_reference 不可变）。
 *
 * 行锁与并发约定（与 rooms / social / referral / coin-market 适配器同款纪律）：
 * - `lock: 'FOR UPDATE'` 字符串字面量写法（InnoDB 行锁，§4 锁顺序）；
 * - 不可变表 `ai_asset_reference` 只 create，model hooks 拦截
 *   update/destroy（_shared.ts A.12 第 5 条）；
 * - 唯一约束幂等兜底：`U(job_key)`（ai_asset_job）/
 *   `U(content_hash, byte_size)`（asset）/ `U(release_key)`（asset_release）
 *   命中 → 读回既有行（`inserted: false`，不产生第二行，验收红线"台账幂等"）；
 * - `as never` 桥接（Sequelize 6 严格模式下 options 对象 +
 *   `exactOptionalPropertyTypes` 同款写法，rooms 适配器先例）。
 *
 * 结构约定（每表一类，不混类）：
 * - `SequelizeAssetRepo`（asset 表）
 * - `SequelizeAiAssetJobRepo`（ai_asset_job 表）
 * - `SequelizeAiAssetArtifactRepo`（ai_asset_artifact 表）
 * - `SequelizeAssetReleaseRepo`（asset_release 表）
 * 共享 `txOf` 辅助函数 + 各 Repo 独立类，与 rooms / coin-market 模块同款。
 */

import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import type {
  AssetModel,
  AiAssetJobModel,
  AiAssetArtifactModel,
  AssetReleaseModel,
} from '../../../infrastructure/database/models/assets.js';
import { AssetStatus, AiJobStatus, ReleaseStatus, ArtifactStatus } from '../../../infrastructure/database/models/assets.js';
import type { AssetRepo, AiAssetJobRepo, AiAssetArtifactRepo, AssetReleaseRepo, Tx } from '../ports/ai-assets-repository.js';
import { isDuplicateKeyError } from '../domain/errors.js';

/** 取事务（Sequelize Transaction 鸭子类型；与 rooms 适配器同款约定）。
 * 返回 `Transaction | null`（exactOptionalPropertyTypes 下 undefined 不可赋给
 * null 槽，统一 null 化；options 经 `as never` 整体桥接后直传）。 */
function txOf(tx: Tx): Transaction | null {
  return (tx.transaction as Transaction | undefined) ?? null;
}

/** hex(64) → Buffer(32)（BINARY(32) 落库用）。 */
function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

/** 稳定游标解析 `{createdAt ISO}~{id}`。 */
function parseCursor(cursor: string | null): { createdAt: string; id: string } | null {
  if (cursor === null) return null;
  const idx = cursor.lastIndexOf('~');
  if (idx <= 0) return null;
  return { createdAt: cursor.slice(0, idx), id: cursor.slice(idx + 1) };
}

function formatCursor(item: { createdAt: Date | string; id: string }): string {
  const iso = typeof item.createdAt === 'string' ? item.createdAt : item.createdAt.toISOString();
  return `${iso}~${item.id}`;
}

// ---------------------------------------------------------------------------
// AssetRepo（asset；U(content_hash, byte_size) 幂等）
// ---------------------------------------------------------------------------

export class SequelizeAssetRepo implements AssetRepo {
  constructor(private readonly model: typeof AssetModel) {}

  async createAsset(input: {
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
  }): Promise<{ inserted: boolean; asset: AssetModel }> {
    const txq = txOf(input.tx);
    const contentHash = hexToBuffer(input.contentHashHex);
    try {
      const asset = await this.model.create(
        {
          status: AssetStatus.STORED,
          assetType: input.assetType,
          storageProvider: input.storageProvider,
          bucketName: input.bucketName,
          objectKey: input.objectKey,
          contentHash,
          mimeType: input.mimeType,
          byteSize: input.byteSize as never,
          width: input.width,
          height: input.height,
          durationMs: input.durationMs as never,
          codec: input.codec,
          visibility: input.visibility,
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, asset };
    } catch (err) {
      // U(content_hash, byte_size) 幂等兜底
      const isDup = isDuplicateKeyError(err);
      if (isDup) {
        const existing = await this.model.findOne({
          where: {
            contentHash,
            byteSize: input.byteSize as never,
          } as never,
          transaction: txq,
        } as never);
        if (existing !== null) {
          return { inserted: false, asset: existing };
        }
      }
      throw err;
    }
  }

  async findAssetByPk(assetId: string, tx: Tx): Promise<AssetModel | null> {
    const txq = txOf(tx);
    return this.model.findByPk(assetId, { transaction: txq } as never);
  }
}

// ---------------------------------------------------------------------------
// AiAssetJobRepo（ai_asset_job；U(job_key) 幂等）
// ---------------------------------------------------------------------------

export class SequelizeAiAssetJobRepo implements AiAssetJobRepo {
  constructor(private readonly model: typeof AiAssetJobModel) {}

  async createJob(input: {
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
  }): Promise<{ inserted: boolean; job: AiAssetJobModel }> {
    const txq = txOf(input.tx);
    const promptHash = hexToBuffer(input.promptHashHex);
    try {
      const job = await this.model.create(
        {
          status: AiJobStatus.QUEUED,
          jobKey: input.jobKey,
          assetKey: input.assetKey,
          assetKind: input.assetKind,
          providerCode: input.providerCode,
          mainModelCode: input.mainModelCode,
          imageModelCode: input.imageModelCode,
          apiMode: input.apiMode,
          prompt: input.prompt,
          promptHash,
          styleVersion: input.styleVersion,
          generationConfig: input.generationConfig,
          providerRequestKey: null,
          usageSnapshot: null,
          costMicroUsd: null,
          attempts: 0,
          completedAt: null,
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, job };
    } catch (err) {
      const isDup = isDuplicateKeyError(err);
      if (isDup) {
        const existing = await this.model.findOne({
          where: { jobKey: input.jobKey } as never,
          transaction: txq,
        } as never);
        if (existing !== null) {
          return { inserted: false, job: existing };
        }
      }
      throw err;
    }
  }

  async lockJob(jobId: string, tx: Tx): Promise<AiAssetJobModel | null> {
    const txq = txOf(tx);
    return this.model.findByPk(jobId, { lock: 'FOR UPDATE', transaction: txq } as never);
  }

  async listJobsByUser(input: {
    assetKey: string;
    cursor: string | null;
    limit: number;
    tx: Tx;
  }): Promise<{ items: AiAssetJobModel[]; nextCursor: string | null }> {
    const txq = txOf(input.tx);
    const where: Record<string, unknown> = {
      assetKey: input.assetKey as never,
    };
    const cur = parseCursor(input.cursor);
    if (cur !== null) {
      where[Op.and as unknown as string] = [
        { createdAt: { [Op.lt as unknown as string]: cur.createdAt } },
        { createdAt: cur.createdAt, id: { [Op.lt as unknown as string]: cur.id as never } },
      ];
    }
    const items = await this.model.findAll({
      where: where as never,
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: input.limit,
      transaction: txq,
    } as never);
    const last = items[items.length - 1];
    const nextCursor = items.length === input.limit && last !== undefined ? formatCursor(last) : null;
    return { items, nextCursor };
  }

  async cancelJob(input: { jobId: string; tx: Tx }): Promise<AiAssetJobModel | null> {
    const txq = txOf(input.tx);
    const [affected] = await this.model.update(
      { status: AiJobStatus.CANCELLED } as never,
      {
        where: { id: input.jobId as never, status: AiJobStatus.QUEUED } as never,
        transaction: txq,
      } as never,
    );
    if (affected === 0) return null;
    return this.model.findByPk(input.jobId, { transaction: txq } as never);
  }
}

// ---------------------------------------------------------------------------
// AiAssetArtifactRepo（ai_asset_artifact；U(asset_id) 一资产一产物行）
// ---------------------------------------------------------------------------

export class SequelizeAiAssetArtifactRepo implements AiAssetArtifactRepo {
  constructor(private readonly model: typeof AiAssetArtifactModel) {}

  async createArtifact(input: {
    aiAssetJobId: string;
    assetId: string;
    artifactType: number;
    licenseSnapshot: Record<string, unknown>;
    reviewNote: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; artifact: AiAssetArtifactModel }> {
    const txq = txOf(input.tx);
    try {
      const artifact = await this.model.create(
        {
          status: ArtifactStatus.GENERATED,
          aiAssetJobId: input.aiAssetJobId as never,
          assetId: input.assetId as never,
          artifactType: input.artifactType,
          licenseSnapshot: input.licenseSnapshot,
          reviewNote: input.reviewNote,
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, artifact };
    } catch (err) {
      const isDup = isDuplicateKeyError(err);
      if (isDup) {
        const existing = await this.model.findOne({
          where: { assetId: input.assetId as never } as never,
          transaction: txq,
        } as never);
        if (existing !== null) {
          return { inserted: false, artifact: existing };
        }
      }
      throw err;
    }
  }

  async listArtifactsByJob(jobId: string, tx: Tx): Promise<AiAssetArtifactModel[]> {
    const txq = txOf(tx);
    return this.model.findAll({
      where: { aiAssetJobId: jobId as never } as never,
      transaction: txq,
    } as never);
  }
}

// ---------------------------------------------------------------------------
// AssetReleaseRepo（asset_release；U(release_key) 幂等）
// ---------------------------------------------------------------------------

export class SequelizeAssetReleaseRepo implements AssetReleaseRepo {
  constructor(private readonly model: typeof AssetReleaseModel) {}

  async createRelease(input: {
    releaseKey: string;
    gameId: string | null;
    assetId: string;
    manifestHashHex: string;
    reviewNote: string;
    tx: Tx;
  }): Promise<{ inserted: boolean; release: AssetReleaseModel }> {
    const txq = txOf(input.tx);
    const manifestHash = hexToBuffer(input.manifestHashHex);
    try {
      const release = await this.model.create(
        {
          status: ReleaseStatus.DRAFT,
          gameId: input.gameId as never,
          releaseKey: input.releaseKey,
          assetId: input.assetId as never,
          manifestHash,
          publishedAt: null,
          reviewNote: input.reviewNote,
        } as never,
        { transaction: txq } as never,
      );
      return { inserted: true, release };
    } catch (err) {
      const isDup = isDuplicateKeyError(err);
      if (isDup) {
        const existing = await this.model.findOne({
          where: { releaseKey: input.releaseKey } as never,
          transaction: txq,
        } as never);
        if (existing !== null) {
          return { inserted: false, release: existing };
        }
      }
      throw err;
    }
  }

  async lockRelease(releaseId: string, tx: Tx): Promise<AssetReleaseModel | null> {
    const txq = txOf(tx);
    return this.model.findByPk(releaseId, { lock: 'FOR UPDATE', transaction: txq } as never);
  }

  async listReleases(input: {
    gameId: string | null;
    cursor: string | null;
    limit: number;
    tx: Tx;
  }): Promise<{ items: AssetReleaseModel[]; nextCursor: string | null }> {
    const txq = txOf(input.tx);
    const where: Record<string, unknown> = {
      ...(input.gameId !== null ? { gameId: input.gameId as never } : {}),
    };
    const cur = parseCursor(input.cursor);
    if (cur !== null) {
      where[Op.and as unknown as string] = [
        { createdAt: { [Op.lt as unknown as string]: cur.createdAt } },
        { createdAt: cur.createdAt, id: { [Op.lt as unknown as string]: cur.id as never } },
      ];
    }
    const items = await this.model.findAll({
      where: where as never,
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: input.limit,
      transaction: txq,
    } as never);
    const last = items[items.length - 1];
    const nextCursor = items.length === input.limit && last !== undefined ? formatCursor(last) : null;
    return { items, nextCursor };
  }

  async publishRelease(input: { releaseId: string; publishedAt: Date; tx: Tx }): Promise<AssetReleaseModel | null> {
    const txq = txOf(input.tx);
    const [affected] = await this.model.update(
      {
        status: ReleaseStatus.PUBLISHED,
        publishedAt: input.publishedAt as never,
      } as never,
      {
        where: {
          id: input.releaseId as never,
          status: { [Op.in as unknown as string]: [ReleaseStatus.DRAFT, ReleaseStatus.REVIEW] } as never,
        } as never,
        transaction: txq,
      } as never,
    );
    if (affected === 0) return null;
    return this.model.findByPk(input.releaseId, { transaction: txq } as never);
  }
}

// ---------------------------------------------------------------------------
// 幂等键冲突检测（经 domain/errors.js isDuplicateKeyError，同 referral 适配器同款）
// ---------------------------------------------------------------------------
