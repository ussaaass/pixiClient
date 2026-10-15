import { describe, expect, it, vi } from 'vitest';
import { createPlayerEntryApplication, PlayerEntryOutcome } from './player-entry-application';
import { OfflinePlayerIdentityAdapter } from './offline-player-identity-adapter';

describe('player entry application', () => {
  it('reports a missing device credential without pretending to create a session', async () => {
    const app = createPlayerEntryApplication(new OfflinePlayerIdentityAdapter());
    await expect(app.checkCurrentDevice()).resolves.toEqual({
      ok: true,
      value: { source: 'LOCAL_DEMO', outcome: PlayerEntryOutcome.DEVICE_CREDENTIAL_MISSING },
    });
  });

  it('validates password input and reports real login as unavailable until the identity service exists', async () => {
    const identity = new OfflinePlayerIdentityAdapter();
    const login = vi.spyOn(identity, 'passwordLogin');
    const app = createPlayerEntryApplication(identity);

    await expect(app.passwordLogin({ identifier: '  ', password: 'secret' })).resolves.toEqual({ ok: false, code: 'IDENTIFIER_REQUIRED' });
    await expect(app.passwordLogin({ identifier: 'player', password: '' })).resolves.toEqual({ ok: false, code: 'PASSWORD_REQUIRED' });
    await expect(app.passwordLogin({ identifier: 'player', password: 'secret' })).resolves.toMatchObject({
      ok: true,
      value: { source: 'LOCAL_DEMO', outcome: PlayerEntryOutcome.IDENTITY_SERVICE_REQUIRED },
    });
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('validates the encrypted recovery QR and keeps TOTP optional until the identity service requires it', async () => {
    const identity = new OfflinePlayerIdentityAdapter();
    const recover = vi.spyOn(identity, 'recoverAccount');
    const app = createPlayerEntryApplication(identity);
    const valid = { credentialPayload: 'encrypted-credential', credentialPassword: 'secret' };

    await expect(app.recoverAccount({ ...valid, totp: '12345' })).resolves.toEqual({ ok: false, code: 'INVALID_REQUEST' });
    await expect(app.recoverAccount(valid)).resolves.toMatchObject({
      ok: true,
      value: { source: 'LOCAL_DEMO', outcome: PlayerEntryOutcome.IDENTITY_SERVICE_REQUIRED },
    });
    expect(recover).toHaveBeenCalledTimes(1);
  });
});
