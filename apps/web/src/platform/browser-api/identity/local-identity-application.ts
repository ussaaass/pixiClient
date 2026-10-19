import type { IdentitySettingsResponseDto, LoginChallengeResponseDto, SessionResponseDto } from '@gameing/contracts/identity';
import { RewardType } from '@gameing/contracts/referral';
import type { LocalChallenge, LocalCredential, LocalSession, LocalUser } from '../database';
import { derivePasswordHash, encryptRecoveryQrPayload, randomToken, sha256 } from '../crypto';
import { createTotpRecoveryCodes, createTotpSecret, decodeBase32, encodeBase32, verifyTotp } from './totp';
import { signLocalAccessToken } from '../local-jwt';
import { IndexedDbLocalIdentityRepository } from './indexeddb-local-identity-repository';
import type { LocalIdentityRepository } from './identity-repository';

const ACCESS_TTL_MS = 10 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const DEVICE_COOKIE = 'lg_device';
const REFRESH_COOKIE = 'lg_refresh';

export type LocalIdentityCookieState = { device?: string | null; refresh?: string | null };
export type IdentityUseCaseResult<T> = { data: T; cookies?: LocalIdentityCookieState };

export class IdentityUseCaseError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface ContactChallengeDeliveryPort {
  deliver(input: { userId: string; challengeId: string; contactType: 'EMAIL' | 'PHONE'; contactValue: string; code: string; expiresAt: string }): Promise<void>;
}

async function issueSession(repository: LocalIdentityRepository, user: LocalUser, deviceId: string): Promise<IdentityUseCaseResult<SessionResponseDto>> {
  const now = new Date();
  const sessionId = await repository.nextId();
  const refresh = randomToken();
  const expiresAt = new Date(now.getTime() + ACCESS_TTL_MS).toISOString();
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TTL_MS).toISOString();
  const session: LocalSession = {
    sessionId, userId: user.userId, deviceId, refreshFamilyId: randomToken(18), refreshHash: await sha256(refresh),
    authVersion: user.authVersion, state: 'ACTIVE', createdAt: now.toISOString(), expiresAt, refreshExpiresAt,
  };
  await repository.createSession(session);
  const signed = await signLocalAccessToken({ sub: user.userId, sid: sessionId, did: deviceId, sessionVersion: user.authVersion });
  return {
    data: {
      accessToken: signed.token, tokenType: 'Bearer', expiresAt: signed.expiresAt,
      user: { userId: user.userId, displayName: user.displayName, roleType: user.roleType },
      device: { deviceId, trusted: true },
    },
    cookies: { refresh },
  };
}

export class LocalIdentityApplication {
  constructor(private readonly repository: LocalIdentityRepository, private readonly contactChallengeDelivery?: ContactChallengeDeliveryPort) {}

  static async create(): Promise<LocalIdentityApplication> {
    return new LocalIdentityApplication(await IndexedDbLocalIdentityRepository.create());
  }

  async registerDevice(input: { deviceCode: string }): Promise<IdentityUseCaseResult<SessionResponseDto>> {
    const deviceHash = await sha256(input.deviceCode);
    const existing = await this.repository.findCredentialBySecretHash(deviceHash);
    if (existing?.kind === 'DEVICE' && existing.state === 'ACTIVE') {
      const existingUser = await this.repository.findUser(existing.userId);
      if (existingUser?.status === 'ACTIVE') {
        const issued = await issueSession(this.repository, existingUser, existing.deviceId ?? existing.credentialId);
        return { data: issued.data, cookies: { device: input.deviceCode, ...issued.cookies } };
      }
    }
    const userId = await this.repository.nextId();
    const deviceId = await this.repository.nextId();
    const user: LocalUser = { userId, displayName: `游客${userId.slice(-4)}`, createdAt: new Date().toISOString(), roleType: 1, rewardType: RewardType.RECHARGE_REBATE, status: 'ACTIVE', authVersion: 1 };
    const credential: LocalCredential = { credentialId: await this.repository.nextId(), userId, deviceId, kind: 'DEVICE', lookupKey: deviceHash, secretHash: deviceHash, state: 'ACTIVE' };
    await this.repository.createUserWithCredentials(user, [credential]);
    const issued = await issueSession(this.repository, user, deviceId);
    return { data: issued.data, cookies: { device: input.deviceCode, ...issued.cookies } };
  }

  async hasActiveDevice(deviceCode?: string): Promise<{ available: boolean }> {
    const credential = deviceCode ? await this.repository.findCredentialBySecretHash(await sha256(deviceCode)) : undefined;
    return { available: credential?.kind === 'DEVICE' && credential.state === 'ACTIVE' };
  }

