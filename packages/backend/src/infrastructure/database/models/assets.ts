/**
 * assets — 统一文件资产与 AI 素材台账：`asset` / `asset_release` / `asset_release_item` /
 * `ai_asset_job` / `ai_asset_artifact` / `ai_asset_reference`（不可变）。
 *
 * 领域所有者：ai-assets 模块（models/assets.ts 为其唯一 model 定义；
 * 批次归属 0017，见 §3.1/§3.2 校准：asset/asset_release* 归 ai-assets）。
 * 对应 SDD 章节：后端实施SDD 附录 A.9；数据库设计SDD §5.10 / §5.11。
 * DDL 以迁移 0017-create-assets.ts 为准。
 *
 * 读写用例：
 * - `AssetModel`：统一文件资产元数据与对象存储定位（content_hash BINARY(32) 摘要、
 *   存储提供方 S3_COMPATIBLE/LOCAL_DEV）；是社交/客服/集市/商品等引用列的公共目标。
 * - `AssetReleaseModel` / `AssetReleaseItemModel`：大厅与子游戏资源发布版本与清单
 *   （只发布 READY 且审核通过的 asset；清单项不可改写但保留历史）。
 * - `AiAssetJobModel`：OpenAI API 素材任务台账（main_model_code / image_model_code
 *   为实际 API 模型代码，不是本库 FK；cost_micro_usd 为百万分之一美元）。
 * - `AiAssetArtifactModel`：生成原图及前端衍生资源版本（U(asset_id) 一资产一产物行）。
 * - `AiAssetReferenceModel`（不可变）：素材生成任务的输入参考产物登记流水。
 *
 * 不可变：`ai_asset_reference` status 固定 RECORDED=1、updated_at=created_at、
 * deleted_at 恒 NULL（append-only hooks + paranoid: false，A.12 第 5 条）。
 */

import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';
import {
  appendOnlyHooks,
  appendOnlyModelOptions,
  standardTableOptions,
  binaryDataType,
  type ModelInitFn,
  type ModelInitOptions,
} from './_shared.js';

// ---------------------------------------------------------------------------
// asset
// ---------------------------------------------------------------------------

/**
 * `asset` 表属性。U(storage_provider,bucket_name,object_key)；
 * U(content_hash,byte_size)；content_hash BINARY(32) 为 SHA-256 摘要。
 */
export interface AssetModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 资产类型：IMAGE=1/ANIMATED_IMAGE=2/VIDEO=3/ATLAS=4/MANIFEST=5/BINARY=6。 */
  assetType: number;
  /** 存储提供方：S3_COMPATIBLE=1/LOCAL_DEV=2。 */
  storageProvider: number;
  /** 对象存储桶或环境内资源区。 */
  bucketName: string;
  /** 唯一对象定位键；只在 asset 存储。 */
  objectKey: string;
  /** BINARY(32)：内容 SHA-256，发布完整性校验。 */
  contentHash: Uint8Array;
  /** 明文可见资产的服务端检测 MIME；客户端加密资产仅记录客户端声明。 */
  mimeType: string;
  /** BIGINT UNSIGNED：文件大小字节。 */
  byteSize: string;
  /** INT UNSIGNED：位图宽度。 */
  width: number | null;
  /** INT UNSIGNED：位图高度。 */
  height: number | null;
  /** BIGINT UNSIGNED：音视频时长毫秒。 */
  durationMs: string | null;
  /** WebP/AVIF/H.265 等编码。 */
  codec: string | null;
  /** 可见性：PRIVATE=1/PUBLIC=2。 */
  visibility: number;
  /** 非敏感对象存储元数据，不放凭证。 */
  storageMetadata: Record<string, unknown> | null;
}

export type AssetModelCreationAttributes = Optional<AssetModelAttributes, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

