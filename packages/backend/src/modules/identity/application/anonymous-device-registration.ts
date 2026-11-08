import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Static, DeviceRegisterRequestSchema } from '@gameing/contracts/identity';
import type { RegistrationOperationModel } from '../../../infrastructure/database/models/identity.js';
import { CredentialStatus } from '../../../infrastructure/database/models/identity.js';
import { ACCESS_TOKEN_TTL_MS } from '../../../infrastructure/redis/session-store.js';
import { buildNewSession } from '../adapters/redis-session-port.js';
import { toDeviceSession, toPlayerUser } from '../adapters/row-mappers.js';
import { DomainError, I } from '../domain/errors.js';
import { encryptDeviceRegisterReplay, decryptDeviceRegisterReplay } from '../domain/device-register-replay-crypto.js';
import type { Clock } from '../ports/clock.js';
import type { IdentityRepository, Tx } from '../ports/identity-repository.js';
import type { JwtIssuerPort } from '../ports/jwt-port.js';
import type { SessionPort, SessionRecord } from '../ports/session-port.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { WelcomeGiftPort } from '../ports/welcome-gift-port.js';
import type { SessionResult } from './session-result.js';

const OP_PENDING = 1;
const OP_COMPLETED = 2;
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEVICE_CREDENTIAL_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export interface PlayerAssetAccountsPort {
  ensure(userId: string, tx: { transaction: unknown }): Promise<void>;
}

export interface AnonymousDeviceRegistrationInput {
  request: Static<typeof DeviceRegisterRequestSchema>;
  idempotencyKey: string;
  audience: string;
}

interface ReplayBundle {
  sessionResult: SessionResult;
  sessionRecord: SessionRecord;
  deviceCookie: string;
  credentialExpiresAt: string;
}

function requestDigest(request: AnonymousDeviceRegistrationInput['request']): Uint8Array {
  const canonical = JSON.stringify({
    fingerprintVersion: request.fingerprintVersion,
    deviceCode: request.deviceCode,
    deviceSummary: { platform: request.deviceSummary.platform, browser: request.deviceSummary.browser },
  });
  return createHash('sha256').update(canonical, 'utf8').digest();
}

function fingerprintDigest(request: AnonymousDeviceRegistrationInput['request']): Uint8Array {
  return createHash('sha256').update(`device-fingerprint:${request.fingerprintVersion}:${request.deviceCode}`, 'utf8').digest();
}

function platformType(platform: string): number {
  const normalized = platform.toLowerCase();
  if (normalized === 'ios') return 2;
  if (normalized === 'android') return 3;
  if (normalized === 'windows') return 4;
  if (normalized === 'macos') return 5;
  if (normalized === 'linux') return 6;
  return 1;
}

function replayAad(key: string, hash: Uint8Array): string {
  return `device-register:v1:${key}:${Buffer.from(hash).toString('hex')}`;
}

function fromReplay(ciphertext: string, key: string, hash: Uint8Array): ReplayBundle {
  const value: unknown = JSON.parse(decryptDeviceRegisterReplay(ciphertext, replayAad(key, hash)));
  if (typeof value !== 'object' || value === null) throw new Error('invalid registration replay payload');
  const bundle = value as Partial<ReplayBundle>;
  if (
    !bundle.sessionResult ||
    !bundle.sessionRecord ||
    typeof bundle.deviceCookie !== 'string' ||
    typeof bundle.credentialExpiresAt !== 'string'
  ) {
    throw new Error('invalid registration replay payload');
  }
  return bundle as ReplayBundle;
}