  async loginWithDevice(deviceCode?: string): Promise<IdentityUseCaseResult<SessionResponseDto>> {
    const credential = deviceCode ? await this.repository.findCredentialBySecretHash(await sha256(deviceCode)) : undefined;
    if (!credential || credential.kind !== 'DEVICE' || credential.state !== 'ACTIVE') throw new IdentityUseCaseError(401, 'DEVICE_CREDENTIAL_MISSING', 'This browser has no active device credential.');
    const user = await this.repository.findUser(credential.userId);
    if (!user || user.status !== 'ACTIVE') throw new IdentityUseCaseError(401, 'ACCOUNT_LOCKED', 'This account is unavailable.');
    return issueSession(this.repository, user, credential.deviceId ?? credential.credentialId);
  }

  async loginWithPassword(input: { identifier: string; password: string; challengeId?: string; totp?: string }, deviceCode?: string): Promise<{ data: SessionResponseDto | LoginChallengeResponseDto; cookies?: LocalIdentityCookieState }> {
    const identifier = await this.repository.findCredentialByLookup(input.identifier.trim().normalize('NFC').toLocaleLowerCase());
    const legacyPassword = identifier?.kind === 'PASSWORD' ? identifier : undefined;
    if (!identifier || !['IDENTIFIER', 'PASSWORD'].includes(identifier.kind) || identifier.state !== 'ACTIVE') {
      throw new IdentityUseCaseError(401, 'INVALID_CREDENTIALS', 'The account or password is incorrect.');
    }
    const passwordCredential = legacyPassword ?? await this.repository.findCredentialByUserKind(identifier.userId, 'PASSWORD');
    if (!passwordCredential || passwordCredential.state !== 'ACTIVE' || !passwordCredential.salt || !passwordCredential.secretHash) throw new IdentityUseCaseError(401, 'INVALID_CREDENTIALS', 'The account or password is incorrect.');
    const candidate = await derivePasswordHash(input.password, Uint8Array.from(atob(passwordCredential.salt), (char) => char.charCodeAt(0)));
    if (candidate !== passwordCredential.secretHash) throw new IdentityUseCaseError(401, 'INVALID_CREDENTIALS', 'The account or password is incorrect.');
    const user = await this.repository.findUser(identifier.userId);
    if (!user || user.status !== 'ACTIVE') throw new IdentityUseCaseError(401, 'ACCOUNT_LOCKED', 'This account is unavailable.');
    const totpCredential = await this.repository.findCredentialByUserKind(user.userId, 'TOTP');
    if (totpCredential?.state === 'ACTIVE') {
      if (!input.challengeId) {
        const now = new Date();
        const challengeId = crypto.randomUUID();
        const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
        await this.repository.createChallenge({ challengeId, type: 'LOGIN_TOTP', userId: user.userId, ...(identifier.lookupKey ? { identifierKey: identifier.lookupKey } : {}), state: 'ACTIVE', createdAt: now.toISOString(), expiresAt, failedAttempts: 0 });
        return { data: { challengeId, challengeType: 'TOTP', expiresAt } };
      }
      const challenge = await this.repository.findChallenge(input.challengeId);
      if (!challenge || challenge.type !== 'LOGIN_TOTP' || challenge.userId !== user.userId || challenge.identifierKey !== identifier.lookupKey) throw new IdentityUseCaseError(404, 'CHALLENGE_NOT_FOUND', 'The login verification challenge was not found.');
      if (challenge.state !== 'ACTIVE' || challenge.expiresAt <= new Date().toISOString()) throw new IdentityUseCaseError(410, 'CHALLENGE_EXPIRED', 'The login verification challenge has expired.');
      try {
        await this.requireTotpIfEnabled(user.userId, input.totp);
      } catch (error) {
        if (error instanceof IdentityUseCaseError && error.code === 'TOTP_INVALID') {
          const expired = await this.repository.recordChallengeFailure(input.challengeId, 5);
          if (expired) throw new IdentityUseCaseError(410, 'CHALLENGE_EXPIRED', 'Too many incorrect codes; sign in again.');
        }
        throw error;
      }
      if (!await this.repository.consumeLoginTotpChallenge(input.challengeId, user.userId)) throw new IdentityUseCaseError(410, 'CHALLENGE_EXPIRED', 'The login verification challenge has already been used.');
    }
    const currentDevice = deviceCode ? await this.repository.findCredentialBySecretHash(await sha256(deviceCode)) : undefined;
    const deviceId = currentDevice?.userId === user.userId ? currentDevice.deviceId ?? currentDevice.credentialId : await this.repository.nextId();
    return issueSession(this.repository, user, deviceId);
  }

