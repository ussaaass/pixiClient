import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAdminSession, currentAdminToken, hasAdminSession, saveAdminSession } from './admin-auth.js';

describe('admin-auth session storage', () => {
  afterEach(() => {
    clearAdminSession();
    vi.restoreAllMocks();
  });

  it('stores the access token at the key consumed by remote workspace adapters', () => {
    saveAdminSession({ accessToken: 'jwt.admin', sessionKey: 'sid-1', adminUserId: '42' });

    expect(sessionStorage.getItem('admin.accessToken')).toBe('jwt.admin');
    expect(currentAdminToken()).toBe('jwt.admin');
    expect(sessionStorage.getItem('admin.sessionKey')).toBe('sid-1');
    expect(sessionStorage.getItem('admin.userId')).toBe('42');
    expect(hasAdminSession()).toBe(true);
  });

  it('clears all Admin session keys on logout / unauthorized response', () => {
    saveAdminSession({ accessToken: 'jwt.admin', sessionKey: 'sid-1', adminUserId: '42' });
    clearAdminSession();

    expect(currentAdminToken()).toBeNull();
    expect(sessionStorage.getItem('admin.sessionKey')).toBeNull();
    expect(sessionStorage.getItem('admin.userId')).toBeNull();
    expect(hasAdminSession()).toBe(false);
  });
});
