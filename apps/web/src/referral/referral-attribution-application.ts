import { ReferralBindingStatus } from '@gameing/contracts/invite-agent';

export const DEFAULT_REFERRAL_CANDIDATE_TTL_SECONDS = 900;
const MIN_REFERRAL_CANDIDATE_TTL_SECONDS = 60;
const MAX_REFERRAL_CANDIDATE_TTL_SECONDS = 86_400;

export type ReferralCandidate = { inviteCode: string; expiresAt: string };
export type ReferralBinding = { userId: string; parent1UserId: string; parent2UserId?: string; parent3UserId?: string; parent4UserId?: string; createdAt: string; status: (typeof ReferralBindingStatus)[keyof typeof ReferralBindingStatus] };
export type ReferralInviter = { userId: string; inviteCodeExpiresAt?: string };

export interface ReferralAttributionRepository {
  candidateTtlConfig(): Promise<string | undefined>;
  findInviter(inviteCode: string): Promise<ReferralInviter | undefined>;
  saveCandidate(candidate: ReferralCandidate): Promise<void>;
  findCandidate(): Promise<ReferralCandidate | undefined>;
  findBinding(userId: string): Promise<ReferralBinding | undefined>;
  saveBinding(binding: ReferralBinding): Promise<void>;
}

export class ReferralAttributionApplication {
  constructor(private readonly repository: ReferralAttributionRepository) {}

  async capture(inviteCode: string, now = new Date()): Promise<{ captured: boolean; expiresAt: string | null }> {
    const inviter = await this.repository.findInviter(inviteCode);
    if (!inviter?.inviteCodeExpiresAt || inviter.inviteCodeExpiresAt <= now.toISOString()) return { captured: false, expiresAt: null };
    const configuredTtl = Number(await this.repository.candidateTtlConfig());
    const ttl = Number.isSafeInteger(configuredTtl) && configuredTtl >= MIN_REFERRAL_CANDIDATE_TTL_SECONDS && configuredTtl <= MAX_REFERRAL_CANDIDATE_TTL_SECONDS
      ? configuredTtl
      : DEFAULT_REFERRAL_CANDIDATE_TTL_SECONDS;
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
    await this.repository.saveCandidate({ inviteCode, expiresAt });
    return { captured: true, expiresAt };
  }

  async bindCurrentCandidate(userId: string, now = new Date()): Promise<void> {
    if (await this.repository.findBinding(userId)) return;
    const candidate = await this.repository.findCandidate();
    if (!candidate || candidate.expiresAt <= now.toISOString()) return;
    const inviter = await this.repository.findInviter(candidate.inviteCode);
    if (!inviter?.inviteCodeExpiresAt || inviter.inviteCodeExpiresAt <= now.toISOString() || inviter.userId === userId) return;
    const ancestors = await this.repository.findBinding(inviter.userId);
    const parentIds = [inviter.userId, ancestors?.parent1UserId, ancestors?.parent2UserId, ancestors?.parent3UserId].filter((value): value is string => Boolean(value));
    if (parentIds.includes(userId)) return;
    await this.repository.saveBinding({
      userId,
      parent1UserId: parentIds[0]!,
      ...(parentIds[1] ? { parent2UserId: parentIds[1] } : {}),
      ...(parentIds[2] ? { parent3UserId: parentIds[2] } : {}),
      ...(parentIds[3] ? { parent4UserId: parentIds[3] } : {}),
      createdAt: now.toISOString(),
      status: ReferralBindingStatus.ACTIVE,
    });
  }
}
