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

/**
 * Resolve the backing store without touching the DOM lib.
 *
 * This package is shared by the browser client and the (future) server, so it must not
 * reference `window`/`localStorage` directly. Reading it off `globalThis` through a
 * narrow structural type keeps the browser default while degrading to "no badge state"
 * in a non-DOM runtime instead of throwing.
 */
function resolveStorage(storage?: SocialPostBadgeStorage): SocialPostBadgeStorage | null {
  if (storage) return storage;
  return (globalThis as { localStorage?: SocialPostBadgeStorage }).localStorage ?? null;
}

export function readSocialPostCursor(userId: string, storage?: SocialPostBadgeStorage): SocialPostReadCursor | null {
  try {
    const store = resolveStorage(storage);
    if (!store) return null;
    const value = store.getItem(storageKey(userId));
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
    .reduce<SocialPostBadgeRecord | null>(
      (current, post) => (!current || compareSocialPostCursor(post, current) > 0 ? post : current),
      null,
    );
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
  try {
    resolveStorage(storage)?.setItem(storageKey(userId), JSON.stringify(cursor));
  } catch {
    /* Badge read state is a best-effort browser preference. */
  }
}

function compareSocialPostCursor(
  left: Pick<SocialPostDto, 'createdAt' | 'postId'>,
  right: Pick<SocialPostDto, 'createdAt' | 'postId'>,
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.postId.localeCompare(right.postId);
}
