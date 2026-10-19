const sourceBytes = new Map<string, Promise<ArrayBuffer>>();

export function loadAnimatedBackgroundBytes(source: string): Promise<ArrayBuffer> {
  const cached = sourceBytes.get(source);
  if (cached) return cached;
  const loading = fetch(source, { cache: 'force-cache' }).then(async (response) => {
    if (!response.ok) throw new Error(`Unable to load animated background (${response.status})`);
    return response.arrayBuffer();
  }).catch((error: unknown) => {
    sourceBytes.delete(source);
    throw error;
  });
  sourceBytes.set(source, loading);
  return loading;
}
