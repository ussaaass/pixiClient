import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_ENV = 'AUTH_DEVICE_REGISTER_REPLAY_ENCRYPTION_KEY';
const VERSION = 'v1';

function encryptionKey(): Buffer {
  const encoded = process.env[KEY_ENV];
  if (!encoded) throw new Error(`${KEY_ENV} is required for device registration replay`);
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new Error(`${KEY_ENV} must be a canonical base64-encoded 32-byte key`);
  }
  return key;
}

/** AES-256-GCM protects the short-lived replay bundle; AAD binds it to operation + payload. */
export function encryptDeviceRegisterReplay(plaintext: string, aad: string): string {
  const key = encryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptDeviceRegisterReplay(envelope: string, aad: string): string {
  const [version, noncePart, tagPart, ciphertextPart, ...extra] = envelope.split('.');
  if (version !== VERSION || !noncePart || !tagPart || ciphertextPart === undefined || extra.length > 0) {
    throw new Error('invalid device registration replay envelope');
  }
  const nonce = Buffer.from(noncePart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const ciphertext = Buffer.from(ciphertextPart, 'base64url');
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error('invalid device registration replay envelope');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
