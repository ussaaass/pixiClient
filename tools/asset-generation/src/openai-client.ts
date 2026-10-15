import type { ApiUsage, AssetSpec } from "./domain.ts";

export interface OpenAIConfig {
  apiKey: string;
  baseUrl: string;
  mainModel: string;
  imageModel: string;
}

export interface OpenAIResult<T> {
  data: T;
  requestId?: string;
  usage?: ApiUsage;
}

export interface ImageReferenceInput {
  mimeType: "image/png" | "image/webp" | "image/jpeg";
  bytes: Uint8Array;
}

export class OpenAIAssetClient {
  private readonly config: OpenAIConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAIConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async refinePrompt(seedPrompt: string, spec: AssetSpec): Promise<OpenAIResult<{ prompt: string; responseId: string }>> {
    const response = await this.post("/responses", {
      model: this.config.mainModel,
      store: false,
      max_output_tokens: 900,
      instructions: [
        "You write production prompts for a single original casual mobile game art asset.",
        "Return only the final image prompt, without markdown or commentary.",
        "Preserve the described subject, intended use, composition, and every explicit shared style invariant; do not reinterpret the rendering medium, material family, lighting, or palette.",
        "Do not invent text, card ranks, suit counts, logos, watermarks, or UI labels.",
        "Keep meaningful negative space where the asset will be covered by H5 interface text.",
      ].join(" "),
      input: JSON.stringify({ spec, seedPrompt }),
    });
    const payload = response.data as {
      id?: string;
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
      usage?: ApiUsage;
      error?: { message?: string };
    };
    const text = payload.output?.flatMap((item) => item.content ?? [])
      .find((item) => item.type === "output_text")?.text?.trim();
    if (!text) throw new OpenAIRequestError("Responses API returned no output_text prompt.", response.requestId);
    return { data: { prompt: text, responseId: payload.id ?? "unknown" }, requestId: response.requestId, usage: payload.usage };
  }

  async generateImage(spec: AssetSpec, prompt: string, references: ImageReferenceInput[] = []): Promise<OpenAIResult<{ bytes: Uint8Array; createdAt?: number }>> {
    if (spec.output.format === "svg") throw new Error("OpenAI image generation requires PNG or WebP output.");
    const tool: Record<string, unknown> = {
      type: "image_generation",
      model: this.config.imageModel,
      action: "generate",
      size: spec.output.size,
      quality: spec.output.quality,
      output_format: spec.output.format,
    };
    if (spec.output.background === "transparent") tool.background = "transparent";
    const input = references.length
      ? [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            ...references.map((reference) => ({
              type: "input_image",
              image_url: `data:${reference.mimeType};base64,${Buffer.from(reference.bytes).toString("base64")}`,
              detail: "high",
            })),
          ],
        }]
      : prompt;
    const response = await this.post("/responses", {
      model: this.config.mainModel,
      store: false,
      input,
      tools: [tool],
      tool_choice: { type: "image_generation" },
    });
    const payload = response.data as {
      id?: string;
      output?: Array<{ type?: string; id?: string; result?: string | null; status?: string; revised_prompt?: string }>;
      usage?: ApiUsage;
    };
    const image = payload.output?.find((item) => item.type === "image_generation_call");
    const encoded = image?.result;
    if (!encoded || image?.status === "failed") throw new OpenAIRequestError("Responses API returned no completed image_generation_call result.", response.requestId);
    return {
      data: { bytes: new Uint8Array(Buffer.from(encoded, "base64")) },
      requestId: response.requestId,
      usage: payload.usage,
    };
  }

  private async post(path: string, body: unknown): Promise<OpenAIResult<unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      throw new OpenAIRequestError(error instanceof Error ? error.message : "Network request failed.", undefined, undefined, true);
    }
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new OpenAIRequestError(`OpenAI API returned invalid JSON (HTTP ${response.status}).`, requestId, response.status);
    }
    if (!response.ok) {
      const message = (data as { error?: { message?: string } })?.error?.message ?? `OpenAI API request failed (HTTP ${response.status}).`;
      throw new OpenAIRequestError(message, requestId, response.status, false);
    }
    return { data, requestId, usage: (data as { usage?: ApiUsage })?.usage };
  }
}

export class OpenAIRequestError extends Error {
  readonly requestId?: string;
  readonly httpStatus?: number;
  readonly outcomeUnknown: boolean;

  constructor(message: string, requestId?: string, httpStatus?: number, outcomeUnknown = false) {
    super(message);
    this.name = "OpenAIRequestError";
    this.requestId = requestId;
    this.httpStatus = httpStatus;
    this.outcomeUnknown = outcomeUnknown;
  }
}