  async recoverAccount(input: { credentialId: string; recoverySecret: string; totp?: string }): Promise<IdentityUseCaseResult<SessionResponseDto>> {
    const credential = await this.repository.findCredential(input.credentialId);
    if (!credential || credential.kind !== 'RECOVERY') throw new IdentityUseCaseError(401, 'RECOVERY_CREDENTIAL_INVALID', 'The recovery credential is invalid.');
    if (credential.state === 'REPLACED') throw new IdentityUseCaseError(401, 'RECOVERY_CREDENTIAL_REPLACED', 'The recovery credential has been replaced.');
    if (credential.state !== 'ACTIVE' || !credential.secretHash || (credential.expiresAt && credential.expiresAt <= new Date().toISOString())) {
      throw new IdentityUseCaseError(401, 'RECOVERY_CREDENTIAL_INVALID', 'The recovery credential is invalid or expired.');
    }
    if (await sha256(input.recoverySecret) !== credential.secretHash) throw new IdentityUseCaseError(401, 'RECOVERY_CREDENTIAL_INVALID', 'The recovery credential is invalid.');
    const totpCredential = await this.repository.findCredentialByUserKind(credential.userId, 'TOTP');
    if (totpCredential?.state === 'ACTIVE' && !input.totp) throw new IdentityUseCaseError(401, 'TOTP_REQUIRED', 'A current TOTP code is required.');
    if (totpCredential?.state === 'ACTIVE' && (!input.totp || !await this.verifyCurrentTotp(credential.userId, input.totp))) throw new IdentityUseCaseError(401, input.totp ? 'TOTP_INVALID' : 'TOTP_REQUIRED', 'The current TOTP code is required and must be valid.');

    const user = await this.repository.findUser(credential.userId);
    if (!user || user.status !== 'ACTIVE') throw new IdentityUseCaseError(401, 'ACCOUNT_LOCKED', 'This account is unavailable.');
    for (const session of await this.repository.listSessions(user.userId)) {
      if (session.state === 'ACTIVE') await this.repository.saveSession({ ...session, state: 'REVOKED' });
    }
    return issueSession(this.repository, user, await this.repository.nextId());
  }

