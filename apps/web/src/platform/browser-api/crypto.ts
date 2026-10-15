export function toBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomToken(byteLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer(new TextEncoder().encode(value)));
  return toBase64Url(new Uint8Array(digest));
}

export async function derivePasswordHash(password: string, salt: Uint8Array): Promise<string> {
  const baseKey = await crypto.subtle.importKey('raw', arrayBuffer(new TextEncoder().encode(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: arrayBuffer(salt), iterations: 600_000, hash: 'SHA-256' }, baseKey, 256);
  return toBase64Url(new Uint8Array(bits));
}

const RECOVERY_AAD = new TextEncoder().encode('LOTTERY-GAME-RECOVERY-V1');

type RecoveryQrPayload = {
  formatVersion: 1;
  credentialId: string;
  recoverySecret: string;
  expiresAt: string;
};

export async function encryptRecoveryQrPayload(payload: RecoveryQrPayload, password: string): Promise<string> {
  if (password.length < 8) throw new Error('RECOVERY_PASSWORD_TOO_SHORT');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey('raw', arrayBuffer(new TextEncoder().encode(password)), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: arrayBuffer(salt), iterations: 600_000, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: arrayBuffer(nonce), additionalData: arrayBuffer(RECOVERY_AAD), tagLength: 128 }, key, arrayBuffer(new TextEncoder().encode(JSON.stringify(payload))));
  return `LGRC1.${toBase64Url(salt)}.${toBase64Url(nonce)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptRecoveryQrPayload(encoded: string, password: string): Promise<RecoveryQrPayload> {
  const [format, encodedSalt, encodedNonce, encodedCiphertext, ...extra] = encoded.trim().split('.');
  if (format !== 'LGRC1' || !encodedSalt || !encodedNonce || !encodedCiphertext || extra.length > 0 || encoded.length > 4096) throw new Error('RECOVERY_QR_INVALID');
  const salt = fromBase64Url(encodedSalt);
  const nonce = fromBase64Url(encodedNonce);
  const ciphertext = fromBase64Url(encodedCiphertext);
  if (salt.length !== 16 || nonce.length !== 12 || ciphertext.length < 17) throw new Error('RECOVERY_QR_INVALID');
  const baseKey = await crypto.subtle.importKey('raw', arrayBuffer(new TextEncoder().encode(password)), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: arrayBuffer(salt), iterations: 600_000, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: arrayBuffer(nonce), additionalData: arrayBuffer(RECOVERY_AAD), tagLength: 128 }, key, arrayBuffer(ciphertext));
  const value: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (!value || typeof value !== 'object') throw new Error('RECOVERY_QR_INVALID');
  const payload = value as Partial<RecoveryQrPayload>;
  if (payload.formatVersion !== 1 || typeof payload.credentialId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(payload.credentialId) || typeof payload.recoverySecret !== 'string' || payload.recoverySecret.length < 32 || typeof payload.expiresAt !== 'string' || Number.isNaN(Date.parse(payload.expiresAt))) throw new Error('RECOVERY_QR_INVALID');
  return payload as RecoveryQrPayload;
}

export function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer as ArrayBuffer;
}

export async function equalHash(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  return a === b;
}
