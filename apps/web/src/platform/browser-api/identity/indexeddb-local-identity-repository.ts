import { openBrowserDevelopmentDatabase, type BrowserDevelopmentDatabase, type LocalChallenge, type LocalCredential, type LocalSession, type LocalUser } from '../database';
import type { LocalIdentityRepository } from './identity-repository';

export class IndexedDbLocalIdentityRepository implements LocalIdentityRepository {
  constructor(private readonly database: BrowserDevelopmentDatabase) {}

  static async create(): Promise<IndexedDbLocalIdentityRepository> {
    return new IndexedDbLocalIdentityRepository(await openBrowserDevelopmentDatabase());
  }

  async nextId(): Promise<string> {
    const transaction = this.database.transaction('settings', 'readwrite');
    const current = await transaction.store.get('next-id');
    const id = typeof current?.value === 'string' ? BigInt(current.value) : 1n;
    await transaction.store.put({ key: 'next-id', value: (id + 1n).toString() });
    await transaction.done;
    return id.toString();
  }

  findUser(userId: string): Promise<LocalUser | undefined> { return this.database.get('users', userId); }
  findCredential(credentialId: string): Promise<LocalCredential | undefined> { return this.database.get('credentials', credentialId); }
  findCredentialByLookup(lookupKey: string): Promise<LocalCredential | undefined> { return this.database.getFromIndex('credentials', 'by-lookup', lookupKey); }
  findCredentialBySecretHash(secretHash: string): Promise<LocalCredential | undefined> { return this.database.getFromIndex('credentials', 'by-secret-hash', secretHash); }
  findCredentialByUserKind(userId: string, kind: LocalCredential['kind']): Promise<LocalCredential | undefined> { return this.database.getFromIndex('credentials', 'by-user-kind', [userId, kind]); }
  findCredentialsByUserKind(userId: string, kind: LocalCredential['kind']): Promise<LocalCredential[]> { return this.database.getAllFromIndex('credentials', 'by-user-kind', [userId, kind]); }
  findChallenge(challengeId: string): Promise<LocalChallenge | undefined> { return this.database.get('challenges', challengeId); }
  async createChallenge(challenge: LocalChallenge): Promise<void> {
    const transaction = this.database.transaction('challenges', 'readwrite');
    const active = await transaction.store.index('by-user-type').getAll([challenge.userId!, challenge.type]);
    for (const prior of active) {
      if (prior.state === 'ACTIVE') await transaction.store.put({ ...prior, state: 'EXPIRED' });
    }
    await transaction.store.put(challenge);
    await transaction.done;
  }
  async recordChallengeFailure(challengeId: string, maxAttempts: number): Promise<boolean> {
    const transaction = this.database.transaction('challenges', 'readwrite');
    const challenge = await transaction.store.get(challengeId);
    let expired = false;
    if (challenge?.state === 'ACTIVE') {
      const failedAttempts = challenge.failedAttempts + 1;
      expired = failedAttempts >= maxAttempts;
      await transaction.store.put({ ...challenge, failedAttempts, ...(expired ? { state: 'EXPIRED' as const } : {}) });
    }
    await transaction.done;
    return expired;
  }

  async bindVerifiedContact(challenge: LocalChallenge, credential: LocalCredential): Promise<void> {
    const transaction = this.database.transaction(['challenges', 'credentials'], 'readwrite');
    const storedChallenge = await transaction.objectStore('challenges').get(challenge.challengeId);
    if (!storedChallenge || storedChallenge.state !== 'ACTIVE' || storedChallenge.userId !== challenge.userId) {
      throw new Error('CHALLENGE_NOT_ACTIVE');
    }
    const credentials = transaction.objectStore('credentials');
    const current = await credentials.index('by-user-kind').getAll([credential.userId, 'IDENTIFIER']);
    for (const item of current) {
      if (item.state === 'ACTIVE' && item.identifierType === credential.identifierType) {
        const replaced = { ...item, state: 'REPLACED' as const };
        delete replaced.lookupKey;
        delete replaced.displayValue;
        await credentials.put(replaced);
      }
    }
    await credentials.put(credential);
    await transaction.objectStore('challenges').put({ ...storedChallenge, state: 'CONSUMED' });
    await transaction.done;
  }

