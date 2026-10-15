import { openBrowserDevelopmentDatabase, type LocalCookie } from './database';
import { arrayBuffer } from './crypto';

const LOCAL_COOKIE_KEY = 'local-cookie-encryption-key';

async function encryptionKey(): Promise<CryptoKey> {
  const database = await openBrowserDevelopmentDatabase();
  const transaction = database.transaction('settings', 'readonly');
  const stored = await transaction.store.get(LOCAL_COOKIE_KEY);
  await transaction.done;
  if (stored?.value instanceof CryptoKey) return stored.value;

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const write = database.transaction('settings', 'readwrite');
  const current = await write.store.get(LOCAL_COOKIE_KEY);
  if (current?.value instanceof CryptoKey) {
    await write.done;
    return current.value;
  }
  await write.store.put({ key: LOCAL_COOKIE_KEY, value: key });
  await write.done;
  return key;
}

async function encrypt(value: string): Promise<Pick<LocalCookie, 'nonce' | 'ciphertext'>> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: arrayBuffer(nonce) }, await encryptionKey(), arrayBuffer(new TextEncoder().encode(value)));
  return { nonce, ciphertext };
}

async function decrypt(cookie: LocalCookie): Promise<string> {
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: arrayBuffer(cookie.nonce) }, await encryptionKey(), cookie.ciphertext);
  return new TextDecoder().decode(plaintext);
}

export async function sealLocalSecret(value: string): Promise<{ nonce: Uint8Array; ciphertext: ArrayBuffer }> {
  return encrypt(value);
}

export async function openLocalSecret(value: { nonce: Uint8Array; ciphertext: ArrayBuffer }): Promise<string> {
  return decrypt({ key: 'player-device', ...value, updatedAt: '' });
}

export class LocalCookieJar {
  async get(key: LocalCookie['key']): Promise<string | undefined> {
    const database = await openBrowserDevelopmentDatabase();
    const transaction = database.transaction('local_cookie_jar', 'readonly');
    const cookie = await transaction.store.get(key);
    await transaction.done;
    return cookie ? decrypt(cookie) : undefined;
  }

  async set(key: LocalCookie['key'], value: string): Promise<void> {
    const encrypted = await encrypt(value);
    const database = await openBrowserDevelopmentDatabase();
    const transaction = database.transaction('local_cookie_jar', 'readwrite');
    await transaction.store.put({ key, ...encrypted, updatedAt: new Date().toISOString() });
    await transaction.done;
  }

  async remove(key: LocalCookie['key']): Promise<void> {
    const database = await openBrowserDevelopmentDatabase();
    const transaction = database.transaction('local_cookie_jar', 'readwrite');
    await transaction.store.delete(key);
    await transaction.done;
  }

  async requestCookieHeader(): Promise<string> {
    const [device, refresh] = await Promise.all([this.get('player-device'), this.get('player-refresh')]);
    return [device && `lg_device=${encodeURIComponent(device)}`, refresh && `lg_refresh=${encodeURIComponent(refresh)}`].filter(Boolean).join('; ');
  }

  async applyLocalSetCookie(value: string | null): Promise<void> {
    if (!value) return;
    let parsed: { device?: string | null; refresh?: string | null };
    try {
      parsed = JSON.parse(value) as typeof parsed;
    } catch {
      throw new Error('INVALID_LOCAL_COOKIE_RESPONSE');
    }
    if (parsed.device === null) await this.remove('player-device');
    else if (parsed.device) await this.set('player-device', parsed.device);
    if (parsed.refresh === null) await this.remove('player-refresh');
    else if (parsed.refresh) await this.set('player-refresh', parsed.refresh);
  }
}
