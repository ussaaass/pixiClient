import { openBrowserDevelopmentDatabase } from './database';
import { arrayBuffer, toBase64Url } from './crypto';

const ISSUER = 'lottery-game-browser-dev';
const AUDIENCE = 'player-browser-dev';
const ACCESS_TTL_SECONDS = 600;
const KEY_SETTING = 'local-session-es256-key-pair';

type LocalJwtClaims = {
  iss: string;
  aud: string;
  sub: string;
  sid: string;
  did: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  sessionVersion: number;
  tokenUse: 'access';
};

async function keyPair(): Promise<CryptoKeyPair> {
  const database = await openBrowserDevelopmentDatabase();
  const read = database.transaction('settings', 'readonly');
  const saved = await read.store.get(KEY_SETTING);
  await read.done;
  if (saved?.value && typeof saved.value === 'object' && 'privateKey' in saved.value && 'publicKey' in saved.value) {
    return saved.value as CryptoKeyPair;
  }
  const generated = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const write = database.transaction('settings', 'readwrite');
  const current = await write.store.get(KEY_SETTING);
  if (current?.value && typeof current.value === 'object' && 'privateKey' in current.value && 'publicKey' in current.value) {
    await write.done;
    return current.value as CryptoKeyPair;
  }
  await write.store.put({ key: KEY_SETTING, value: generated });
  await write.done;
  return generated;
}

function encodeJson(value: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export async function signLocalAccessToken(input: Omit<LocalJwtClaims, 'iss' | 'aud' | 'iat' | 'nbf' | 'exp' | 'tokenUse' | 'jti'>): Promise<{ token: string; expiresAt: string }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ACCESS_TTL_SECONDS;
  const claims: LocalJwtClaims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: input.sub,
    sid: input.sid,
    did: input.did,
    jti: crypto.randomUUID(),
    iat: now,
    nbf: now,
    exp: expiresAt,
    sessionVersion: input.sessionVersion,
    tokenUse: 'access',
  };
  const header = encodeJson({ alg: 'ES256', typ: 'JWT' });
  const payload = encodeJson(claims);
  const signedData = new TextEncoder().encode(`${header}.${payload}`);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (await keyPair()).privateKey, arrayBuffer(signedData));
  return { token: `${header}.${payload}.${toBase64Url(new Uint8Array(signature))}`, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

export async function verifyLocalAccessToken(token: string): Promise<LocalJwtClaims | undefined> {
  const [encodedHeader, encodedClaims, encodedSignature, ...extra] = token.split('.');
  if (!encodedHeader || !encodedClaims || !encodedSignature || extra.length > 0) return undefined;
  try {
    const header = JSON.parse(new TextDecoder().decode(decode(encodedHeader))) as { alg?: string; typ?: string };
    const claims = JSON.parse(new TextDecoder().decode(decode(encodedClaims))) as LocalJwtClaims;
    if (header.alg !== 'ES256' || header.typ !== 'JWT') return undefined;
    if (claims.iss !== ISSUER || claims.aud !== AUDIENCE || claims.tokenUse !== 'access') return undefined;
    if (claims.exp <= Date.now() / 1000 || claims.nbf > Date.now() / 1000) return undefined;
    const data = new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`);
    const signature = decode(encodedSignature);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, (await keyPair()).publicKey, arrayBuffer(signature), arrayBuffer(data))) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

function decode(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