export class AssetModel extends Model<AssetModelAttributes, AssetModelCreationAttributes> implements AssetModelAttributes {
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  assetType!: number;
  storageProvider!: number;
  bucketName!: string;
  objectKey!: string;
  contentHash!: Uint8Array;
  mimeType!: string;
  byteSize!: string;
  width!: number | null;
  height!: number | null;
  durationMs!: string | null;
  codec!: string | null;
  visibility!: number;
  storageMetadata!: Record<string, unknown> | null;
  static associate(models: { AssetModel: typeof AssetModel }): void {
    void models.AssetModel;
  }
}

// ---------------------------------------------------------------------------
// asset_release
// ---------------------------------------------------------------------------

/** `asset_release` 表属性。release_key U；manifest_hash BINARY(32) 为资源清单哈希。 */
export interface AssetReleaseModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 子游戏发布，引用 game.id；NULL 表示大厅公共资源。 */
  gameId: string | null;
  /** 发布版本业务编号（U(release_key)）。 */
  releaseKey: string;
  /** 发布清单文件，引用 asset.id。 */
  assetId: string;
  /** BINARY(32)：资源清单哈希。 */
  manifestHash: Uint8Array;
  /** 上线时间。 */
  publishedAt: Date | string | null;
  /** 发布审核说明。 */
  reviewNote: string;
}

export type AssetReleaseModelCreationAttributes = Optional<
  AssetReleaseModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class AssetReleaseModel
  extends Model<AssetReleaseModelAttributes, AssetReleaseModelCreationAttributes>
  implements AssetReleaseModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  gameId!: string | null;
  releaseKey!: string;
  assetId!: string;
  manifestHash!: Uint8Array;
  publishedAt!: Date | string | null;
  reviewNote!: string;
  static associate(models: { AssetReleaseModel: typeof AssetReleaseModel; AssetModel: typeof AssetModel }): void {
    AssetReleaseModel.belongsTo(models.AssetModel, {
      foreignKey: 'asset_id',
      as: 'manifestAsset',
      constraints: false,
    });
    // game 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// asset_release_item
// ---------------------------------------------------------------------------

/**
 * `asset_release_item` 表属性。发布清单项不可改写（status 固定 RECORDED=1、
 * deleted_at 恒 NULL，迁移注释"清单项保留历史"）；
 * U(release,resource_key)、U(release,asset)。
 */
export interface AssetReleaseItemModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 发布版本，引用 asset_release.id。 */
  assetReleaseId: string;
  /** 实际发布文件，引用 asset.id；只发布 READY 且审核通过的 asset。 */
  assetId: string;
  /** 前端资源语义键。 */
  resourceKey: string;
  /** 加载阶段：SHELL=1/ENTRY=2/BACKGROUND=3/OPTIONAL=4。 */
  loadPhase: number;
  /** 网络调度优先级；普通数值，允许 0。 */
  priority: number;
}

export type AssetReleaseItemModelCreationAttributes = Optional<
  AssetReleaseItemModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class AssetReleaseItemModel
  extends Model<AssetReleaseItemModelAttributes, AssetReleaseItemModelCreationAttributes>
  implements AssetReleaseItemModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  assetReleaseId!: string;
  assetId!: string;
  resourceKey!: string;
  loadPhase!: number;
  priority!: number;
  static associate(models: {
    AssetReleaseItemModel: typeof AssetReleaseItemModel;
    AssetReleaseModel: typeof AssetReleaseModel;
    AssetModel: typeof AssetModel;
  }): void {
    AssetReleaseItemModel.belongsTo(models.AssetReleaseModel, {
      foreignKey: 'asset_release_id',
      as: 'assetRelease',
      constraints: false,
    });
    AssetReleaseItemModel.belongsTo(models.AssetModel, {
      foreignKey: 'asset_id',
      as: 'asset',
      constraints: false,
    });
  }
}

// ---------------------------------------------------------------------------
// ai_asset_job
// ---------------------------------------------------------------------------

/**
 * `ai_asset_job` 表属性。job_key U；main_model_code / image_model_code 为
 * 实际有权限的 API 模型代码（不是本库外键）；cost_micro_usd 为百万分之一美元
 * （十进制字符串 wire）；attempts 允许 0。
 */
