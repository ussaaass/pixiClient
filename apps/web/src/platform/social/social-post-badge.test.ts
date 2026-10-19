import { describe, expect, it } from 'vitest';
import { countUnseenSocialPosts, latestSocialPostCursor, readSocialPostCursor, saveSocialPostCursor, type SocialPostBadgeRecord, type SocialPostBadgeStorage } from './social-post-badge';

const now = Date.parse('2026-10-17T12:00:00.000Z');
const records: SocialPostBadgeRecord[] = [
  { postId: '12', createdAt: '2026-10-17T11:00:00.000Z', status: 'PUBLISHED' },
  { postId: '13', createdAt: '2026-10-17T11:00:00.000Z', status: 'PUBLISHED' },
  { postId: '14', createdAt: '2026-10-16T11:00:00.000Z', status: 'PUBLISHED' },
  { postId: '15', createdAt: '2026-10-17T11:30:00.000Z', status: 'HIDDEN' },
];

function memoryStorage(): SocialPostBadgeStorage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

describe('social post badge cursor', () => {
  it('shows published posts in the initial 24-hour window and ignores hidden posts', () => {
    expect(countUnseenSocialPosts(records, null, now)).toBe(2);
  });

  it('counts only posts newer than the last visited cursor, including same-time id ordering', () => {
    expect(countUnseenSocialPosts(records, { createdAt: '2026-10-17T11:00:00.000Z', postId: '12' }, now)).toBe(1);
  });

  it('stores a per-user cursor and identifies the newest published post', () => {
    const storage = memoryStorage();
    const latest = latestSocialPostCursor(records);
    expect(latest).toEqual({ createdAt: '2026-10-17T11:00:00.000Z', postId: '13' });
    saveSocialPostCursor('42', latest!, storage);
    expect(readSocialPostCursor('42', storage)).toEqual(latest);
    expect(readSocialPostCursor('43', storage)).toBeNull();
  });
});
