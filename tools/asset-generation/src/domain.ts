import { createHash } from "node:crypto";

export type AssetFormat = "png" | "webp" | "svg";
export type AssetQuality = "low" | "medium" | "high" | "xhigh" | "max";
export type AssetKind = "BACKGROUND" | "COVER" | "CARD_BACK" | "CARD_FRAME" | "AVATAR" | "EFFECT" | "ICON" | "OTHER";
export type JobStatus = "GENERATING" | "UNKNOWN" | "FAILED" | "REVIEW_REQUIRED" | "APPROVED" | "PUBLISHED";

export interface AssetSpec {
  assetKey: string;
  kind: AssetKind;
  title: string;
  intendedUse: string;
  prompt: string;
  negativePrompt?: string;
  output: {
    size: string;
    format: AssetFormat;
    quality: AssetQuality;
    background?: "opaque" | "transparent";
  };
  styleReference?: string;
  visualReferenceImages?: Array<{ path: string; purpose?: string }>;
  tags?: string[];
}

export interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: Record<string, unknown>;
  output_tokens_details?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AssetJob {
  jobId: string;
  assetKey: string;
  kind: AssetKind;
  title: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  provider: "openai" | "spacebunny" | "derived";
  model: string;
  mainModel?: string;
  imageModel?: string;
  specPath: string;
  specSha256: string;
  styleReferencePath?: string;
  styleReferenceSha256?: string;
  visualReferenceImages?: Array<{ path: string; sha256: string }>;
  promptSeed: string;
  promptVersion: string;
  finalPrompt?: string;
  promptResponseId?: string;
  imageRequestId?: string;
  generatedAt?: string;
  candidatePath?: string;
  sourcePath?: string;
  releasePath?: string;
  outputSha256?: string;
  outputBytes?: number;
  outputMime?: string;
  outputWidth?: number;
  outputHeight?: number;
  usage?: ApiUsage;
  cost: {
    status: "NOT_RECONCILED" | "ESTIMATE" | "ACTUAL";
    amount: number | null;
    currency: string | null;
    basis?: string;
  };
  review?: {
    reviewer: string;
    decision: "APPROVED";
    reviewedAt: string;
  };
  failure?: {
    kind: "DEFINITE" | "UNKNOWN";
    message: string;
    httpStatus?: number;
    requestId?: string;
    at: string;
  };
  derivedFrom?: {
    jobId: string;
    sourceSha256: string;
    crop: { x: number; y: number; width: number; height: number };
    tool: string;
    additionalSourceJobs?: string[];
  };
  animation?: {
    frameCount: number;
    columns: number;
    rows: number;
    frameWidth: number;
    frameHeight: number;
    framesPerSecond: number;
    repeatCount: number;
  };
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateSpec(value: unknown): AssetSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Asset spec must be a JSON object.");
  }
  const spec = value as Partial<AssetSpec>;
  if (!spec.assetKey || !/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(spec.assetKey)) {
    throw new Error("assetKey must be 2-80 letters, digits, dots, underscores or hyphens and cannot contain a path.");
  }
  const kinds: AssetKind[] = ["BACKGROUND", "COVER", "CARD_BACK", "CARD_FRAME", "AVATAR", "EFFECT", "ICON", "OTHER"];
  if (!spec.kind || !kinds.includes(spec.kind)) throw new Error(`kind must be one of: ${kinds.join(", ")}`);
  for (const field of ["title", "intendedUse", "prompt"] as const) {
    if (typeof spec[field] !== "string" || !spec[field].trim()) throw new Error(`${field} is required.`);
  }
  if (!spec.output || typeof spec.output !== "object") throw new Error("output settings are required.");
  if (!/^\d{3,4}x\d{3,4}$/.test(spec.output.size)) throw new Error("output.size must look like 1024x1024.");
  if (!["png", "webp", "svg"].includes(spec.output.format)) throw new Error("output.format must be png, webp or svg.");
  if (!["low", "medium", "high", "xhigh", "max"].includes(spec.output.quality)) throw new Error("output.quality is invalid.");
  if (spec.output.background && !["opaque", "transparent"].includes(spec.output.background)) throw new Error("output.background must be opaque or transparent.");
  if (spec.negativePrompt !== undefined && typeof spec.negativePrompt !== "string") throw new Error("negativePrompt must be a string.");
  if (spec.styleReference !== undefined && typeof spec.styleReference !== "string") throw new Error("styleReference must be a path string.");
  if (spec.visualReferenceImages !== undefined && (!Array.isArray(spec.visualReferenceImages) || spec.visualReferenceImages.length > 4 || spec.visualReferenceImages.some((image) => !image || typeof image !== "object" || typeof image.path !== "string" || !image.path.trim() || (image.purpose !== undefined && typeof image.purpose !== "string")))) throw new Error("visualReferenceImages must contain at most four image paths and optional purpose strings.");
  if (spec.tags !== undefined && (!Array.isArray(spec.tags) || spec.tags.some((tag) => typeof tag !== "string"))) throw new Error("tags must be an array of strings.");
  return spec as AssetSpec;
}

export function composeSeedPrompt(spec: AssetSpec, styleText = ""): string {
  const style = styleText.trim() ? `\nApproved style brief:\n${styleText.trim()}` : "";
  const negative = spec.negativePrompt?.trim() ? `\nMust avoid: ${spec.negativePrompt.trim()}` : "";
  const visualRefs = spec.visualReferenceImages?.length
    ? `\nVisual reference images: ${spec.visualReferenceImages.map((image) => `${image.path}${image.purpose ? ` (${image.purpose})` : ""}`).join("; ")}. Treat them as style references only; create the subject and composition described below.`
    : "";
  return `Asset: ${spec.title}\nIntended use: ${spec.intendedUse}${style}${visualRefs}\nArt direction: ${spec.prompt.trim()}${negative}\nDo not include lettering, numbers, logos, watermarks or UI copy unless the asset spec explicitly requests them.`;
}

export function imageSizeToDimensions(size: string): { width: number; height: number } {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(size);
  if (!match) throw new Error(`Unsupported image size: ${size}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}
