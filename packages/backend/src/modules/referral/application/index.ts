/**
 * referral 模块用例 re-export 入口（供 assembly / public 统一 import）。
 *
 * 领域所有者：referral 模块（application/ 子目录统一出口，SDD §1 模块内聚）。
 * 对应 SDD 章节：后端实施 SDD §1（"modules/…/application 用例统一经
 * application/index.ts re-export，不用散 export"）、§9 第 6 步（5 端点
 * 用例类全部在本文件登记）。
 */

export { InviteLinkUseCase, type InviteLinkDto, INVITE_CODE_LENGTH, INVITE_CODE_TTL_SECONDS, generateInviteCode } from './invite-link.js';

export {
  ReferralListUseCase,
  type DirectInviteeDto,
  type DirectInviteesPageDto,
  type RewardItemDto,
  type RewardsPageDto,
  REFERRAL_PAGE_LIMIT,
} from './referral-list.js';

export { AttributionUseCase, type AttributionInput, type AttributionResultDto } from './attribution.js';

export { AgentDomainUseCase, type AgentDomainDto, type AgentDomainApplyResultDto } from './agent-domain.js';