  async createUserWithCredentials(user: LocalUser, credentials: LocalCredential[]): Promise<void> {
    const transaction = this.database.transaction(['users', 'credentials'], 'readwrite');
    await transaction.objectStore('users').put(user);
    for (const credential of credentials) await transaction.objectStore('credentials').put(credential);
    await transaction.done;
  }

  async saveCredential(credential: LocalCredential): Promise<void> { await this.database.put('credentials', credential); }

  async savePreparedRecoveryCredential(credential: LocalCredential): Promise<void> {
    const transaction = this.database.transaction('credentials', 'readwrite');
    const store = transaction.objectStore('credentials');
    const existing = await store.index('by-user-kind').getAll([credential.userId, 'RECOVERY']);
    for (const item of existing) {
      if (item.state === 'PENDING') await store.put({ ...item, state: 'EXPIRED' });
    }
    await store.put(credential);
    await transaction.done;
  }

  async saveUsernameAndPasswordCredentials(usernameCredential: LocalCredential, passwordCredential: LocalCredential): Promise<void> {
    const transaction = this.database.transaction('credentials', 'readwrite');
    await transaction.store.put(usernameCredential);
    await transaction.store.put(passwordCredential);
    await transaction.done;
  }

  async replaceActiveRecoveryCredential(userId: string, credential: LocalCredential): Promise<void> {
    const transaction = this.database.transaction('credentials', 'readwrite');
    const current = await transaction.store.index('by-user-kind').getAll([userId, 'RECOVERY']);
    for (const item of current) {
      if (item.state === 'ACTIVE') {
        item.state = 'REPLACED';
        await transaction.store.put(item);
      }
    }
    await transaction.store.put(credential);
    await transaction.done;
  }

  async activatePreparedRecoveryCredential(userId: string, credentialId: string): Promise<boolean> {
    const transaction = this.database.transaction('credentials', 'readwrite');
    const store = transaction.objectStore('credentials');
    const prepared = await store.get(credentialId);
    if (!prepared || prepared.userId !== userId || prepared.kind !== 'RECOVERY' || prepared.state !== 'PENDING') {
      await transaction.done;
      return false;
    }
    if (!prepared.pendingExpiresAt || prepared.pendingExpiresAt <= new Date().toISOString()) {
      await store.put({ ...prepared, state: 'EXPIRED' });
      await transaction.done;
      return false;
    }
    const recoveryCredentials = await store.index('by-user-kind').getAll([userId, 'RECOVERY']);
    for (const current of recoveryCredentials) {
      if (current.credentialId !== credentialId && current.state === 'ACTIVE') await store.put({ ...current, state: 'REPLACED' });
    }
    const active = { ...prepared, state: 'ACTIVE' as const };
    delete active.pendingExpiresAt;
    await store.put(active);
    await transaction.done;
    return true;
  }

  async createSession(session: LocalSession): Promise<void> { await this.database.put('sessions', session); }
  findSessionByRefreshHash(refreshHash: string): Promise<LocalSession | undefined> { return this.database.getFromIndex('sessions', 'by-refresh-hash', refreshHash); }
  async saveSession(session: LocalSession): Promise<void> { await this.database.put('sessions', session); }
  listSessions(userId: string): Promise<LocalSession[]> { return this.database.getAllFromIndex('sessions', 'by-user', userId); }

  async savePasswordAndRevokeOtherSessions(userId: string, credential: LocalCredential, currentSessionId: string): Promise<void> {
    const transaction = this.database.transaction(['credentials', 'sessions'], 'readwrite');
    await transaction.objectStore('credentials').put(credential);
    const sessions = await transaction.objectStore('sessions').index('by-user').getAll(userId);
    for (const session of sessions) {
      if (session.sessionId !== currentSessionId && session.state === 'ACTIVE') {
        session.state = 'REVOKED';
        await transaction.objectStore('sessions').put(session);
      }
    }
    await transaction.done;
  }

