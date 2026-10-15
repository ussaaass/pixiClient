import { describe, expect, it } from 'vitest';
import { simulateShisanshui } from './simulation.js';

describe('shisanshui math preview', () => {
  it('is reproducible for the same seed and reports strategy caveats', async () => {
    const first = await simulateShisanshui({ runs: 1000, seed: 'preview-seed' });
    const second = await simulateShisanshui({ runs: 1000, seed: 'preview-seed' });
    expect(first).toEqual(second);
    expect(first.distribution.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(1000);
    expect(first.theoreticalRtp).toBeNull();
    expect(first.warnings.length).toBeGreaterThan(0);
  });

  it('rejects an empty seed', async () => {
    await expect(simulateShisanshui({ runs: 1000, seed: ' ' })).rejects.toThrow('INVALID_SEED');
  });
});
