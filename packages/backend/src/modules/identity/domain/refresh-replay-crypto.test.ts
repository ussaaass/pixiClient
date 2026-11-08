import { afterEach, describe, expect, it } from 'vitest';
import { decryptReplayToken, encryptReplayToken } from './refresh-replay-crypto.js';

const originalKey = process.env.AUTH_REFRESH_REPLAY_ENCRYPTION_KEY;
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
afterEach(() => {
  if (originalKey === undefined) delete process.env.AUTH_REFRESH_REPLAY_ENCRYPTION_KEY;
  else process.env.AUTH_REFRESH_REPLAY_ENCRYPTION_KEY = originalKey;
});

describe('refresh replay token encryption', () => {
  it('roundtrips ciphertext authenticated to its session and operation', () => {
    process.env.AUTH_REFRESH_REPLAY_ENCRYPTION_KEY = TEST_KEY;
    const encoded = encryptReplayToken('opaque-refresh', 'sid:presented:operation');
    expect(encoded).not.toContain('opaque-refresh');
    expect(decryptReplayToken(encoded, 'sid:presented:operation')).toBe('opaque-refresh');
    expect(() => decryptReplayToken(encoded, 'sid:other:operation')).toThrow();
  });

  it('rejects tampered ciphertext and missing deployment key', () => {
    process.env.AUTH_REFRESH_REPLAY_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    const encoded = encryptReplayToken('opaque-refresh', 'aad');
    const tampered = `${encoded.slice(0, -1)}${encoded.endsWith('A') ? 'B' : 'A'}`;
    expect(() => decryptReplayToken(tampered, 'aad')).toThrow();
    delete process.env.AUTH_REFRESH_REPLAY_ENCRYPTION_KEY;
    expect(() => encryptReplayToken('opaque-refresh', 'aad')).toThrow(/AUTH_REFRESH_REPLAY_ENCRYPTION_KEY/);
  });
});
