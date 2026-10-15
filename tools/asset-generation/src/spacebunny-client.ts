import type { ApiUsage, AssetSpec } from "./domain.ts";
import { OpenAIRequestError } from "./openai-client.ts";

export interface SpaceBunnyConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface SpaceBunnyResult {
  svg: string;
  requestId?: string;
  usage?: ApiUsage;
  model?: string;
}

export class SpaceBunnyAssetClient {
  private readonly fetchImpl: typeof fetch;
  private readonly config: SpaceBunnyConfig;
  constructor(config: SpaceBunnyConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async generateSvg(spec: AssetSpec, prompt: string): Promise<SpaceBunnyResult> {
    const response = await this.post({
      model: this.config.model,
      reasoning: { effort: "high" },
      max_completion_tokens: 12_000,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: [
            "Create one polished, original, production-ready vector game icon as SVG source code.",
            "Return only raw SVG markup. Do not use markdown fences, explanations, raster data, scripts, stylesheets, external files, links, text, letters or numbers.",
            "Use a square viewBox of 0 0 512 512. Use only basic SVG geometry and gradients.",
            "The SVG must be self-contained and safe to render offline.",
          ].join(" "),
        },
        { role: "user", content: JSON.stringify({ asset: spec, artDirection: prompt }) },
      ],
    });
    const payload = response.data as {
      id?: string;
      model?: string;
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
      usage?: Record<string, unknown>;
    };
    const content = payload.choices?.[0]?.message?.content;
    const svg = typeof content === "string" ? content.trim() : Array.isArray(content)
      ? content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim()
      : "";
    if (!svg) throw new OpenAIRequestError("Space Bunny returned no SVG text.", response.requestId);
    return {
      svg,
      requestId: response.requestId,
      model: payload.model,
      usage: payload.usage as ApiUsage | undefined,
    };
  }

  private async post(body: unknown): Promise<{ data: unknown; requestId?: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      throw new OpenAIRequestError(error instanceof Error ? error.message : "Network request failed.", undefined, undefined, true);
    }
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
    const raw = await response.text();
    let data: unknown;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { throw new OpenAIRequestError(`Space Bunny returned invalid JSON (HTTP ${response.status}).`, requestId, response.status); }
    if (!response.ok) {
      const message = (data as { error?: { message?: string } })?.error?.message ?? `Space Bunny request failed (HTTP ${response.status}).`;
      throw new OpenAIRequestError(message, requestId, response.status);
    }
    return { data, requestId };
  }
}
