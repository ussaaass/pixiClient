/**
 * ai-assets 模块用例：job 创建（POST /me/ai-assets/jobs，201 新创建 /
 * 200 幂等重放；QUEUED=1 + U(job_key) 幂等；不实际调外部 KMS / Kling
 * 网关，登记 KMS 未闭环）。
 *
 * 领域所有者：ai-assets 模块（写 ai_asset_job QUEUED=1；不写 ai_asset_artifact
 * / asset_release；secretReference 只登记 key ref，不存实际密钥）。
 * 对应 SDD 章节：后端实施 SDD §4（构造注入 ports，幂等先抢唯一约束）、
 * §9 第 8 步（AI 素材台账：job 创建 QUEUED=1 + U(job_key) 幂等重放；
 * 不实际调外部 API，登记 KMS 未闭环，§9 第 9 步 Admin 审核路径闭环）；
 * 数据库设计 SDD §5.10（ai_asset_job U(job_key) CHAR(36) 幂等）。
 *
 * 用例语义：
 * - job 行 QUEUED=1（状态机首版只覆盖 1→5 取消；RUNNING/SUCCEEDED/FAILED
 *   推进经外部网关回调，登记 KMS 未闭环）；
 * - U(job_key) 幂等兜底：命中 → 返回既有 job 行 `inserted: false`（200 重放）；
 * - `secretRef` 只登记 KMS key ref（不存实际密钥；登记决策点：KMS 网关
 *   未闭环，首版经 tools/asset-generation 台账对接，§9 第 9 步闭环）；
 * - `promptHashHex` 经路由层 `crypto.createHash('sha256').update(prompt).
 *   digest('hex')` 计算（64 字符，防 prompt 篡改）。
 *
 * 错误码映射（AIAS → 触发条件）：
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 行缺失（可重试，503 语义）。
 */

import type { AiAssetJobRepo, Tx } from '../ports/ai-assets-repository.js';

/** job 创建入参（路由层经 contracts 校验后传入；jobKey 经 crypto.randomUUID() 生成）。 */
export interface JobCreateInput {
  jobKey: string; // U(job_key) 幂等键（CHAR(36)，crypto.randomUUID()）
  assetKey: string; // 素材逻辑键
  assetKind: number; // 素材类型常量（登记决策点：首版经 configuration 模块注入）
  providerCode: string; // 生成提供方代码
  mainModelCode: string; // 主模型代码（GPT-6 系列）
  imageModelCode: string; // 图像模型代码
  apiMode: number; // API 模式常量
  prompt: string; // 生成提示词
  promptHashHex: string; // 提示词 SHA-256（64 字符）
  styleVersion: string; // 风格版本
  generationConfig: Record<string, unknown>; // 生成配置
  secretRef: string | null; // KMS key ref（只登记，不存实际密钥）
  tx: Tx;
}

export interface JobCreatedDto {
  jobId: string;
  jobKey: string;
  status: number;
  createdAt: string;
  inserted: boolean;
}

/**
 * job 创建用例（构造注入 AiAssetJobRepo，不用全局，SDD §4；
 * QUEUED=1 + U(job_key) 幂等兜底；不实际调外部 KMS / Kling 网关，
 * 登记 KMS 未闭环，§9 第 9 步 Admin 审核路径闭环）。
 */
export class JobCreateUseCase {
  constructor(private readonly jobRepo: AiAssetJobRepo) {}

  async run(input: JobCreateInput): Promise<JobCreatedDto> {
    const { jobKey, tx } = input;
    const result = await this.jobRepo.createJob({
      jobKey,
      assetKey: input.assetKey,
      assetKind: input.assetKind,
      providerCode: input.providerCode,
      mainModelCode: input.mainModelCode,
      imageModelCode: input.imageModelCode,
      apiMode: input.apiMode,
      prompt: input.prompt,
      promptHashHex: input.promptHashHex,
      styleVersion: input.styleVersion,
      generationConfig: input.generationConfig,
      secretRef: input.secretRef,
      tx,
    });
    const job = result.job;
    return {
      jobId: job.id,
      jobKey,
      status: job.status,
      createdAt: typeof job.createdAt === 'string' ? job.createdAt : job.createdAt.toISOString(),
      inserted: result.inserted,
    };
  }
}
