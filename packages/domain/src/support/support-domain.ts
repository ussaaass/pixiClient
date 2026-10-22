import { SupportConversationStatus } from '@gameing/contracts/support';

export function statusAfterCustomerReply(current: 1 | 2 | 3): 1 | null {
  return current === SupportConversationStatus.CLOSED ? null : SupportConversationStatus.WAITING_SUPPORT;
}

export function statusAfterCustomerClose(): 3 {
  return SupportConversationStatus.CLOSED;
}
