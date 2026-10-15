export const RewardType = {
  RECHARGE_REBATE: 1,
  CUSTOMER_LOSS_REBATE: 2,
} as const;

export type RewardTypeValue = (typeof RewardType)[keyof typeof RewardType];