export interface AiAssetJobModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 素材任务定位值（U(job_key)）。 */
  jobKey: string;
  /** 目标素材语义键。 */
  assetKey: string;
  /** 素材类型：BACKGROUND=1/CHARACTER=2/CARD=3/ICON=4/EFFECT=5。 */
  assetKind: number;
  /** 服务商代码，默认 OPENAI。 */
  providerCode: string;
  /** 实际有权限的 GPT-6 系列 API 主模型代码，不是本库 FK。 */
  mainModelCode: string;
  /** 独立图像生成模型代码，不是本库 FK。 */
  imageModelCode: string;
  /** API 模式：RESPONSES_IMAGE_TOOL=1/IMAGES=2。 */
  apiMode: number;
  /** 可审计生成指令（MEDIUMTEXT）。 */
  prompt: string;
  /** BINARY(32)：指令内容摘要。 */
  promptHash: Uint8Array;
  /** 卡通风格规范版本。 */
  styleVersion: string;
  /** 尺寸透明背景参考图策略等非秘密参数。 */
  generationConfig: Record<string, unknown>;
  /** API 请求或响应定位值。 */
  providerRequestKey: string | null;
  /** Token 图像用量及实际计费依据。 */
  usageSnapshot: Record<string, unknown> | null;
  /** BIGINT：实际或明确标识的估算费用，百万分之一美元。 */
  costMicroUsd: string | null;
  /** INT UNSIGNED：受预算控制的重试次数；普通计数，允许 0。 */
  attempts: number;
  /** 生成结束时间。 */
  completedAt: Date | string | null;
}

export type AiAssetJobModelCreationAttributes = Optional<
  AiAssetJobModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class AiAssetJobModel
  extends Model<AiAssetJobModelAttributes, AiAssetJobModelCreationAttributes>
  implements AiAssetJobModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  jobKey!: string;
  assetKey!: string;
  assetKind!: number;
  providerCode!: string;
  mainModelCode!: string;
  imageModelCode!: string;
  apiMode!: number;
  prompt!: string;
  promptHash!: Uint8Array;
  styleVersion!: string;
  generationConfig!: Record<string, unknown>;
  providerRequestKey!: string | null;
  usageSnapshot!: Record<string, unknown> | null;
  costMicroUsd!: string | null;
  attempts!: number;
  completedAt!: Date | string | null;
  static associate(models: { AiAssetJobModel: typeof AiAssetJobModel }): void {
    void models.AiAssetJobModel;
  }
}

// ---------------------------------------------------------------------------
// ai_asset_artifact
// ---------------------------------------------------------------------------

/** `ai_asset_artifact` 表属性。U(asset_id)（一资产一产物行）；
 * 对象键、hash、MIME、字节数和宽高只保存在 asset。 */
export interface AiAssetArtifactModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 生成任务，引用 ai_asset_job.id。 */
  aiAssetJobId: string;
  /** 生成文件，引用 asset.id（U(asset_id)）。 */
  assetId: string;
  /** 产物类型：ORIGINAL=1/WEBP=2/AVIF=3/ATLAS=4/METADATA=5。 */
  artifactType: number;
  /** 生成条款及引用素材来源。 */
  licenseSnapshot: Record<string, unknown>;
  /** 质量审核与缺陷说明。 */
  reviewNote: string | null;
}

export type AiAssetArtifactModelCreationAttributes = Optional<
  AiAssetArtifactModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class AiAssetArtifactModel
  extends Model<AiAssetArtifactModelAttributes, AiAssetArtifactModelCreationAttributes>
  implements AiAssetArtifactModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  aiAssetJobId!: string;
  assetId!: string;
  artifactType!: number;
  licenseSnapshot!: Record<string, unknown>;
  reviewNote!: string | null;
  static associate(models: {
    AiAssetArtifactModel: typeof AiAssetArtifactModel;
    AiAssetJobModel: typeof AiAssetJobModel;
    AssetModel: typeof AssetModel;
  }): void {
    AiAssetArtifactModel.belongsTo(models.AiAssetJobModel, {
      foreignKey: 'ai_asset_job_id',
      as: 'aiAssetJob',
      constraints: false,
    });
    AiAssetArtifactModel.belongsTo(models.AssetModel, {
      foreignKey: 'asset_id',
      as: 'asset',
      constraints: false,
    });
  }
}

