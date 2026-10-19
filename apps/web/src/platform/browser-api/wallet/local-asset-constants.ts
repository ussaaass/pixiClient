export const LocalAssetType = { COIN: 1, CNY_BALANCE: 2 } as const;
export const LocalAssetOperationType = {
  INITIAL_GIFT: 1,
  COIN_TRANSFER: 2,
  COIN_EXCHANGE: 3,
  COIN_PURCHASE: 4,
  COIN_MARKET_LISTING_HOLD: 5,
  COIN_MARKET_LISTING_RELEASE: 6,
  COIN_MARKET_TRADE_RELEASE: 7,
} as const;
export const LocalAssetHoldStatus = { ACTIVE: 1, CONSUMED: 2, RELEASED: 3 } as const;
export const LocalAssetOperationStatus = { RECORDED: 1 } as const;
