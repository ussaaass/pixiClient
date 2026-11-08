import { describe, expect, it, vi } from 'vitest';
import { Op } from 'sequelize';
import { SequelizeIdentityRepository } from './sequelize-identity-repository.js';

describe('SequelizeIdentityRepository registration replay invalidation', () => {
  it('clears encrypted replay material only for the revoked session', async () => {
    const update = vi.fn(async () => [2]);
    const registrationOperationModel = { update };
    const repo = new SequelizeIdentityRepository({
      UserModel: {} as never,
      DeviceModel: {} as never,
      RecoveryCredentialModel: {} as never,
      UserSecurityEventModel: {} as never,
      RegistrationOperationModel: registrationOperationModel as never,
    });

    await expect(repo.clearRegistrationReplayForSession('sid-1', { transaction: null })).resolves.toBe(2);
    expect(update).toHaveBeenCalledWith(
      { replayCiphertext: null, replayExpiresAt: null },
      {
        where: { sessionId: 'sid-1', replayCiphertext: { [Op.ne]: null } },
        transaction: expect.any(Object),
      },
    );
  });
});
