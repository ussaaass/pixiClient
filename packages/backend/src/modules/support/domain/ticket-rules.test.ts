import { describe, expect, it } from 'vitest';
import { canAdminReply, isValidConversationStatusTransition, supportClaimKeyOf } from './ticket-rules.js';

const baseReplyInput = {
  adminRoleType: 4,
  adminUserId: '42',
  assignedAdminUserId: '42',
  conversationStatus: 2,
};

describe('support ticket rules', () => {
  it('requires the ADMIN role bit, assignment ownership, and an open conversation', () => {
    expect(canAdminReply(baseReplyInput)).toBe(true);
    expect(canAdminReply({ ...baseReplyInput, adminRoleType: 1 })).toBe(false);
    expect(canAdminReply({ ...baseReplyInput, adminRoleType: 2 })).toBe(false);
    expect(canAdminReply({ ...baseReplyInput, adminRoleType: 3 })).toBe(false);
    expect(canAdminReply({ ...baseReplyInput, adminRoleType: 8 })).toBe(false);
    expect(canAdminReply({ ...baseReplyInput, adminRoleType: 7 })).toBe(true);
    expect(canAdminReply({ ...baseReplyInput, assignedAdminUserId: '99' })).toBe(false);
    expect(canAdminReply({ ...baseReplyInput, assignedAdminUserId: null })).toBe(false);
    expect(canAdminReply({ ...baseReplyInput, conversationStatus: 3 })).toBe(false);
  });

  it('allows only the documented support conversation state transitions', () => {
    expect(isValidConversationStatusTransition(1, 2)).toBe(true);
    expect(isValidConversationStatusTransition(2, 3)).toBe(true);
    expect(isValidConversationStatusTransition(1, 1)).toBe(true);
    expect(isValidConversationStatusTransition(2, 2)).toBe(true);
    expect(isValidConversationStatusTransition(3, 3)).toBe(true);
    expect(isValidConversationStatusTransition(1, 3)).toBe(false);
    expect(isValidConversationStatusTransition(2, 1)).toBe(false);
    expect(isValidConversationStatusTransition(3, 2)).toBe(false);
  });

  it('builds a stable claim idempotency key', () => {
    expect(supportClaimKeyOf('77', '42')).toBe('support:claim:77:42');
  });
});
