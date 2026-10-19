import type { LocalChallenge, LocalCredential, LocalSession, LocalUser } from '../database';

export interface LocalIdentityRepository {
  nextId(): Promise<string>;
  findUser(userId: string): Promise<LocalUser | undefined>;
  findCredential(credentialId: string): Promise<LocalCredential | undefined>;
  findCredentialByLookup(lookupKey: string): Promise<LocalCredential | undefined>;
  findCredentialBySecretHash(secretHash: string): Promise<LocalCredential | undefined>;
  findCredentialByUserKind(userId: string, kind: LocalCredential['kind']): Promise<LocalCredential | undefined>;
  findCredentialsByUserKind(userId: string, kind: LocalCredential['kind']): Promise<LocalCredential[]>;
  findChallenge(challengeId: string): Promise<LocalChallenge | undefined>;
  createChallenge(challenge: LocalChallenge): Promise<void>;
  recordChallengeFailure(challengeId: string, maxAttempts: number): Promise<boolean>;
  bindVerifiedContact(challenge: LocalChallenge, credential: LocalCredential): Promise<void>;
  replaceContact(credential: LocalCredential): Promise<void>;
  createUserWithCredentials(user: LocalUser, credentials: LocalCredential[]): Promise<void>;
  saveCredential(credential: LocalCredential): Promise<void>;
  savePreparedRecoveryCredential(credential: LocalCredential): Promise<void>;
  saveUsernameAndPasswordCredentials(usernameCredential: LocalCredential, passwordCredential: LocalCredential): Promise<void>;
  replaceActiveRecoveryCredential(userId: string, credential: LocalCredential): Promise<void>;
  activatePreparedRecoveryCredential(userId: string, credentialId: string): Promise<boolean>;
  createSession(session: LocalSession): Promise<void>;
  findSessionByRefreshHash(refreshHash: string): Promise<LocalSession | undefined>;
  saveSession(session: LocalSession): Promise<void>;
  listSessions(userId: string): Promise<LocalSession[]>;
  savePasswordAndRevokeOtherSessions(userId: string, credential: LocalCredential, currentSessionId: string): Promise<void>;
  protectSecret(secret: string): Promise<string>;
  revealSecret(ciphertext: string): Promise<string>;
  enableTotp(challengeId: string, userId: string, credential: LocalCredential, recoveryCredentials: LocalCredential[]): Promise<void>;
  disableTotp(userId: string): Promise<void>;
  replaceTotpRecoveryCodes(userId: string, credentials: LocalCredential[]): Promise<void>;
  consumeLoginTotpChallenge(challengeId: string, userId: string): Promise<boolean>;
  consumeTotpRecoveryCode(userId: string, codeHash: string): Promise<boolean>;
}
