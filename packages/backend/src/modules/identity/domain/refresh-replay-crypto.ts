import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_ENV = 'AUTH_REFRESH_REPLAY_ENCRYPTION_KEY';
const VERSION = 'v1';

function encryptionKey(): Buffer {
  const encoded = process.env[KEY_ENV];
  if (!encoded) throw new Error(`${KEY_ENV} is required for refresh replay`);
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error(`${KEY_ENV} must be a base64-encoded 32-byte key`);
  return key;
}

export function encryptReplayToken(token: string, aad: string): string {
  const key = encryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [VERSION, nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptReplayToken(envelope: string, aad: string): string {
  const [version, noncePart, tagPart, ciphertextPart, ...extra] = envelope.split('.');
  if (version !== VERSION || !noncePart || !tagPart || ciphertextPart === undefined || extra.length)
    throw new Error('invalid refresh replay envelope');
  const nonce = Buffer.from(noncePart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const ciphertext = Buffer.from(ciphertextPart, 'base64url');
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error('invalid refresh replay envelope');
  const key = encryptionKey();
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