  async protectSecret(secret: string): Promise<string> {
    const key = await this.localSecretKey();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode('LG-LOCAL-IDENTITY-SECRET-V1') }, key, new TextEncoder().encode(secret));
    return `${toBase64Url(nonce)}.${toBase64Url(new Uint8Array(ciphertext))}`;
  }

  async revealSecret(value: string): Promise<string> {
    const [noncePart, ciphertextPart] = value.split('.');
    if (!noncePart || !ciphertextPart) throw new Error('LOCAL_SECRET_INVALID');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: copyBuffer(fromBase64Url(noncePart)), additionalData: new TextEncoder().encode('LG-LOCAL-IDENTITY-SECRET-V1') }, await this.localSecretKey(), copyBuffer(fromBase64Url(ciphertextPart)));
    return new TextDecoder().decode(plaintext);
  }

  async enableTotp(challengeId: string, userId: string, credential: LocalCredential, recoveryCredentials: LocalCredential[]): Promise<void> {
    const transaction = this.database.transaction(['challenges', 'credentials'], 'readwrite');
    const challenge = await transaction.objectStore('challenges').get(challengeId);
    if (!challenge || challenge.userId !== userId || challenge.type !== 'TOTP_SETUP' || challenge.state !== 'ACTIVE' || challenge.expiresAt <= new Date().toISOString()) throw new Error('SETUP_EXPIRED');
    const credentials = transaction.objectStore('credentials');
    for (const existing of await credentials.index('by-user-kind').getAll([userId, 'TOTP'])) {
      if (existing.state === 'ACTIVE') await credentials.put({ ...existing, state: 'REVOKED' });
    }
    for (const existing of await credentials.index('by-user-kind').getAll([userId, 'TOTP_RECOVERY'])) {
      if (existing.state === 'ACTIVE') await credentials.put({ ...existing, state: 'REVOKED' });
    }
    await credentials.put(credential);
    for (const item of recoveryCredentials) await credentials.put(item);
    await transaction.objectStore('challenges').put({ ...challenge, state: 'CONSUMED' });
    await transaction.done;
  }

  async disableTotp(userId: string): Promise<void> {
    const transaction = this.database.transaction('credentials', 'readwrite');
    const credentials = transaction.objectStore('credentials');
    for (const kind of ['TOTP', 'TOTP_RECOVERY'] as const) {
      for (const credential of await credentials.index('by-user-kind').getAll([userId, kind])) {
        if (credential.state === 'ACTIVE') await credentials.put({ ...credential, state: 'REVOKED' });
      }
    }
    await transaction.done;
  }

  async replaceTotpRecoveryCodes(userId: string, recoveryCredentials: LocalCredential[]): Promise<void> {
    const transaction = this.database.transaction('credentials', 'readwrite');
    const credentials = transaction.objectStore('credentials');
    for (const existing of await credentials.index('by-user-kind').getAll([userId, 'TOTP_RECOVERY'])) {
      if (existing.state === 'ACTIVE') await credentials.put({ ...existing, state: 'REVOKED' });
    }
    for (const item of recoveryCredentials) await credentials.put(item);
    await transaction.done;
  }

  async consumeLoginTotpChallenge(challengeId: string, userId: string): Promise<boolean> {
    const transaction = this.database.transaction('challenges', 'readwrite');
    const store = transaction.objectStore('challenges');
    const challenge = await store.get(challengeId);
    const valid = !!challenge && challenge.userId === userId && challenge.type === 'LOGIN_TOTP' && challenge.state === 'ACTIVE' && challenge.expiresAt > new Date().toISOString();
    if (valid) await store.put({ ...challenge!, state: 'CONSUMED' });
    await transaction.done;
    return valid;
  }

  async consumeTotpRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    const transaction = this.database.transaction('credentials', 'readwrite');
    const store = transaction.objectStore('credentials');
    const matches = await store.index('by-secret-hash').getAll(codeHash);
    const credential = matches.find((item) => item.userId === userId && item.kind === 'TOTP_RECOVERY' && item.state === 'ACTIVE');
    if (credential) await store.put({ ...credential, state: 'REVOKED' });
    await transaction.done;
    return Boolean(credential);
  }

  private async localSecretKey(): Promise<CryptoKey> {
    const existing = await this.database.get('settings', 'local-identity-secret-key');
    if (existing?.value && typeof existing.value === 'object' && 'algorithm' in existing.value && 'usages' in existing.value) return existing.value as CryptoKey;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    try {
      await this.database.add('settings', { key: 'local-identity-secret-key', value: key });
      return key;
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'ConstraintError') throw error;
      const winner = await this.database.get('settings', 'local-identity-secret-key');
      if (winner?.value && typeof winner.value === 'object' && 'algorithm' in winner.value && 'usages' in winner.value) return winner.value as CryptoKey;
      throw new Error('IDENTITY_STORAGE_UNAVAILABLE');
    }
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
