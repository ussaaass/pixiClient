import { describe, expect, it, vi } from 'vitest';
import { SequelizeReferralBindingRepo } from './sequelize-referral.js';

describe('SequelizeReferralBindingRepo.findDirectParentRewardType', () => {
  it('returns null when the player has no active referral binding', async () => {
    const bindingModel = { findOne: vi.fn().mockResolvedValue(null) };
    const userModel = { findByPk: vi.fn() };
    const repo = new SequelizeReferralBindingRepo(bindingModel as never, userModel as never);

    await expect(repo.findDirectParentRewardType('20', { transaction: {} } as never)).resolves.toBeNull();
    expect(userModel.findByPk).not.toHaveBeenCalled();
  });

  it.each([1, 2] as const)('reads the direct parent and returns its reward_type=%s', async (rewardType) => {
    const tx = { transaction: {} };
    const bindingModel = { findOne: vi.fn().mockResolvedValue({ parent1UserId: '10' }) };
    const userModel = { findByPk: vi.fn().mockResolvedValue({ rewardType }) };
    const repo = new SequelizeReferralBindingRepo(bindingModel as never, userModel as never);

    await expect(repo.findDirectParentRewardType('20', tx as never)).resolves.toBe(rewardType);
    expect(bindingModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: '20', status: 1 }, attributes: ['parent1UserId'], transaction: tx.transaction }),
    );
    expect(userModel.findByPk).toHaveBeenCalledWith(
      '10',
      expect.objectContaining({ attributes: ['rewardType'], transaction: tx.transaction }),
    );
  });

  it('fails closed for malformed persisted reward type', async () => {
    const bindingModel = { findOne: vi.fn().mockResolvedValue({ parent1UserId: '10' }) };
    const userModel = { findByPk: vi.fn().mockResolvedValue({ rewardType: 0 }) };
    const repo = new SequelizeReferralBindingRepo(bindingModel as never, userModel as never);

    await expect(repo.findDirectParentRewardType('20', { transaction: {} } as never)).rejects.toThrow(
      'direct parent record or reward_type is missing or invalid',
    );
  });
});
