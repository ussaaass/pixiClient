/**
 * ai-assets 模块纯领域规则（job 状态机转换表 + release 状态机转换表，
 * 无 IO）。
 *
 * 领域所有者：ai-assets 模块（domain/job-rules.ts；用例层 / 适配器层
 * 前置校验经本文件纯函数，不直接读表）。
 * 对应 SDD 章节：后端实施 SDD §9 第 8 步（AI 素材台账：job 状态机
 * QUEUED=1→RUNNING=2→{SUCCEEDED=3/FAILED=4/CANCELLED=5/REVIEW_REQUIRED=6}；
 * release 状态机 DRAFT=1→REVIEW=2→PUBLISHED=3→RETIRED=4）；
 * models/assets.ts 全部状态常量（AiJobStatus / ReleaseStatus /
 * ArtifactStatus）。
 *
 * 约定：
 * - job 状态机首版只覆盖玩家侧路径（1→{5} 取消；RUNNING/SUCCEEDED/
 *   FAILED 推进经外部网关回调，登记 KMS 未闭环）；REVIEW_REQUIRED=6
 *   → SUCCEEDED=3 推进归 §9 第 9 步 Admin 审核路径（登记扩展点）；
 * - release 状态机首版覆盖 DRAFT=1 → PUBLISHED=3（Admin 审核路径
 *   REVIEW=2 登记扩展点，§9 第 9 步）；RETIRED=4 经 Admin 操作。
 */

/** AiJobStatus：job 6 态常量（DDL 权威，models/assets.ts）。 */
export const AiJobStatus6 = {
  QUEUED: 1,
  RUNNING: 2,
  SUCCEEDED: 3,
  FAILED: 4,
  CANCELLED: 5,
  REVIEW_REQUIRED: 6,
} as const;

export type AiJobStatus6Value = (typeof AiJobStatus6)[keyof typeof AiJobStatus6];

/** ReleaseStatus：release 4 态常量（DDL 权威，models/assets.ts）。 */
export const ReleaseStatus4 = {
  DRAFT: 1,
  REVIEW: 2,
  PUBLISHED: 3,
  RETIRED: 4,
} as const;

export type ReleaseStatus4Value = (typeof ReleaseStatus4)[keyof typeof ReleaseStatus4];

/**
 * job 状态机转换表（6 态 DDL 权威）：
 * - QUEUED=1 → [CANCELLED=5]（玩家侧取消；RUNNING 推进经外部网关回调，
 *   登记 KMS 未闭环）
 * - RUNNING=2 → [SUCCEEDED=3, FAILED=4, REVIEW_REQUIRED=6]（外部网关
 *   回调推进，首版登记未闭环）
 * - REVIEW_REQUIRED=6 → [SUCCEEDED=3]（Admin 审核路径，§9 第 9 步登记）
 * - SUCCEEDED=3 / FAILED=4 / CANCELLED=5 → []（终态）
 */
export const AI_JOB_TRANSITIONS: Readonly<Record<number, readonly number[]>> = Object.freeze({
  [AiJobStatus6.QUEUED]: [AiJobStatus6.CANCELLED],
  [AiJobStatus6.RUNNING]: [AiJobStatus6.SUCCEEDED, AiJobStatus6.FAILED, AiJobStatus6.REVIEW_REQUIRED],
  [AiJobStatus6.REVIEW_REQUIRED]: [AiJobStatus6.SUCCEEDED],
  [AiJobStatus6.SUCCEEDED]: [],
  [AiJobStatus6.FAILED]: [],
  [AiJobStatus6.CANCELLED]: [],
});

/**
 * release 状态机转换表（4 态 DDL 权威）：
 * - DRAFT=1 → [REVIEW=2, PUBLISHED=3]（PUBLISHED 首版直推，登记决策点：
 *   是否需经 REVIEW=2 审核）
 * - REVIEW=2 → [PUBLISHED=3, DRAFT=1]（Admin 审核路径，§9 第 9 步登记）
 * - PUBLISHED=3 → [RETIRED=4]（Admin 操作）
 * - RETIRED=4 → []（终态）
 */
export const RELEASE_TRANSITIONS: Readonly<Record<number, readonly number[]>> = Object.freeze({
  [ReleaseStatus4.DRAFT]: [ReleaseStatus4.REVIEW, ReleaseStatus4.PUBLISHED],
  [ReleaseStatus4.REVIEW]: [ReleaseStatus4.PUBLISHED, ReleaseStatus4.DRAFT],
  [ReleaseStatus4.PUBLISHED]: [ReleaseStatus4.RETIRED],
  [ReleaseStatus4.RETIRED]: [],
});

/**
 * job 状态机转换合法性校验（from → to 是否合法；经转换表查）。
 * @returns 合法返回 `true`；不合法返回 `false`（用例层抛 `JOB_NOT_CANCELLABLE`）。
 */
export function canJobTransition(from: number, to: number): boolean {
  const allowed = AI_JOB_TRANSITIONS[from];
  if (allowed === undefined) return false;
  return allowed.includes(to);
}

/**
 * release 状态机转换合法性校验（from → to 是否合法；经转换表查）。
 * @returns 合法返回 `true`；不合法返回 `false`（用例层抛 `RELEASE_NOT_DRAFT`）。
 */
export function canReleaseTransition(from: number, to: number): boolean {
  const allowed = RELEASE_TRANSITIONS[from];
  if (allowed === undefined) return false;
  return allowed.includes(to);
}
