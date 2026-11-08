import { describe, expect, it, vi } from 'vitest';
import { MessageListUseCase } from './message-list.js';
import { S } from '../domain/errors.js';
import type { ConversationRepo, MessageRepo } from '../ports/social-repository.js';

const conversation = {
  id: '77',
  lowUserId: '10',
  highUserId: '42',
} as never;

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: '11',
    messageNo: '13',
    senderUserId: '10',
    messageType: 1,
    bodyText: 'hello',
    assetId: null,
    status: 1,
    createdAt: new Date('2026-11-07T12:00:00.000Z'),
    ...overrides,
  } as never;
}

describe('MessageListUseCase', () => {
  it('rejects nonmembers before querying message rows', async () => {
    const conversationRepo = { findConversationByPk: vi.fn().mockResolvedValue(conversation) } as unknown as ConversationRepo;
    const messageRepo = { listMessagesAfterNo: vi.fn() } as unknown as MessageRepo;
    const useCase = new MessageListUseCase(conversationRepo, messageRepo);

    await expect(useCase.run({ userId: '99', conversationId: '77', afterMessageNo: null }, {})).rejects.toMatchObject({
      code: S.SOCIAL_NOT_CONVERSATION_MEMBER,
    });
    expect(conversationRepo.findConversationByPk).toHaveBeenCalledWith('77', {});
    expect(messageRepo.listMessagesAfterNo).not.toHaveBeenCalled();
  });

  it('queries after the normalized cursor and maps ordered rows to the response DTO', async () => {
    const conversationRepo = { findConversationByPk: vi.fn().mockResolvedValue(conversation) } as unknown as ConversationRepo;
    const tx = { transaction: null };
    const messageRepo = {
      listMessagesAfterNo: vi
        .fn()
        .mockResolvedValue([
          message({ id: '11', messageNo: '13' }),
          message({ id: '12', messageNo: '14', createdAt: '2026-11-07T12:00:01.000Z' }),
        ]),
    } as unknown as MessageRepo;
    const useCase = new MessageListUseCase(conversationRepo, messageRepo);

    const result = await useCase.run({ userId: '42', conversationId: '77', afterMessageNo: '0012' }, tx);

    expect(messageRepo.listMessagesAfterNo).toHaveBeenCalledWith('77', '0012', 50, tx);
    expect(result).toEqual({
      conversationId: '77',
      messages: [
        {
          messageId: '11',
          messageNo: '13',
          senderUserId: '10',
          messageType: 1,
          bodyText: 'hello',
          assetId: null,
          status: 1,
          createdAt: '2026-11-07T12:00:00.000Z',
        },
        {
          messageId: '12',
          messageNo: '14',
          senderUserId: '10',
          messageType: 1,
          bodyText: 'hello',
          assetId: null,
          status: 1,
          createdAt: '2026-11-07T12:00:01.000Z',
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('normalizes an empty cursor to zero and rejects malformed cursors before message query', async () => {
    const conversationRepo = { findConversationByPk: vi.fn().mockResolvedValue(conversation) } as unknown as ConversationRepo;
    const messageRepo = { listMessagesAfterNo: vi.fn().mockResolvedValue([]) } as unknown as MessageRepo;
    const useCase = new MessageListUseCase(conversationRepo, messageRepo);

    await expect(useCase.run({ userId: '10', conversationId: '77', afterMessageNo: '' }, {})).resolves.toMatchObject({
      conversationId: '77',
      messages: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(messageRepo.listMessagesAfterNo).toHaveBeenLastCalledWith('77', '0', 50, {});

    await expect(useCase.run({ userId: '10', conversationId: '77', afterMessageNo: 'not-a-number' }, {})).rejects.toMatchObject({
      code: S.STORAGE_UNAVAILABLE,
    });
    expect(messageRepo.listMessagesAfterNo).toHaveBeenCalledTimes(1);
  });

  it('uses the last message as next cursor when the page is full', async () => {
    const conversationRepo = { findConversationByPk: vi.fn().mockResolvedValue(conversation) } as unknown as ConversationRepo;
    const rows = Array.from({ length: 50 }, (_, index) =>
      message({
        id: String(index + 1),
        messageNo: String(index + 101),
      }),
    );
    const messageRepo = { listMessagesAfterNo: vi.fn().mockResolvedValue(rows) } as unknown as MessageRepo;
    const useCase = new MessageListUseCase(conversationRepo, messageRepo);

    await expect(useCase.run({ userId: '42', conversationId: '77', afterMessageNo: null }, {})).resolves.toMatchObject({
      nextCursor: '150',
      hasMore: true,
    });
    expect(messageRepo.listMessagesAfterNo).toHaveBeenCalledWith('77', '0', 50, {});
  });
});
