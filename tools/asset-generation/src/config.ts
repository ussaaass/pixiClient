import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface RuntimeConfig {
  apiKey?: string;
  baseUrl: string;
  mainModel?: string;
  imageModel?: string;
  spaceBunnyApiKey?: string;
  spaceBunnyBaseUrl: string;
  spaceBunnyModel: string;
  socks5Proxy?: string;
  maxOutputBytes: number;
}

export async function loadLocalEnv(envPath = resolve(process.cwd(), ".env")): Promise<void> {
  let source: string;
  try {
    source = await readFile(envPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    process.env[match[1]] = value;
  }
}

export function readRuntimeConfig(): RuntimeConfig {
  const maxOutputBytes = Number(process.env.ASSET_MAX_OUTPUT_BYTES ?? 15_000_000);
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024) throw new Error("ASSET_MAX_OUTPUT_BYTES must be an integer of at least 1024.");
  return {
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    mainModel: process.env.OPENAI_MAIN_MODEL,
    imageModel: process.env.OPENAI_IMAGE_MODEL,
    spaceBunnyApiKey: process.env.SPACE_BUNNY_API_KEY,
    spaceBunnyBaseUrl: process.env.SPACE_BUNNY_BASE_URL ?? "https://spacebunny.app/api/v1",
    spaceBunnyModel: process.env.SPACE_BUNNY_MODEL ?? "stealth/space-bunny-alpha",
    socks5Proxy: process.env.ASSET_SOCKS5_PROXY,
    maxOutputBytes,
  };
}

export function requireSpaceBunnyConfig(config: RuntimeConfig): asserts config is RuntimeConfig & { spaceBunnyApiKey: string; spaceBunnyModel: string } {
  if (!config.spaceBunnyApiKey) throw new Error("Missing SPACE_BUNNY_API_KEY. Add it to tools/asset-generation/.env; never put it in the browser or Git.");
  if (!config.spaceBunnyModel.trim()) throw new Error("SPACE_BUNNY_MODEL cannot be empty.");
}

export function requireOpenAIConfig(config: RuntimeConfig): asserts config is RuntimeConfig & { apiKey: string; mainModel: string; imageModel: string } {
  const missing = [
    ["OPENAI_API_KEY", config.apiKey],
    ["OPENAI_MAIN_MODEL", config.mainModel],
    ["OPENAI_IMAGE_MODEL", config.imageModel],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Missing required settings: ${missing.join(", ")}. Copy .env.example to .env and set them locally.`);
  if (config.mainModel === config.imageModel) throw new Error("OPENAI_MAIN_MODEL and OPENAI_IMAGE_MODEL must be configured separately.");
}