// ---------------------------------------------------------------------------
// ai_asset_reference（不可变）
// ---------------------------------------------------------------------------

/**
 * `ai_asset_reference` 表属性（不可变参考登记流水）。status 固定 RECORDED=1；
 * updated_at 固定等于 created_at；deleted_at 恒 NULL（迁移 CHECK）。
 * U(ai_asset_job_id, asset_id, reference_role)。
 */
export interface AiAssetReferenceModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 使用参考图的目标任务，引用 ai_asset_job.id。 */
  aiAssetJobId: string;
  /** 输入参考文件，引用 asset.id。 */
  assetId: string;
  /** 参考用途：STYLE=1/CHARACTER=2/EDIT_TARGET=3。 */
  referenceRole: number;
  /** INT UNSIGNED：参考顺序；普通计数，允许 0。 */
  sortOrder: number;
}

export type AiAssetReferenceModelCreationAttributes = Optional<
  AiAssetReferenceModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class AiAssetReferenceModel
  extends Model<AiAssetReferenceModelAttributes, AiAssetReferenceModelCreationAttributes>
  implements AiAssetReferenceModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  aiAssetJobId!: string;
  assetId!: string;
  referenceRole!: number;
  sortOrder!: number;
  static associate(models: {
    AiAssetReferenceModel: typeof AiAssetReferenceModel;
    AiAssetJobModel: typeof AiAssetJobModel;
    AssetModel: typeof AssetModel;
  }): void {
    AiAssetReferenceModel.belongsTo(models.AiAssetJobModel, {
      foreignKey: 'ai_asset_job_id',
      as: 'aiAssetJob',
      constraints: false,
    });
    AiAssetReferenceModel.belongsTo(models.AssetModel, {
      foreignKey: 'asset_id',
      as: 'asset',
      constraints: false,
    });
  }
}

// ---------------------------------------------------------------------------
// 状态/类型常量（本地常量；单一来源在 @gameing/contracts 落地后迁移）
// ---------------------------------------------------------------------------

export const AssetStatus = { STORED: 1, READY: 2, QUARANTINED: 3, RETIRED: 4 } as const;
export type AssetStatusValue = (typeof AssetStatus)[keyof typeof AssetStatus];

export const AssetTypeLocal = {
  IMAGE: 1,
  ANIMATED_IMAGE: 2,
  VIDEO: 3,
  ATLAS: 4,
  MANIFEST: 5,
  BINARY: 6,
} as const;
export type AssetTypeLocalValue = (typeof AssetTypeLocal)[keyof typeof AssetTypeLocal];

export const AssetStorageProvider = { S3_COMPATIBLE: 1, LOCAL_DEV: 2 } as const;
export type AssetStorageProviderValue = (typeof AssetStorageProvider)[keyof typeof AssetStorageProvider];

export const AssetVisibility = { PRIVATE: 1, PUBLIC: 2 } as const;
export type AssetVisibilityValue = (typeof AssetVisibility)[keyof typeof AssetVisibility];

export const ReleaseStatus = { DRAFT: 1, REVIEW: 2, PUBLISHED: 3, RETIRED: 4 } as const;
export type ReleaseStatusValue = (typeof ReleaseStatus)[keyof typeof ReleaseStatus];

/** RecordStatus：不可变清单项/参考登记行固定 1（本地常量，单一来源在 contracts 落地后统一）。 */
export const RecordStatus = { RECORDED: 1 } as const;
export type RecordStatusValue = (typeof RecordStatus)[keyof typeof RecordStatus];

