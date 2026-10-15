const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function createTotpSecret(byteLength = 20): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(byteLength));
}

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(value: string): Uint8Array {
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const char of value.toUpperCase().replace(/=+$/g, '').replace(/\s/g, '')) {
    const digit = BASE32.indexOf(char);
    if (digit < 0) throw new Error('TOTP_SECRET_INVALID');
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}

export async function generateTotp(secret: Uint8Array, now = Date.now(), stepSeconds = 30): Promise<string> {
  const counter = BigInt(Math.floor(now / (stepSeconds * 1000)));
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, counter, false);
  const key = await crypto.subtle.importKey('raw', copyBuffer(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, copyBuffer(message)));
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function verifyTotp(secret: Uint8Array, code: string, now = Date.now(), window = 1): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  for (let drift = -window; drift <= window; drift += 1) {
    if (await generateTotp(secret, now + drift * 30_000) === code) return true;
  }
  return false;
}

export function createTotpRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  });
}

