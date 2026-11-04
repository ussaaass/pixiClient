import {
  type SocialModerationAuditListResponseDto,
  type SocialModerationDecisionRequestDto,
  type SocialModerationDecisionResponseDto,
  type SocialModerationListResponseDto,
  type SocialModerationQueryDto,
} from '@gameing/contracts/social';
import { AdminApiClient, AdminApiError } from '../admin-api-client.js';
import type { SocialModerationRepositoryPort } from './social-moderation-application';

type SocialModerationStringFailure = 'NOT_FOUND' | 'CASE_ALREADY_CLOSED' | 'REQUEST_KEY_REUSED' | 'INVALID_TRANSITION';

export class RemoteSocialModerationAdapter implements SocialModerationRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async list(query: SocialModerationQueryDto): Promise<SocialModerationListResponseDto> {
    const params: Record<string, string | number | undefined> = {
      resourceType: query.resourceType,
      caseStatus: query.caseStatus,
      keyword: query.keyword,
      cursor: query.cursor,
      pageSize: query.pageSize ?? 20,
    };
    return this.client.get<SocialModerationListResponseDto>('/social-moderation/cases', params);
  }

  async listAudits(caseId: string): Promise<SocialModerationAuditListResponseDto | null> {
    try {
      return await this.client.get<SocialModerationAuditListResponseDto>(`/social-moderation/cases/${encodeURIComponent(caseId)}/audits`);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async decide(
    caseId: string,
    reviewerAdminUserId: string,
    request: SocialModerationDecisionRequestDto,
  ): Promise<SocialModerationDecisionResponseDto | SocialModerationStringFailure> {
    try {
      return await this.client.post<SocialModerationDecisionResponseDto>(
        `/social-moderation/cases/${encodeURIComponent(caseId)}/decisions`,
        { ...request, reviewerAdminUserId },
      );
    } catch (error) {
      if (
        error instanceof AdminApiError
        && (error.code === 'NOT_FOUND' || error.code === 'CASE_ALREADY_CLOSED' || error.code === 'REQUEST_KEY_REUSED' || error.code === 'INVALID_TRANSITION')
      ) {
        return error.code as SocialModerationStringFailure;
      }
      throw error;
    }
  }
}
