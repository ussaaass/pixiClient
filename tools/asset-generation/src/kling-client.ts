export interface KlingVideoConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface KlingVideoRequest {
  imageBase64: string;
  imageTailBase64: string;
  prompt: string;
  negativePrompt: string;
  duration: "5" | "10";
  mode: "std" | "pro";
  externalTaskId: string;
}

export interface KlingVideoTask {
  taskId: string;
  taskStatus: "submitted" | "processing" | "succeed" | "failed";
  taskStatusMessage?: string;
  requestId?: string;
  videoUrl?: string;
  duration?: string;
  balanceDeduction?: { quota?: string; listPrice?: string };
}

export class KlingRequestError extends Error {
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly outcomeUnknown: boolean;

  constructor(message: string, httpStatus?: number, requestId?: string, outcomeUnknown = false) {
    super(message);
    this.name = "KlingRequestError";
    this.httpStatus = httpStatus;
    this.requestId = requestId;
    this.outcomeUnknown = outcomeUnknown;
  }
}

interface KlingEnvelope {
  code: number;
  message?: string;
  request_id?: string;
  data?: {
    task_id?: string;
    task_status?: string;
    task_status_msg?: string;
    task_result?: { videos?: Array<{ url?: string; duration?: string }> };
    final_balance_deduction?: { quota?: string; list_price?: string };
  };
}

export class KlingVideoClient {
  private readonly config: KlingVideoConfig;
  private readonly fetcher: typeof fetch;

  constructor(config: KlingVideoConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  async createTask(request: KlingVideoRequest): Promise<KlingVideoTask> {
    const result = await this.request("/v1/videos/image2video", {
      method: "POST",
      body: JSON.stringify({
        model_name: this.config.model,
        image: request.imageBase64,
        image_tail: request.imageTailBase64,
        prompt: request.prompt,
        negative_prompt: request.negativePrompt,
        duration: request.duration,
        mode: request.mode,
        sound: "off",
        external_task_id: request.externalTaskId,
      }),
    });
    return parseTask(result);
  }

  async getTask(taskId: string): Promise<KlingVideoTask> {
    return parseTask(await this.request(`/v1/videos/image2video/${encodeURIComponent(taskId)}`, { method: "GET" }));
  }

  async downloadVideo(url: string, maxBytes: number): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.fetcher(url, { method: "GET", signal: AbortSignal.timeout(120_000) });
    } catch {
      throw new KlingRequestError("Kling video download failed; resume the saved task to retry the download.", undefined, undefined, true);
    }
    if (!response.ok) throw new KlingRequestError(`Kling video download returned HTTP ${response.status}.`, response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new KlingRequestError(`Kling video exceeds ASSET_MAX_OUTPUT_BYTES (${maxBytes}).`);
    if (!hasMp4Signature(bytes)) throw new KlingRequestError("Kling response is not a valid MP4 video file.");
    return bytes;
  }

  private async request(path: string, init: RequestInit): Promise<KlingEnvelope> {
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.config.baseUrl), {
        ...init,
        headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json", ...init.headers },
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new KlingRequestError("Kling API connection failed. Check network/proxy; do not resubmit a task with unknown outcome.", undefined, undefined, true);
    }
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const text = await response.text();
    let payload: KlingEnvelope;
    try { payload = JSON.parse(text) as KlingEnvelope; }
    catch { throw new KlingRequestError(`Kling API returned an invalid response (HTTP ${response.status}).`, response.status, requestId, response.status >= 500); }
    const resolvedRequestId = payload.request_id ?? requestId;
    if (!response.ok || payload.code !== 0) {
      throw new KlingRequestError(`Kling API rejected the request: ${payload.message ?? `HTTP ${response.status}, code ${payload.code}`}.`, response.status, resolvedRequestId, response.status >= 500);
    }
    return payload;
  }
}

function parseTask(payload: KlingEnvelope): KlingVideoTask {
  const data = payload.data;
  const status = data?.task_status;
  if (!data?.task_id || !["submitted", "processing", "succeed", "failed"].includes(status ?? "")) {
    throw new KlingRequestError("Kling API response is missing a valid task ID or task status.", undefined, payload.request_id, true);
  }
  const video = data.task_result?.videos?.[0];
  return {
    taskId: data.task_id,
    taskStatus: status as KlingVideoTask["taskStatus"],
    taskStatusMessage: data.task_status_msg,
    requestId: payload.request_id,
    videoUrl: video?.url,
    duration: video?.duration,
    balanceDeduction: data.final_balance_deduction,
  };
}

function hasMp4Signature(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp";
}
