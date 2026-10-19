import type { SocialPostDto } from '@gameing/contracts/social';

export interface SocialPostReadCursor {
  createdAt: string;
  postId: string;
}

export interface SocialPostBadgeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export type SocialPostBadgeRecord = Pick<SocialPostDto, 'postId' | 'createdAt' | 'status'>;

const INITIAL_POST_WINDOW_MS = 24 * 60 * 60 * 1000;

function storageKey(userId: string): string {
  return `lg.social.posts.last-seen.${userId}`;
}

export function readSocialPostCursor(userId: string, storage?: SocialPostBadgeStorage): SocialPostReadCursor | null {
  try {
    const value = (storage ?? globalThis.localStorage).getItem(storageKey(userId));
    if (!value) return null;
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || !('createdAt' in parsed) || !('postId' in parsed)) return null;
    if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt))) return null;
    if (typeof parsed.postId !== 'string' || !parsed.postId) return null;
    return { createdAt: parsed.createdAt, postId: parsed.postId };
  } catch {
    return null;
  }
}

export function latestSocialPostCursor(posts: readonly SocialPostBadgeRecord[]): SocialPostReadCursor | null {
  const latest = posts
    .filter((post) => post.status === 'PUBLISHED')
    .reduce<SocialPostBadgeRecord | null>((current, post) => !current || compareSocialPostCursor(post, current) > 0 ? post : current, null);
  return latest ? { createdAt: latest.createdAt, postId: latest.postId } : null;
}

export function countUnseenSocialPosts(
  posts: readonly SocialPostBadgeRecord[],
  cursor: SocialPostReadCursor | null,
  now = Date.now(),
): number {
  if (cursor) return posts.filter((post) => post.status === 'PUBLISHED' && compareSocialPostCursor(post, cursor) > 0).length;
  const initialWindowStart = now - INITIAL_POST_WINDOW_MS;
  return posts.filter((post) => post.status === 'PUBLISHED' && Date.parse(post.createdAt) >= initialWindowStart).length;
}

export function saveSocialPostCursor(userId: string, cursor: SocialPostReadCursor, storage?: SocialPostBadgeStorage): void {
  try { (storage ?? globalThis.localStorage).setItem(storageKey(userId), JSON.stringify(cursor)); }
  catch { /* Badge read state is a best-effort browser preference. */ }
}

function compareSocialPostCursor(left: Pick<SocialPostDto, 'createdAt' | 'postId'>, right: Pick<SocialPostDto, 'createdAt' | 'postId'>): number {
  return left.createdAt.localeCompare(right.createdAt) || left.postId.localeCompare(right.postId);
}
