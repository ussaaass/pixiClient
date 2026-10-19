import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAnimatedBackgroundBytes } from './animated-background-cache';

describe('animated background byte cache', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shares an in-flight download and keeps successful bytes for the app session', async () => {
    const source = `/assets/page-backgrounds/motion/wallet-cache-test-${crypto.randomUUID()}.avif`;
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const [first, concurrent] = await Promise.all([
      loadAnimatedBackgroundBytes(source),
      loadAnimatedBackgroundBytes(source),
    ]);
    const later = await loadAnimatedBackgroundBytes(source);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([...new Uint8Array(first)]).toEqual([1, 2, 3]);
    expect(concurrent).toBe(first);
    expect(later).toBe(first);
  });

  it('allows a later retry after a failed download', async () => {
    const source = `/assets/page-backgrounds/motion/wallet-retry-test-${crypto.randomUUID()}.avif`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadAnimatedBackgroundBytes(source)).rejects.toThrow('503');
    await expect(loadAnimatedBackgroundBytes(source)).resolves.toBeInstanceOf(ArrayBuffer);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