/** Anonymous account + device + wallet + welcome-gift provisioning; SQL fact commits before idempotent Redis projection. */
export class AnonymousDeviceRegistrationUseCase {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly accounts: PlayerAssetAccountsPort | null,
    private readonly welcomeGift: WelcomeGiftPort | null,
    private readonly sessions: SessionPort,
    private readonly jwt: JwtIssuerPort,
    private readonly clock: Clock,
  ) {}

  async run(input: AnonymousDeviceRegistrationInput): Promise<ReplayBundle> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/.test(input.idempotencyKey)) {
      throw new DomainError(I.IDENTITY_STORAGE_UNAVAILABLE, 'invalid registration idempotency key');
    }
    const accounts = this.accounts;
    const welcomeGift = this.welcomeGift;
    if (!accounts || !welcomeGift)
      throw new DomainError(I.IDENTITY_STORAGE_UNAVAILABLE, 'registration dependencies unavailable', { retryable: true });
    const hash = requestDigest(input.request);
    const aad = replayAad(input.idempotencyKey, hash);
    // Validate configured encryption key before any durable registration write.
    const probe = encryptDeviceRegisterReplay('probe', aad);
    void probe;

    // Persist the permanent key/hash tombstone independently so later provisioning rollback
    // cannot free the key for a different request. PENDING is safely resumed under row lock.
    const reservation = await this.unitOfWork
      .run(async (scope) => {
        const tx: Tx = { transaction: scope.transaction };
        await this.repo.clearExpiredRegistrationReplay(this.clock.now(), tx);
        const existing = await this.repo.findRegistrationOperation(input.idempotencyKey, tx);
        if (existing) return { existing, inserted: false };
        try {
          await this.repo.insertRegistrationOperation({ idempotencyKey: input.idempotencyKey, requestHash: hash }, tx);
          return { existing: null, inserted: true };
        } catch (error) {
          if (isUniqueViolation(error)) throw new DuplicateRegistrationKeyError();
          throw error;
        }
      })
      .catch(async (error: unknown) => {
        if (!(error instanceof DuplicateRegistrationKeyError) && !isUniqueViolation(error)) throw error;
        const winner = await this.unitOfWork.run(async (scope) => {
          const tx: Tx = { transaction: scope.transaction };
          return this.repo.findRegistrationOperation(input.idempotencyKey, tx);
        });
        if (!winner)
          throw new DomainError(I.IDENTITY_STORAGE_UNAVAILABLE, 'registration reservation is uncertain; retry with same key', {
            retryable: true,
          });
        return { existing: winner, inserted: false };
      });
    if (reservation.existing) {
      const existingHash = Buffer.from(reservation.existing.requestHash);
      if (existingHash.length !== hash.length || !existingHash.equals(Buffer.from(hash))) {
        throw new DomainError(I.IDEMPOTENCY_KEY_REUSED, 'registration idempotency key reused with different request');
      }
      if (reservation.existing.status === OP_COMPLETED) {
        const existingBundle = await this.replayExisting(reservation.existing, input.idempotencyKey, hash, { transaction: undefined });
        // Replay may restore the SQL-committed projection after an uncertain Redis ACK. The
        // Redis Lua fence rejects known revocations and stale authVersion records atomically;
        // it also refuses to overwrite a rotated session with this older record.
        await this.sessions.createSession(existingBundle.sessionRecord, this.clock.now().getTime());
        return existingBundle;
      }
      if (reservation.existing.status !== OP_PENDING) {
        throw new DomainError(I.IDENTITY_STORAGE_UNAVAILABLE, 'registration operation cannot be resumed', { retryable: false });
      }
      // PENDING is a durable reservation, not an in-progress lock. The next SQL transaction
      // locks it; concurrent retries serialize there, and a rolled-back prior attempt is resumed.
    }
    let bundle: ReplayBundle;
    try {
      bundle = await this.unitOfWork.run(async (scope) => {
        const tx: Tx = { transaction: scope.transaction };
        const operation = await this.repo.findRegistrationOperation(input.idempotencyKey, tx);
        if (!operation) throw new DomainError(I.IDENTITY_STORAGE_UNAVAILABLE, 'registration reservation unavailable', { retryable: true });
        if (operation.status === OP_COMPLETED) return this.replayExisting(operation, input.idempotencyKey, hash, tx);
        if (operation.status !== OP_PENDING)
          throw new DomainError(I.IDENTITY_STORAGE_UNAVAILABLE, 'registration operation cannot be resumed', { retryable: false });
        if (tx.transaction == null)
          throw new DomainError(I.IDENTITY_STORAGE_UNAVAILABLE, 'registration requires an active SQL transaction', { retryable: true });
        const now = this.clock.now();
        const credentialExpiresAt = new Date(now.getTime() + DEVICE_CREDENTIAL_LIFETIME_MS);
        const credentialKey = randomUUID();
        const secret = randomBytes(32).toString('base64url');
        const secretDigest = createHash('sha256').update(secret, 'utf8').digest();
        const user = await this.repo.createUser(
          {
            roleType: 1,
            rewardType: 1,
            publicCode: randomBytes(12).toString('base64url'),
            nickname: `Guest${randomBytes(5).toString('hex')}`,
            username: null,
            passwordHash: null,
            passwordSetAt: null,
            email: null,
            emailVerifiedAt: null,
            phone: null,
            phoneVerifiedAt: null,
            totpSecretCiphertext: null,
            totpEnabledAt: null,
            totpLastAcceptedCounter: null,
            totpRecoveryCodeHashes: null,
            authVersion: '1',
            permissions: [],
            lastLoginAt: now,
            assetId: null,
            inviteCode: null,
            inviteCodeExpiresAt: null,
          } as never,
          tx,
        );
        const device = await this.repo.upsertDevice(
          {
            userId: user.id,
            fingerprintHash: fingerprintDigest(input.request),
            deviceDigest: secretDigest,
            credentialKey,
            credentialSecretHash: secretDigest,
            credentialStatus: CredentialStatus.ACTIVE,
            credentialExpiresAt,
            credentialRevokedAt: null,
            platformType: platformType(input.request.deviceSummary.platform),
            lastSeenAt: now,
          },
          tx,
        );
        await accounts.ensure(user.id, { transaction: tx.transaction });
        await welcomeGift.grantWelcomeGift(user.id, tx);
        const sid = randomBytes(18).toString('hex');
        const refreshToken = this.jwt.createRefreshToken();
        const refreshHash = this.jwt.hashRefreshToken(refreshToken);
        const sessionRecord = buildNewSession({
          sessionId: sid,
          userId: user.id,
          principalType: 'PLAYER',
          deviceId: device.id,
          tokenFamily: sid,
          authVersion: user.authVersion ?? '1',
          refreshHash,
          nowMs: now.getTime(),
        });
        const accessToken = await this.jwt.signAccessToken({
          userId: user.id,
          sid,
          deviceId: device.id,
          authVersion: user.authVersion ?? '1',
          audience: input.audience,
          now,
        });
        const sessionResult: SessionResult = {
          accessToken,
          tokenType: 'Bearer',
          expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS).toISOString(),
          user: toPlayerUser(user),
          device: toDeviceSession(device),
          sid,
          refreshToken,
        };
        const replayExpiresAt = new Date(now.getTime() + REPLAY_WINDOW_MS);
        const replayCiphertext = encryptDeviceRegisterReplay(
          JSON.stringify({
            sessionResult,
            sessionRecord,
            deviceCookie: `${credentialKey}.${secret}`,
            credentialExpiresAt: credentialExpiresAt.toISOString(),
          } satisfies ReplayBundle),
          aad,
        );
        const updated = await this.repo.updateRegistrationOperation(
          input.idempotencyKey,
          {
            status: OP_COMPLETED,
            userId: user.id,
            deviceId: device.id,
            sessionId: sid,
            replayCiphertext,
            replayExpiresAt,
          },
          tx,
          OP_PENDING,
        );
        if (updated !== 1) throw new Error('registration operation completion lost a state race');
        await this.repo.updateUser(user.id, { lastLoginAt: now }, tx);
        return {
          sessionResult,
          sessionRecord,
          deviceCookie: `${credentialKey}.${secret}`,
          credentialExpiresAt: credentialExpiresAt.toISOString(),
        };
      });
    } catch (error) {
      // The reservation is committed in a prior transaction. A unique error in this transaction
      // belongs to user/device/wallet/gift facts and must not be misclassified as a key race.
      // SQL rolls those writes back; leaving the tombstone PENDING permits safe same-key retry.
      if (error instanceof DomainError) throw error;
      throw new DomainError(I.IDENTITY_STORAGE_UNAVAILABLE, 'registration SQL provisioning failed; retry with same key', {
        retryable: true,
      });
    }
    // Idempotent SET projection: every retry reuses the exact sid and refresh hash encrypted in SQL.
    await this.sessions.createSession(bundle.sessionRecord, this.clock.now().getTime());
    return bundle;
  }

  private async replayExisting(operation: RegistrationOperationModel, key: string, hash: Uint8Array, _tx: Tx): Promise<ReplayBundle> {
    const existingHash = Buffer.from(operation.requestHash);
    if (existingHash.length !== hash.length || !Buffer.from(existingHash).equals(Buffer.from(hash))) {
      throw new DomainError(I.IDEMPOTENCY_KEY_REUSED, 'registration idempotency key reused with different request');
    }
    if (operation.status !== OP_COMPLETED) {
      throw new DomainError(I.IDENTITY_STORAGE_UNAVAILABLE, 'registration result is still pending; retry with the same key', {
        retryable: true,
      });
    }
    if (!operation.replayCiphertext || !operation.replayExpiresAt) {
      throw new DomainError(I.IDENTITY_STORAGE_UNAVAILABLE, 'registration replay window expired; account recovery is required', {
        retryable: false,
      });
    }
    if (new Date(operation.replayExpiresAt).getTime() <= this.clock.now().getTime()) {
      throw new DomainError(
        I.IDENTITY_STORAGE_UNAVAILABLE,
        'registration replay window expired; retain the original key and contact account recovery',
        { retryable: false },
      );
    }
    try {
      return fromReplay(operation.replayCiphertext, key, hash);
    } catch {
      throw new DomainError(I.IDENTITY_STORAGE_UNAVAILABLE, 'registration replay material unavailable', { retryable: true });
    }
  }

  private async loadReplay(key: string, hash: Uint8Array): Promise<ReplayBundle> {
    return this.unitOfWork.run(async (scope) => {
      const tx = scope as Tx;
      await this.repo.clearExpiredRegistrationReplay(this.clock.now(), tx);
      const operation = await this.repo.findRegistrationOperation(key, tx);
      if (!operation) throw new DomainError(I.IDENTITY_STORAGE_UNAVAILABLE, 'registration operation unavailable', { retryable: true });
      return this.replayExisting(operation, key, hash, tx);
    });
  }
}

class DuplicateRegistrationKeyError extends Error {}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { name?: unknown; parent?: { code?: unknown }; original?: { code?: unknown } };
  return (
    value.name === 'SequelizeUniqueConstraintError' || value.parent?.code === 'ER_DUP_ENTRY' || value.original?.code === 'ER_DUP_ENTRY'
  );
}
