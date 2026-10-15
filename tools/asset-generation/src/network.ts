export interface AssetFetch {
  fetch: typeof fetch;
  close: () => Promise<void>;
}

export async function createAssetFetch(proxyUrl?: string): Promise<AssetFetch> {
  if (!proxyUrl?.trim()) return { fetch, close: async () => {} };
  let parsed: URL;
  try { parsed = new URL(proxyUrl); }
  catch { throw new Error("ASSET_SOCKS5_PROXY must be a valid socks5:// URL."); }
  if (parsed.protocol !== "socks5:" && parsed.protocol !== "socks:") throw new Error("ASSET_SOCKS5_PROXY must use socks5:// or socks://.");
  if (!parsed.hostname || !parsed.port) throw new Error("ASSET_SOCKS5_PROXY must include proxy host and port.");
  const { Socks5ProxyAgent } = await import("undici");
  const dispatcher = new Socks5ProxyAgent(proxyUrl);
  const proxiedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: typeof dispatcher })) as typeof fetch;
  return { fetch: proxiedFetch, close: async () => { await dispatcher.close(); } };
}