export const ReleaseLoadPhase = { SHELL: 1, ENTRY: 2, BACKGROUND: 3, OPTIONAL: 4 } as const;
export type ReleaseLoadPhaseValue = (typeof ReleaseLoadPhase)[keyof typeof ReleaseLoadPhase];

export const AiJobStatus = {
  QUEUED: 1,
  RUNNING: 2,
  SUCCEEDED: 3,
  FAILED: 4,
  CANCELLED: 5,
  REVIEW_REQUIRED: 6,
} as const;
export type AiJobStatusValue = (typeof AiJobStatus)[keyof typeof AiJobStatus];

export const AiAssetKind = {
  BACKGROUND: 1,
  CHARACTER: 2,
  CARD: 3,
  ICON: 4,
  EFFECT: 5,
} as const;
export type AiAssetKindValue = (typeof AiAssetKind)[keyof typeof AiAssetKind];

export const AiApiMode = { RESPONSES_IMAGE_TOOL: 1, IMAGES: 2 } as const;
export type AiApiModeValue = (typeof AiApiMode)[keyof typeof AiApiMode];

export const ArtifactStatus = { GENERATED: 1, APPROVED: 2, REJECTED: 3 } as const;
export type ArtifactStatusValue = (typeof ArtifactStatus)[keyof typeof ArtifactStatus];

export const ArtifactType = { ORIGINAL: 1, WEBP: 2, AVIF: 3, ATLAS: 4, METADATA: 5 } as const;
export type ArtifactTypeValue = (typeof ArtifactType)[keyof typeof ArtifactType];

export const ReferenceRole = { STYLE: 1, CHARACTER: 2, EDIT_TARGET: 3 } as const;
export type ReferenceRoleValue = (typeof ReferenceRole)[keyof typeof ReferenceRole];

export function register_AssetModel(sequelize: Sequelize): void {
  (AssetModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '资产状态，取值见 AssetStatus：STORED=1/READY=2/QUARANTINED=3/RETIRED=4',
      },
      assetType: {
        field: 'asset_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '资产类型：IMAGE=1/ANIMATED_IMAGE=2/VIDEO=3/ATLAS=4/MANIFEST=5/BINARY=6',
      },
      storageProvider: {
        field: 'storage_provider',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '存储提供方：S3_COMPATIBLE=1/LOCAL_DEV=2',
      },
      bucketName: {
        field: 'bucket_name',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '对象存储桶或环境内资源区',
      },
      objectKey: {
        field: 'object_key',
        type: DataTypes.STRING(512),
        allowNull: false,
        comment: '唯一对象定位键；只在 asset 存储',
      },
      contentHash: {
        field: 'content_hash',
        type: binaryDataType(32),
        allowNull: false,
        comment: '内容 SHA-256，发布完整性校验',
      },
      mimeType: {
        field: 'mime_type',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '明文可见资产的服务端检测 MIME；客户端加密资产仅记录客户端声明，不作为可信检测结果',
      },
      byteSize: {
        field: 'byte_size',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '文件大小字节',
      },
      width: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '位图宽度',
      },
      height: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '位图高度',
      },
      durationMs: {
        field: 'duration_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '音视频时长毫秒',
      },
      codec: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: 'WebP/AVIF/H.265 等编码',
      },
      visibility: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '可见性：PRIVATE=1/PUBLIC=2',
      },
      storageMetadata: {
        field: 'storage_metadata',
        type: DataTypes.JSON,
        allowNull: true,
        comment: '非敏感对象存储元数据，不放凭证',
      },
    },

    {
      ...standardTableOptions('asset'),
      comment: '统一文件资产元数据和对象存储定位',
      sequelize,
    } as unknown as ModelInitOptions<AssetModel>,
  );
}

