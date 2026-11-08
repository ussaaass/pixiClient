import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TicketClaimUseCase } from './ticket-claim.js';
import { SUP } from '../domain/errors.js';

test('TicketClaimUseCase rejects roles without ADMIN bit before repository mutation', async () => {
  let claimCalls = 0;
  const repo = {
    lockConversation: async () => ({ id: '10', status: 1, assignedAdminUserId: null }),
    claimConversation: async () => {
      claimCalls += 1;
      return { inserted: true, conversation: { id: '10', status: 1, assignedAdminUserId: '42' } };
    },
  } as never;
  const useCase = new TicketClaimUseCase(repo);

  for (const adminRoleType of [1, 2, 3, 8]) {
    await assert.rejects(
      useCase.run({ conversationId: '10', adminUserId: '42', adminRoleType, tx: {} }),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === SUP.SUPPORT_NOT_ASSIGNED,
    );
  }
  assert.equal(claimCalls, 0);
});

test('TicketClaimUseCase permits an ADMIN role to claim through the repository', async () => {
  let claimCalls = 0;
  const repo = {
    lockConversation: async () => ({ id: '10', status: 1, assignedAdminUserId: null }),
    claimConversation: async () => {
      claimCalls += 1;
      return { inserted: true, conversation: { id: '10', status: 1, assignedAdminUserId: '42' } };
    },
  } as never;
  const useCase = new TicketClaimUseCase(repo);

  const result = await useCase.run({ conversationId: '10', adminUserId: '42', adminRoleType: 4, tx: {} });

  assert.deepEqual(result, {
    conversationId: '10',
    assignedAdminUserId: '42',
    status: 1,
    inserted: true,
  });
  assert.equal(claimCalls, 1);
});
