import { SocialContentStatus, SocialModerationAction, SocialModerationCaseStatus, type SocialModerationCaseDto, type SocialModerationDecisionRequestDto } from '@gameing/contracts/social';

export type SocialModerationFailureCode = 'NOT_FOUND' | 'CASE_ALREADY_CLOSED' | 'REQUEST_KEY_REUSED' | 'INVALID_TRANSITION' | 'READ_FAILED' | 'WRITE_FAILED';
export type SocialModerationTransitionFailure = 'CASE_ALREADY_CLOSED' | 'INVALID_TRANSITION';

export function applyModerationDecision(item: SocialModerationCaseDto, request: SocialModerationDecisionRequestDto): { item: SocialModerationCaseDto; previousStatus: SocialModerationCaseDto['contentStatus']; nextStatus: SocialModerationCaseDto['contentStatus'] } | SocialModerationTransitionFailure {
  if (item.caseStatus !== SocialModerationCaseStatus.OPEN) return 'CASE_ALREADY_CLOSED';
  const previousStatus = item.contentStatus;
  let nextStatus = previousStatus;
  if (request.action === SocialModerationAction.APPROVE) {
    if (previousStatus !== SocialContentStatus.PENDING_REVIEW) return 'INVALID_TRANSITION';
    nextStatus = SocialContentStatus.PUBLISHED;
  } else if (request.action === SocialModerationAction.HIDE) {
    if (previousStatus === SocialContentStatus.HIDDEN) return 'INVALID_TRANSITION';
    nextStatus = SocialContentStatus.HIDDEN;
  } else if (request.action === SocialModerationAction.RESTORE) {
    if (previousStatus !== SocialContentStatus.HIDDEN) return 'INVALID_TRANSITION';
    nextStatus = SocialContentStatus.PUBLISHED;
  } else if (request.action === SocialModerationAction.DISMISS && previousStatus === SocialContentStatus.PENDING_REVIEW) {
    return 'INVALID_TRANSITION';
  }
  const caseStatus = request.action === SocialModerationAction.DISMISS ? SocialModerationCaseStatus.DISMISSED : SocialModerationCaseStatus.RESOLVED;
  return { item: { ...item, contentStatus: nextStatus, caseStatus }, previousStatus, nextStatus };
}
