import { describe, expect, it } from 'vitest';
import { R } from './errors.js';
import { parseShisanshuiStakeConfig, resolveShisanshuiStake } from './stake-config.js';

const valid = { coinPerWater: '2', minWaterUnits: '1', maxWaterUnits: '5', maxLossHoldCoins: '100' };

describe('published Shisanshui stake policy', () => {
  it('resolves wager turnover from configured coin-per-water and selected units while keeping max-loss separate', () => {
    const config = parseShisanshuiStakeConfig(valid);
    expect(resolveShisanshuiStake(config, '3')).toEqual({ waterUnits: 3n, wagerCoins: 78n, maxLossHoldCoins: 100n });
  });

  it.each(['0', '01', '6', '-1', '1.5', 2, '9999999999999999999'])('rejects an invalid or out-of-tier unit selection %s', (waterUnits) => {
    const config = parseShisanshuiStakeConfig(valid);
    expect(() => resolveShisanshuiStake(config, waterUnits)).toThrow(expect.objectContaining({ code: R.INVALID_SUBMISSION }));
  });

  it.each([
    {},
    { ...valid, extra: '1' },
    { ...valid, coinPerWater: '0' },
    { ...valid, minWaterUnits: '6', maxWaterUnits: '5' },
    { ...valid, maxLossHoldCoins: '9223372036854775808' },
    null,
    [],
  ])('fails closed on absent, malformed, or unexpected published policy %o', (config) => {
    expect(() => parseShisanshuiStakeConfig(config)).toThrow(expect.objectContaining({ code: R.STORAGE_UNAVAILABLE }));
  });
});
