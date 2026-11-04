import {
  type SupportDeskDetailResponseDto,
  type SupportDeskListResponseDto,
  type SupportDeskQueryDto,
  type SupportDeskReplyRequestDto,
} from '@gameing/contracts/support';
import { AdminApiClient, AdminApiError } from '../admin-api-client.js';
import type { SupportDeskRepositoryPort } from './support-desk-application';

type SupportDeskFailure = 'NOT_FOUND' | 'CLOSED' | 'ASSIGNED_TO_OTHER' | 'REQUEST_KEY_REUSED' | 'WRITE_FAILED';
const SUPPORT_DESK_FAILURE_CODES: readonly string[] = ['NOT_FOUND', 'CLOSED', 'ASSIGNED_TO_OTHER', 'REQUEST_KEY_REUSED'];

export class RemoteSupportDeskAdapter implements SupportDeskRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async list(query: SupportDeskQueryDto): Promise<SupportDeskListResponseDto> {
    const params: Record<string, string | number | undefined> = {
      status: query.status,
      keyword: query.keyword,
      cursor: query.cursor,
      pageSize: query.pageSize ?? 20,
    };
    return this.client.get<SupportDeskListResponseDto>('/support-desk/conversations', params);
  }

  async detail(conversationId: string): Promise<SupportDeskDetailResponseDto | null> {
    try {
      return await this.client.get<SupportDeskDetailResponseDto>(`/support-desk/conversations/${encodeURIComponent(conversationId)}`);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async claim(conversationId: string, actorUserId: string, requestKey: string): Promise<SupportDeskDetailResponseDto | SupportDeskFailure> {
    return this.runAction(conversationId, 'claims', { actorUserId, requestKey });
  }

  async reply(conversationId: string, actorUserId: string, request: SupportDeskReplyRequestDto): Promise<SupportDeskDetailResponseDto | SupportDeskFailure> {
    return this.runAction(conversationId, 'replies', { ...request, actorUserId });
  }

  async resolve(conversationId: string, actorUserId: string, requestKey: string): Promise<SupportDeskDetailResponseDto | SupportDeskFailure> {
    return this.runAction(conversationId, 'resolves', { actorUserId, requestKey });
  }

  async reopen(conversationId: string, actorUserId: string, requestKey: string): Promise<SupportDeskDetailResponseDto | SupportDeskFailure> {
    return this.runAction(conversationId, 'reopens', { actorUserId, requestKey });
  }

  private async runAction(
    conversationId: string,
    action: string,
    body: unknown,
  ): Promise<SupportDeskDetailResponseDto | SupportDeskFailure> {
    try {
      return await this.client.post<SupportDeskDetailResponseDto>(
        `/support-desk/conversations/${encodeURIComponent(conversationId)}/${action}`,
        body,
      );
    } catch (error) {
      if (error instanceof AdminApiError && SUPPORT_DESK_FAILURE_CODES.includes(error.code)) {
        return error.code as SupportDeskFailure;
      }
      throw error;
    }
  }
}
