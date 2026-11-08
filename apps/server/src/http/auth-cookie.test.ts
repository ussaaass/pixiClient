import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthCookies, parseDeviceCredentialCookie } from './auth.routes.js';

describe('auth cookie parsing', () => {
  it('extracts sid and refresh token', () => {
    assert.deepEqual(parseAuthCookies('sid=abc; refresh_token=def'), { sid: 'abc', refreshToken: 'def' });
  });

  it('rejects duplicated sensitive cookies instead of selecting ambiguously', () => {
    assert.deepEqual(parseAuthCookies('sid=first; sid=second; refresh_token=token'), { sid: null, refreshToken: null });
    assert.deepEqual(parseAuthCookies('sid=first; refresh_token=a; refresh_token=b'), { sid: null, refreshToken: null });
  });

  it('parses one key.secret device cookie and rejects malformed or duplicate values', () => {
    const secret = 'secret-value-0123456789abcdef'.repeat(2);
    assert.deepEqual(parseDeviceCredentialCookie(`device=credential-key-123456.${secret}`), {
      credentialKey: 'credential-key-123456',
      secret,
    });
    assert.equal(parseDeviceCredentialCookie(''), null);
    assert.equal(parseDeviceCredentialCookie(`device=credential-key-123456.${secret}; device=credential-key-123456.${secret}`), null);
    assert.equal(parseDeviceCredentialCookie('device=credential-key-123456.short'), null);
    assert.equal(parseDeviceCredentialCookie('device=legacy-device-code'), null);
  });

  it('treats missing or empty credentials as absent', () => {
    assert.deepEqual(parseAuthCookies('sid=; refresh_token='), { sid: null, refreshToken: null });
    assert.deepEqual(parseAuthCookies('other=value'), { sid: null, refreshToken: null });
  });
});
