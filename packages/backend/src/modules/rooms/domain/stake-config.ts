import { RoomDomainError, R } from './errors.js';

export interface ShisanshuiStakeConfig {
  readonly coinPerWater: bigint;
  readonly minWaterUnits: bigint;
  readonly maxWaterUnits: bigint;
  readonly maxLossHoldCoins: bigint;
}

export interface ResolvedShisanshuiStake {
  readonly waterUnits: bigint;
  readonly wagerCoins: bigint;
  readonly maxLossHoldCoins: bigint;
}

function positiveInteger(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= 9_223_372_036_854_775_807n ? parsed : null;
}

/** Parse the explicitly published per-tier stake policy; unknown/partial shapes fail closed. */
export function parseShisanshuiStakeConfig(value: unknown): ShisanshuiStakeConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'published Shisanshui stake config is malformed');
  }
  const input = value as Record<string, unknown>;
  const allowedKeys = ['coinPerWater', 'minWaterUnits', 'maxWaterUnits', 'maxLossHoldCoins'];
  if (Object.keys(input).length !== allowedKeys.length || Object.keys(input).some((key) => !allowedKeys.includes(key))) {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'published Shisanshui stake config has unexpected fields');
  }
  const coinPerWater = positiveInteger(input.coinPerWater);
  const minWaterUnits = positiveInteger(input.minWaterUnits);
  const maxWaterUnits = positiveInteger(input.maxWaterUnits);
  const maxLossHoldCoins = positiveInteger(input.maxLossHoldCoins);
  if (
    coinPerWater === null ||
    minWaterUnits === null ||
    maxWaterUnits === null ||
    maxLossHoldCoins === null ||
    minWaterUnits > maxWaterUnits
  ) {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'published Shisanshui stake config has invalid bounds');
  }
  return { coinPerWater, minWaterUnits, maxWaterUnits, maxLossHoldCoins };
}

/** Effective turnover is thirteen stakes, one for each card/player placement unit. */
export function resolveShisanshuiStake(config: ShisanshuiStakeConfig, waterUnitsInput: unknown): ResolvedShisanshuiStake {
  const waterUnits = positiveInteger(waterUnitsInput);
  if (waterUnits === null || waterUnits < config.minWaterUnits || waterUnits > config.maxWaterUnits) {
    throw new RoomDomainError(R.INVALID_SUBMISSION, 'selected water units are outside the published tier range');
  }
  const wagerCoins = config.coinPerWater * waterUnits * 13n;
  if (wagerCoins > 9_223_372_036_854_775_807n || config.maxLossHoldCoins > 9_223_372_036_854_775_807n) {
    throw new RoomDomainError(R.INVALID_SUBMISSION, 'resolved stake exceeds supported coin range');
  }
  return { waterUnits, wagerCoins, maxLossHoldCoins: config.maxLossHoldCoins };
}
