import { SupportConversationStatus, type SupportDeskConversationDto } from '@gameing/contracts/support';

export type SupportDeskFailureCode = 'NOT_FOUND' | 'CLOSED' | 'ASSIGNED_TO_OTHER' | 'INVALID_STATE' | 'REQUEST_KEY_REUSED' | 'READ_FAILED' | 'WRITE_FAILED';

export function canClaimConversation(item: SupportDeskConversationDto, actorUserId: string): boolean {
  return item.conversation.status !== SupportConversationStatus.CLOSED
    && (item.assignedAdminUserId === null || item.assignedAdminUserId === actorUserId);
}

export function statusAfterSupportReply(status: SupportDeskConversationDto['conversation']['status']): SupportDeskConversationDto['conversation']['status'] | null {
  return status === SupportConversationStatus.CLOSED ? null : SupportConversationStatus.WAITING_USER;
}

export function statusAfterSupportResolve(): SupportDeskConversationDto['conversation']['status'] {
  return SupportConversationStatus.CLOSED;
}

export function statusAfterSupportReopen(status: SupportDeskConversationDto['conversation']['status']): SupportDeskConversationDto['conversation']['status'] | null {
  return status === SupportConversationStatus.CLOSED ? SupportConversationStatus.WAITING_SUPPORT : null;
}