export function register_AssetReleaseModel(sequelize: Sequelize): void {
  (AssetReleaseModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '发布状态，取值见 ReleaseStatus：DRAFT=1/REVIEW=2/PUBLISHED=3/RETIRED=4',
      },
      gameId: {
        field: 'game_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '子游戏发布，引用 game.id；NULL 表示大厅公共资源',
      },
      releaseKey: {
        field: 'release_key',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '发布版本业务编号',
      },
      assetId: {
        field: 'asset_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '发布清单文件，引用 asset.id',
      },
      manifestHash: {
        field: 'manifest_hash',
        type: binaryDataType(32),
        allowNull: false,
        comment: '资源清单哈希',
      },
      publishedAt: {
        field: 'published_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '上线时间，UTC',
      },
      reviewNote: {
        field: 'review_note',
        type: DataTypes.STRING(1000),
        allowNull: false,
        comment: '发布审核说明',
      },
    },

    {
      ...standardTableOptions('asset_release'),
      comment: '大厅和子游戏资源发布版本',
      sequelize,
    } as unknown as ModelInitOptions<AssetReleaseModel>,
  );
}

export function register_AssetReleaseItemModel(sequelize: Sequelize): void {
  (AssetReleaseItemModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '清单项状态，固定为 RecordStatus.RECORDED=1，发布清单项不可改写',
      },
      assetReleaseId: {
        field: 'asset_release_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '发布版本，引用 asset_release.id',
      },
      assetId: {
        field: 'asset_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '实际发布文件，引用 asset.id；只发布 READY 且审核通过的 asset',
      },
      resourceKey: {
        field: 'resource_key',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '前端资源语义键',
      },
      loadPhase: {
        field: 'load_phase',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '加载阶段：SHELL=1/ENTRY=2/BACKGROUND=3/OPTIONAL=4',
      },
      priority: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '网络调度优先级；普通数值，允许 0',
      },
    },

    {
      ...standardTableOptions('asset_release_item'),
      comment: '资源发布包含的已审核产物',
      sequelize,
    } as unknown as ModelInitOptions<AssetReleaseItemModel>,
  );
}

export function register_AiAssetJobModel(sequelize: Sequelize): void {
  (AiAssetJobModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '任务状态，取值见 AiJobStatus：QUEUED=1/RUNNING=2/SUCCEEDED=3/FAILED=4/CANCELLED=5/REVIEW_REQUIRED=6',
      },
      jobKey: {
        field: 'job_key',
        type: DataTypes.CHAR(36),
        allowNull: false,
        comment: '素材任务定位值',
      },
      assetKey: {
        field: 'asset_key',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '目标素材语义键',
      },
      assetKind: {
        field: 'asset_kind',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '素材类型：BACKGROUND=1/CHARACTER=2/CARD=3/ICON=4/EFFECT=5',
      },
      providerCode: {
        field: 'provider_code',
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'OPENAI',
        comment: '服务商代码',
      },
      mainModelCode: {
        field: 'main_model_code',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '实际有权限的 GPT-6 系列 API 主模型代码，不是本库 FK',
      },
      imageModelCode: {
        field: 'image_model_code',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '独立图像生成模型代码，不是本库 FK',
      },
      apiMode: {
        field: 'api_mode',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: 'API 模式：RESPONSES_IMAGE_TOOL=1/IMAGES=2',
      },
      prompt: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: '可审计生成指令',
      },
      promptHash: {
        field: 'prompt_hash',
        type: binaryDataType(32),
        allowNull: false,
        comment: '指令内容摘要',
      },
      styleVersion: {
        field: 'style_version',
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '卡通风格规范版本',
      },
      generationConfig: {
        field: 'generation_config',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '尺寸透明背景参考图策略等非秘密参数',
      },
      providerRequestKey: {
        field: 'provider_request_key',
        type: DataTypes.STRING(160),
        allowNull: true,
        comment: 'API 请求或响应定位值',
      },
      usageSnapshot: {
        field: 'usage_snapshot',
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'Token 图像用量及实际计费依据',
      },
      costMicroUsd: {
        field: 'cost_micro_usd',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '实际或明确标识的估算费用，百万分之一美元',
      },
      attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '受预算控制的重试次数；普通计数，允许 0',
      },
      completedAt: {
        field: 'completed_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '生成结束时间，UTC',
      },
    },

    {
      ...standardTableOptions('ai_asset_job'),
      comment: '通过 OpenAI API 执行的素材任务',
      sequelize,
    } as unknown as ModelInitOptions<AiAssetJobModel>,
  );
}