  async createDevelopmentRecoveryFixture(userId: string): Promise<{ qrPayload: string; qrPassword: string; expiresAt: string }> {
    const user = await this.repository.findUser(userId);
    if (!user || user.status !== 'ACTIVE') throw new IdentityUseCaseError(404, 'ACCOUNT_NOT_FOUND', 'The local test account does not exist.');
    const recoverySecret = randomToken(32);
    const qrPassword = randomToken(18);
    const credentialId = await this.repository.nextId();
    const expiresAt = new Date();
    expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 2);
    const serializedExpiry = expiresAt.toISOString();
    const credential: LocalCredential = { credentialId, userId, kind: 'RECOVERY', secretHash: await sha256(recoverySecret), state: 'ACTIVE', expiresAt: serializedExpiry };
    await this.repository.replaceActiveRecoveryCredential(userId, credential);
    const qrPayload = await encryptRecoveryQrPayload({ formatVersion: 1, credentialId, recoverySecret, expiresAt: serializedExpiry }, qrPassword);
    return { qrPayload, qrPassword, expiresAt: serializedExpiry };
  }

  async prepareRecoveryCredential(userId: string, input: { password: string; totp?: string; recoverySecret: string }): Promise<{ credentialId: string; expiresAt: string }> {
    await this.requireCurrentPassword(userId, input.password);
    await this.requireTotpIfEnabled(userId, input.totp);
    if (input.recoverySecret.length < 32 || input.recoverySecret.length > 128) throw new IdentityUseCaseError(400, 'VALIDATION_FAILED', 'The recovery secret has an invalid length.');

    const secretHash = await sha256(input.recoverySecret);
    const existing = await this.repository.findCredentialBySecretHash(secretHash);
    if (existing?.userId === userId && existing.kind === 'RECOVERY' && existing.state === 'PENDING' && existing.pendingExpiresAt && existing.pendingExpiresAt > new Date().toISOString() && existing.expiresAt) {
      return { credentialId: existing.credentialId, expiresAt: existing.expiresAt };
    }

    const expiresAt = new Date();
    expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 2);
    const serializedExpiry = expiresAt.toISOString();
    const credential: LocalCredential = {
      credentialId: await this.repository.nextId(), userId, kind: 'RECOVERY', secretHash, state: 'PENDING',
      expiresAt: serializedExpiry, pendingExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    await this.repository.savePreparedRecoveryCredential(credential);
    return { credentialId: credential.credentialId, expiresAt: serializedExpiry };
  }

  async activateRecoveryCredential(userId: string, credentialId: string): Promise<IdentitySettingsResponseDto> {
    const credential = await this.repository.findCredential(credentialId);
    if (!credential || credential.userId !== userId || credential.kind !== 'RECOVERY') throw new IdentityUseCaseError(404, 'RECOVERY_CREDENTIAL_NOT_FOUND', 'The staged recovery credential was not found.');
    if (credential.state !== 'PENDING' || !credential.pendingExpiresAt || credential.pendingExpiresAt <= new Date().toISOString() || !credential.expiresAt || credential.expiresAt <= new Date().toISOString()) {
      if (credential.state === 'PENDING') await this.repository.saveCredential({ ...credential, state: 'EXPIRED' });
      throw new IdentityUseCaseError(410, 'RECOVERY_CREDENTIAL_PENDING_EXPIRED', 'The staged recovery credential expired. The current credential remains active.');
    }
    const activated = await this.repository.activatePreparedRecoveryCredential(userId, credentialId);
    if (!activated) throw new IdentityUseCaseError(410, 'RECOVERY_CREDENTIAL_PENDING_EXPIRED', 'The staged recovery credential expired. The current credential remains active.');
    return this.getIdentitySettings(userId);
  }

  async refresh(refreshToken?: string): Promise<IdentityUseCaseResult<SessionResponseDto>> {
    const old = refreshToken ? await this.repository.findSessionByRefreshHash(await sha256(refreshToken)) : undefined;
    if (!old || old.state !== 'ACTIVE' || old.refreshExpiresAt <= new Date().toISOString()) {
      throw new IdentityUseCaseError(401, 'REFRESH_INVALID', 'The session has expired. Please sign in again.');
    }
    const user = await this.repository.findUser(old.userId);
    if (!user || user.status !== 'ACTIVE') throw new IdentityUseCaseError(401, 'ACCOUNT_LOCKED', 'This account is unavailable.');
    await this.repository.saveSession({ ...old, state: 'REVOKED' });
    return issueSession(this.repository, user, old.deviceId);
  }

  async logout(refreshToken?: string): Promise<IdentityUseCaseResult<{ loggedOut: boolean }>> {
    const session = refreshToken ? await this.repository.findSessionByRefreshHash(await sha256(refreshToken)) : undefined;
    if (session) await this.repository.saveSession({ ...session, state: 'REVOKED' });
    return { data: { loggedOut: true }, cookies: { refresh: null } };
  }

  async getIdentitySettings(userId: string): Promise<IdentitySettingsResponseDto> {
    const credentials = await Promise.all((['IDENTIFIER', 'PASSWORD', 'TOTP', 'RECOVERY'] as const).map((kind) => this.repository.findCredentialsByUserKind(userId, kind)));
    const [identifiers = [], passwords = [], totp = [], recovery = []] = credentials;
    const activeRecovery = recovery.find((credential) => credential.state === 'ACTIVE' && (!credential.expiresAt || credential.expiresAt > new Date().toISOString()));
    const emailCredential = identifiers.find((credential) => credential.state === 'ACTIVE' && credential.identifierType === 'EMAIL');
    const phoneCredential = identifiers.find((credential) => credential.state === 'ACTIVE' && credential.identifierType === 'PHONE');
    const usernameCredential = identifiers.find((credential) => credential.state === 'ACTIVE' && credential.identifierType === 'USERNAME')
      ?? passwords.find((credential) => credential.state === 'ACTIVE' && credential.lookupKey && !credential.lookupKey.includes('@') && !/^\+?[0-9]{7,15}$/.test(credential.lookupKey));
    return {
      username: usernameCredential?.displayValue ?? usernameCredential?.lookupKey ?? null,
      email: emailCredential?.lookupKey ? { maskedValue: maskEmail(emailCredential.lookupKey), verified: emailCredential.verified ?? true } : null,
      phone: phoneCredential?.lookupKey ? { maskedValue: maskPhone(phoneCredential.lookupKey), verified: phoneCredential.verified ?? true } : null,
      passwordConfigured: passwords.some((credential) => credential.state === 'ACTIVE'),
      totpEnabled: totp.some((credential) => credential.state === 'ACTIVE'),
      recoveryCredential: { available: Boolean(activeRecovery), expiresAt: activeRecovery?.expiresAt ?? null },
    };
  }

  async startTotpSetup(userId: string, input: { password: string; totp?: string }): Promise<{ setupId: string; otpauthUri: string; expiresAt: string }> {
    await this.requireCurrentPassword(userId, input.password);
    await this.requireTotpIfEnabled(userId, input.totp);
    if ((await this.repository.findCredentialByUserKind(userId, 'TOTP'))?.state === 'ACTIVE') throw new IdentityUseCaseError(409, 'TOTP_ALREADY_ENABLED', 'TOTP is already enabled.');
    const secret = createTotpSecret();
    const setupId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    await this.repository.createChallenge({
      challengeId: setupId, type: 'TOTP_SETUP', userId, secretCiphertext: await this.repository.protectSecret(encodeBase32(secret)),
      state: 'ACTIVE', createdAt: now.toISOString(), expiresAt, failedAttempts: 0,
    });
    const username = (await this.repository.findCredentialsByUserKind(userId, 'IDENTIFIER')).find((item) => item.identifierType === 'USERNAME')?.displayValue ?? userId;
    const issuer = 'Lottery Game';
    const label = `${issuer}:${username}`;
    const otpauthUri = `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeBase32(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    return { setupId, otpauthUri, expiresAt };
  }

  async confirmTotpSetup(userId: string, setupId: string, code: string): Promise<{ enabled: true; recoveryCodes: string[] }> {
    const challenge = await this.repository.findChallenge(setupId);
    if (!challenge || challenge.userId !== userId || challenge.type !== 'TOTP_SETUP') throw new IdentityUseCaseError(404, 'SETUP_NOT_FOUND', 'The TOTP setup was not found.');
    if (challenge.state !== 'ACTIVE' || challenge.expiresAt <= new Date().toISOString() || !challenge.secretCiphertext) throw new IdentityUseCaseError(410, 'SETUP_EXPIRED', 'The TOTP setup has expired. Start again.');
    const encodedSecret = await this.repository.revealSecret(challenge.secretCiphertext);
    const secretBytes = decodeBase32(encodedSecret);
    if (!await verifyTotp(secretBytes, code)) {
      const expired = await this.repository.recordChallengeFailure(setupId, 5);
      throw new IdentityUseCaseError(expired ? 410 : 401, expired ? 'SETUP_EXPIRED' : 'TOTP_INVALID', expired ? 'Too many incorrect codes; start TOTP setup again.' : 'The TOTP code is incorrect.');
    }
    const recoveryCodes = createTotpRecoveryCodes();
    const credential: LocalCredential = {
      credentialId: await this.repository.nextId(), userId, kind: 'TOTP', credentialCiphertext: await this.repository.protectSecret(encodedSecret), state: 'ACTIVE',
    };
    const recoveryCredentials = await Promise.all(recoveryCodes.map(async (codeValue) => ({
      credentialId: await this.repository.nextId(), userId, kind: 'TOTP_RECOVERY' as const,
      lookupKey: `${userId}:totp-recovery:${await sha256(codeValue)}`, secretHash: await sha256(codeValue), state: 'ACTIVE' as const,
    })));
    try {
      await this.repository.enableTotp(setupId, userId, credential, recoveryCredentials);
    } catch (error) {
      if (error instanceof Error && error.message === 'SETUP_EXPIRED') throw new IdentityUseCaseError(410, 'SETUP_EXPIRED', 'The TOTP setup expired or was already confirmed.');
      throw error;
    }
    return { enabled: true, recoveryCodes };
  }

  async disableTotp(userId: string, input: { password: string; code: string }): Promise<{ enabled: false }> {
    await this.requireCurrentPassword(userId, input.password);
    const credential = await this.repository.findCredentialByUserKind(userId, 'TOTP');
    if (credential?.state !== 'ACTIVE' || !credential.credentialCiphertext) throw new IdentityUseCaseError(409, 'TOTP_NOT_ENABLED', 'TOTP is not enabled.');
    const secret = await this.repository.revealSecret(credential.credentialCiphertext);
    if (!await verifyTotp(decodeBase32(secret), input.code)) throw new IdentityUseCaseError(401, 'TOTP_INVALID', 'The TOTP code is incorrect.');
    await this.repository.disableTotp(userId);
    return { enabled: false };
  }

  async rotateTotpRecoveryCodes(userId: string, code: string): Promise<{ enabled: true; recoveryCodes: string[] }> {
    const totpCredential = await this.repository.findCredentialByUserKind(userId, 'TOTP');
    if (totpCredential?.state !== 'ACTIVE' || !totpCredential.credentialCiphertext) throw new IdentityUseCaseError(409, 'TOTP_NOT_ENABLED', 'TOTP is not enabled.');
    const secret = await this.repository.revealSecret(totpCredential.credentialCiphertext);
    if (!await verifyTotp(decodeBase32(secret), code)) throw new IdentityUseCaseError(401, 'TOTP_INVALID', 'The TOTP code is incorrect.');
    const recoveryCodes = createTotpRecoveryCodes();
    const credentials = await Promise.all(recoveryCodes.map(async (codeValue) => ({
      credentialId: await this.repository.nextId(), userId, kind: 'TOTP_RECOVERY' as const,
      lookupKey: `${userId}:totp-recovery:${await sha256(codeValue)}`, secretHash: await sha256(codeValue), state: 'ACTIVE' as const,
    })));
    await this.repository.replaceTotpRecoveryCodes(userId, credentials);
    return { enabled: true, recoveryCodes };
  }

  async setUsername(userId: string, input: { username: string; password: string; totp?: string }): Promise<IdentitySettingsResponseDto> {
    const normalized = input.username.normalize('NFC').trim();
    if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(normalized) || normalized.includes('@')) throw new IdentityUseCaseError(422, 'USERNAME_INVALID', 'Use 3–32 letters, numbers, underscores, or hyphens.');
    const passwordCredential = await this.repository.findCredentialByUserKind(userId, 'PASSWORD');
    if (!passwordCredential?.salt || !passwordCredential.secretHash || passwordCredential.state !== 'ACTIVE') throw new IdentityUseCaseError(401, 'REAUTHENTICATION_FAILED', 'The current password could not be verified.');
    const candidate = await derivePasswordHash(input.password, Uint8Array.from(atob(passwordCredential.salt), (char) => char.charCodeAt(0)));
    if (candidate !== passwordCredential.secretHash) throw new IdentityUseCaseError(401, 'REAUTHENTICATION_FAILED', 'The current password could not be verified.');
    await this.requireTotpIfEnabled(userId, input.totp);
    const lookupKey = normalized.toLocaleLowerCase();
    const existing = await this.repository.findCredentialByLookup(lookupKey);
    if (existing && existing.userId !== userId) throw new IdentityUseCaseError(409, 'IDENTIFIER_ALREADY_USED', 'This username is already in use.');
    if (existing && existing.identifierType !== 'USERNAME' && existing.kind !== 'PASSWORD') throw new IdentityUseCaseError(409, 'IDENTIFIER_ALREADY_USED', 'This username is already in use.');
    const currentUsername = (await this.repository.findCredentialsByUserKind(userId, 'IDENTIFIER')).find((credential) => credential.identifierType === 'USERNAME' && credential.state === 'ACTIVE');
    const usernameRecord: LocalCredential = {
      credentialId: currentUsername?.credentialId ?? existing?.credentialId ?? await this.repository.nextId(),
      userId, kind: 'IDENTIFIER', identifierType: 'USERNAME', lookupKey, displayValue: normalized, state: 'ACTIVE',
    };
    const passwordRecord = { ...passwordCredential };
    delete passwordRecord.lookupKey;
    await this.repository.saveUsernameAndPasswordCredentials(usernameRecord, passwordRecord);
    return this.getIdentitySettings(userId);
  }

  async changePassword(userId: string, sessionId: string, input: { currentPassword?: string; newPassword: string; totp?: string }): Promise<{ changed: boolean }> {
    const stored = await this.repository.findCredentialByUserKind(userId, 'PASSWORD');
    if (stored?.state === 'ACTIVE') {
      if (!input.currentPassword || !stored.salt || !stored.secretHash) throw new IdentityUseCaseError(401, 'REAUTHENTICATION_FAILED', 'The current password could not be verified.');
      const currentSalt = Uint8Array.from(atob(stored.salt), (char) => char.charCodeAt(0));
      if (await derivePasswordHash(input.currentPassword, currentSalt) !== stored.secretHash) throw new IdentityUseCaseError(401, 'REAUTHENTICATION_FAILED', 'The current password could not be verified.');
      if (await derivePasswordHash(input.newPassword, currentSalt) === stored.secretHash) throw new IdentityUseCaseError(409, 'PASSWORD_REUSE', 'Choose a password different from the current one.');
    }
    await this.requireTotpIfEnabled(userId, input.totp);
    const nextSalt = crypto.getRandomValues(new Uint8Array(16));
    const updated: LocalCredential = {
      credentialId: stored?.credentialId ?? await this.repository.nextId(), userId, kind: 'PASSWORD',
      salt: btoa(String.fromCharCode(...nextSalt)),
      secretHash: await derivePasswordHash(input.newPassword, nextSalt), state: 'ACTIVE',
    };
    await this.repository.savePasswordAndRevokeOtherSessions(userId, updated, sessionId);
    return { changed: true };
  }

  async createContactChallenge(userId: string, input: { contactType: 'EMAIL' | 'PHONE'; contactValue: string; password?: string; totp?: string }): Promise<{ challengeId: string; expiresAt: string }> {
    if (!this.contactChallengeDelivery) throw new IdentityUseCaseError(503, 'IDENTITY_STORAGE_UNAVAILABLE', 'The local contact delivery adapter is unavailable.');
    await this.requirePasswordIfConfigured(userId, input.password);
    await this.requireTotpIfEnabled(userId, input.totp);
    const contactValue = input.contactType === 'EMAIL'
      ? input.contactValue.trim().normalize('NFC').toLocaleLowerCase()
      : input.contactValue.trim().replace(/[\s()-]/g, '');
    const valid = input.contactType === 'EMAIL'
      ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactValue)
      : /^\+?[1-9][0-9]{6,14}$/.test(contactValue);
    if (!valid) throw new IdentityUseCaseError(400, 'VALIDATION_FAILED', 'The email address or phone number is invalid.');
    const existing = await this.repository.findCredentialByLookup(contactValue);
    if (existing && (existing.userId !== userId || existing.identifierType !== input.contactType)) throw new IdentityUseCaseError(409, 'IDENTIFIER_ALREADY_USED', 'This email address or phone number is already in use.');

    const challengeId = crypto.randomUUID();
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const code = String(random[0]! % 1_000_000).padStart(6, '0');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const challenge: LocalChallenge = {
      challengeId,
      type: input.contactType === 'EMAIL' ? 'CONTACT_EMAIL' : 'CONTACT_PHONE',
      userId,
      identifierKey: contactValue,
      targetValue: contactValue,
      expectedCodeHash: await sha256(code),
      state: 'ACTIVE',
      createdAt: now.toISOString(),
      expiresAt,
      failedAttempts: 0,
    };
    await this.repository.createChallenge(challenge);
    await this.contactChallengeDelivery.deliver({ userId, challengeId, contactType: input.contactType, contactValue, code, expiresAt });
    return { challengeId, expiresAt };
  }

  async setPhoneContact(userId: string, input: { phone: string; currentPhone?: string; password?: string; totp?: string }): Promise<IdentitySettingsResponseDto> {
    await this.requirePasswordIfConfigured(userId, input.password);
    await this.requireTotpIfEnabled(userId, input.totp);
    const phone = normalizePhone(input.phone);
    if (!/^\+?[1-9][0-9]{6,14}$/.test(phone)) throw new IdentityUseCaseError(400, 'VALIDATION_FAILED', 'The phone number is invalid.');
    const current = await this.repository.findCredentialsByUserKind(userId, 'IDENTIFIER');
    const phoneCredential = current.find((item) => item.identifierType === 'PHONE' && item.state === 'ACTIVE');
    if (phoneCredential) {
      if (!input.currentPhone || normalizePhone(input.currentPhone) !== phoneCredential.lookupKey) throw new IdentityUseCaseError(409, 'CURRENT_PHONE_MISMATCH', 'The current phone number does not match.');
    } else if (input.currentPhone) {
      throw new IdentityUseCaseError(409, 'CURRENT_PHONE_MISMATCH', 'There is no currently bound phone number to replace.');
    }
    const existing = await this.repository.findCredentialByLookup(phone);
    if (existing && (existing.userId !== userId || existing.identifierType !== 'PHONE')) throw new IdentityUseCaseError(409, 'IDENTIFIER_ALREADY_USED', 'This phone number is already in use.');
    const credential: LocalCredential = { credentialId: await this.repository.nextId(), userId, kind: 'IDENTIFIER', identifierType: 'PHONE', lookupKey: phone, verified: false, state: 'ACTIVE' };
    try { await this.repository.replaceContact(credential); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'ConstraintError') throw new IdentityUseCaseError(409, 'IDENTIFIER_ALREADY_USED', 'This phone number is already in use.');
      throw error;
    }
    return this.getIdentitySettings(userId);
  }

  async setEmailContact(userId: string, input: { email: string; currentEmail?: string; password?: string; totp?: string }): Promise<IdentitySettingsResponseDto> {
    await this.requirePasswordIfConfigured(userId, input.password);
    await this.requireTotpIfEnabled(userId, input.totp);
    const email = input.email.trim().normalize('NFC').toLocaleLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new IdentityUseCaseError(400, 'VALIDATION_FAILED', 'The email address is invalid.');
    const identifiers = await this.repository.findCredentialsByUserKind(userId, 'IDENTIFIER');
    const current = identifiers.find((item) => item.identifierType === 'EMAIL' && item.state === 'ACTIVE');
    if (current) {
      const suppliedCurrentEmail = input.currentEmail?.trim().normalize('NFC').toLocaleLowerCase();
      if (!suppliedCurrentEmail || suppliedCurrentEmail !== current.lookupKey) throw new IdentityUseCaseError(409, 'CURRENT_EMAIL_MISMATCH', 'The current email address does not match.');
    } else if (input.currentEmail) {
      throw new IdentityUseCaseError(409, 'CURRENT_EMAIL_MISMATCH', 'There is no currently bound email address to replace.');
    }
    const existing = await this.repository.findCredentialByLookup(email);
    if (existing && (existing.userId !== userId || existing.identifierType !== 'EMAIL')) throw new IdentityUseCaseError(409, 'IDENTIFIER_ALREADY_USED', 'This email address is already in use.');
    const credential: LocalCredential = { credentialId: await this.repository.nextId(), userId, kind: 'IDENTIFIER', identifierType: 'EMAIL', lookupKey: email, verified: false, state: 'ACTIVE' };
    try { await this.repository.replaceContact(credential); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'ConstraintError') throw new IdentityUseCaseError(409, 'IDENTIFIER_ALREADY_USED', 'This email address is already in use.');
      throw error;
    }
    return this.getIdentitySettings(userId);
  }

  async confirmContactChallenge(userId: string, challengeId: string, code: string): Promise<IdentitySettingsResponseDto> {
    const challenge = await this.repository.findChallenge(challengeId);
    if (!challenge || challenge.userId !== userId || !challenge.type.startsWith('CONTACT_')) throw new IdentityUseCaseError(404, 'CHALLENGE_NOT_FOUND', 'The contact verification challenge was not found.');
    if (challenge.state !== 'ACTIVE' || challenge.expiresAt <= new Date().toISOString()) throw new IdentityUseCaseError(410, 'CHALLENGE_EXPIRED', 'The contact verification challenge has expired.');
    if (!challenge.expectedCodeHash || await sha256(code) !== challenge.expectedCodeHash) {
      const expired = await this.repository.recordChallengeFailure(challengeId, 5);
      if (expired) throw new IdentityUseCaseError(410, 'CHALLENGE_EXPIRED', 'Too many incorrect codes; request a new challenge.');
      throw new IdentityUseCaseError(401, 'VERIFICATION_CODE_INVALID', 'The verification code is incorrect.');
    }
    const contactType = challenge.type === 'CONTACT_EMAIL' ? 'EMAIL' : 'PHONE';
    const existing = challenge.targetValue ? await this.repository.findCredentialByLookup(challenge.targetValue) : undefined;
    if (existing && (existing.userId !== userId || existing.identifierType !== contactType)) throw new IdentityUseCaseError(409, 'IDENTIFIER_ALREADY_USED', 'This email address or phone number is already in use.');
    const credential: LocalCredential = {
      credentialId: await this.repository.nextId(), userId, kind: 'IDENTIFIER', identifierType: contactType,
      lookupKey: challenge.targetValue!, verified: true, state: 'ACTIVE',
    };
    try {
      await this.repository.bindVerifiedContact(challenge, credential);
    } catch (error) {
      if (error instanceof Error && error.message === 'CHALLENGE_NOT_ACTIVE') throw new IdentityUseCaseError(410, 'CHALLENGE_EXPIRED', 'The contact verification challenge has already been consumed.');
      if (error instanceof DOMException && error.name === 'ConstraintError') throw new IdentityUseCaseError(409, 'IDENTIFIER_ALREADY_USED', 'This email address or phone number is already in use.');
      throw error;
    }
    return this.getIdentitySettings(userId);
  }

  private async requireCurrentPassword(userId: string, password: string): Promise<void> {
    const credential = await this.repository.findCredentialByUserKind(userId, 'PASSWORD');
    if (!credential || credential.state !== 'ACTIVE' || !credential.salt || !credential.secretHash) throw new IdentityUseCaseError(401, 'REAUTHENTICATION_FAILED', 'A current account password is required.');
    const candidate = await derivePasswordHash(password, Uint8Array.from(atob(credential.salt), (char) => char.charCodeAt(0)));
    if (candidate !== credential.secretHash) throw new IdentityUseCaseError(401, 'REAUTHENTICATION_FAILED', 'The current password could not be verified.');
  }

  private async requirePasswordIfConfigured(userId: string, password?: string): Promise<void> {
    const credential = await this.repository.findCredentialByUserKind(userId, 'PASSWORD');
    if (credential?.state === 'ACTIVE') await this.requireCurrentPassword(userId, password ?? '');
  }

  private async requireTotpIfEnabled(userId: string, code?: string): Promise<void> {
    const credential = await this.repository.findCredentialByUserKind(userId, 'TOTP');
    if (credential?.state !== 'ACTIVE') return;
    if (!code) throw new IdentityUseCaseError(403, 'TOTP_REQUIRED', 'A current TOTP code is required.');
    if (/^[A-Fa-f0-9]{16}$/.test(code)) {
      if (await this.repository.consumeTotpRecoveryCode(userId, await sha256(code.toUpperCase()))) return;
      throw new IdentityUseCaseError(401, 'TOTP_INVALID', 'The TOTP recovery code is incorrect or already used.');
    }
    if (!await this.verifyCurrentTotp(userId, code)) throw new IdentityUseCaseError(401, 'TOTP_INVALID', 'The TOTP code is incorrect.');
  }

  private async verifyCurrentTotp(userId: string, code: string): Promise<boolean> {
    const credential = await this.repository.findCredentialByUserKind(userId, 'TOTP');
    if (!credential?.credentialCiphertext) throw new IdentityUseCaseError(503, 'IDENTITY_STORAGE_UNAVAILABLE', 'The TOTP credential is invalid.');
    const secret = await this.repository.revealSecret(credential.credentialCiphertext);
    return verifyTotp(decodeBase32(secret), code);
  }
}

function maskEmail(value: string): string {
  const [name = '', domain = ''] = value.split('@');
  return `${name.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(name.length - 1, 6)))}@${domain}`;
}

function maskPhone(value: string): string {
  return value.length < 7 ? '•••••••' : `${value.slice(0, 3)}••••${value.slice(-3)}`;
}

function normalizePhone(value: string): string { return value.trim().replace(/[\s()-]/g, ''); }

export function localCookieName(key: 'device' | 'refresh'): string { return key === 'device' ? DEVICE_COOKIE : REFRESH_COOKIE; }
