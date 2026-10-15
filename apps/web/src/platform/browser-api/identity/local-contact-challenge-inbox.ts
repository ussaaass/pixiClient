import type { ContactChallengeDeliveryPort } from './local-identity-application';

type InboxItem = { userId: string; code: string; expiresAt: string };
const inbox = new Map<string, InboxItem>();

export const localContactChallengeInbox: ContactChallengeDeliveryPort = {
  async deliver(input) {
    const now = new Date().toISOString();
    for (const [challengeId, item] of inbox) if (item.expiresAt <= now) inbox.delete(challengeId);
    while (inbox.size >= 500) inbox.delete(inbox.keys().next().value!);
    inbox.set(input.challengeId, { userId: input.userId, code: input.code, expiresAt: input.expiresAt });
  },
};

export function readLocalContactChallengeCode(userId: string, challengeId: string): string | undefined {
  const item = inbox.get(challengeId);
  if (!item || item.userId !== userId) return undefined;
  if (item.expiresAt <= new Date().toISOString()) { inbox.delete(challengeId); return undefined; }
  return item.code;
}

export function clearLocalContactChallengeInbox(): void {
  inbox.clear();
}
