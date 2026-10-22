import { RewardType, type RewardTypeValue } from '@gameing/contracts/referral';

export interface SocialAccessRepositoryPort {
  directParentRewardType(userId: string): Promise<RewardTypeValue | null>;
}

export class SocialAccessPolicy {
  constructor(private readonly repository: SocialAccessRepositoryPort) {}

  async canUse(userId: string): Promise<boolean> {
    const parentRewardType = await this.repository.directParentRewardType(userId);
    return parentRewardType !== RewardType.CUSTOMER_LOSS_REBATE;
  }
}