export function register_AiAssetArtifactModel(sequelize: Sequelize): void {
  (AiAssetArtifactModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '产物状态，取值见 ArtifactStatus：GENERATED=1/APPROVED=2/REJECTED=3',
      },
      aiAssetJobId: {
        field: 'ai_asset_job_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '生成任务，引用 ai_asset_job.id',
      },
      assetId: {
        field: 'asset_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '生成文件，引用 asset.id；对象键、hash、MIME、字节数和宽高只保存在 asset',
      },
      artifactType: {
        field: 'artifact_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '产物类型：ORIGINAL=1/WEBP=2/AVIF=3/ATLAS=4/METADATA=5',
      },
      licenseSnapshot: {
        field: 'license_snapshot',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '生成条款及引用素材来源',
      },
      reviewNote: {
        field: 'review_note',
        type: DataTypes.STRING(1000),
        allowNull: true,
        comment: '质量审核与缺陷说明',
      },
    },

    {
      ...standardTableOptions('ai_asset_artifact'),
      comment: '生成原图及前端衍生资源版本',
      sequelize,
    } as unknown as ModelInitOptions<AiAssetArtifactModel>,
  );
}

export function register_AiAssetReferenceModel(sequelize: Sequelize): void {
  (AiAssetReferenceModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '参考登记状态，固定为 RecordStatus.RECORDED=1，参考登记不可改写',
      },
      aiAssetJobId: {
        field: 'ai_asset_job_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '使用参考图的目标任务，引用 ai_asset_job.id',
      },
      assetId: {
        field: 'asset_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '输入参考文件，引用 asset.id',
      },
      referenceRole: {
        field: 'reference_role',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '参考用途：STYLE=1/CHARACTER=2/EDIT_TARGET=3',
      },
      sortOrder: {
        field: 'sort_order',
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '参考顺序；普通计数，允许 0',
      },
    },

    {
      ...appendOnlyModelOptions('ai_asset_reference'),
      hooks: { ...appendOnlyHooks('ai_asset_reference') },
      comment: '素材生成任务的输入参考产物',
      sequelize,
    } as unknown as ModelInitOptions<AiAssetReferenceModel>,
  );
}
// ---------------------------------------------------------------------------
// 文件级注册器
// ---------------------------------------------------------------------------

export interface AssetModels {
  AssetModel: typeof AssetModel;
  AssetReleaseModel: typeof AssetReleaseModel;
  AssetReleaseItemModel: typeof AssetReleaseItemModel;
  AiAssetJobModel: typeof AiAssetJobModel;
  AiAssetArtifactModel: typeof AiAssetArtifactModel;
  AiAssetReferenceModel: typeof AiAssetReferenceModel;
}

/** 定义 6 个 assets model（不在此声明跨文件关联）。 */
export function initAssets(sequelize: Sequelize, models: AssetModels): void {
  register_AssetModel(sequelize);
  register_AssetReleaseModel(sequelize);
  register_AssetReleaseItemModel(sequelize);
  register_AiAssetJobModel(sequelize);
  register_AiAssetArtifactModel(sequelize);
  register_AiAssetReferenceModel(sequelize);
  void models;
}

/** 声明 assets 文件内的跨表关联（FK 全部 constraints: false，由迁移管理）。 */
export function associateAssets(models: AssetModels): void {
  AssetModel.associate(models);
  AssetReleaseModel.associate(models);
  AssetReleaseItemModel.associate(models);
  AiAssetJobModel.associate(models);
  AiAssetArtifactModel.associate(models);
  AiAssetReferenceModel.associate(models);
}
