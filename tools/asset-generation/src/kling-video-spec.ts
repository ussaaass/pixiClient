export interface KlingVideoSpec {
  assetKey: string;
  title: string;
  sourceImagePath: string;
  prompt: string;
  negativePrompt: string;
  duration: "5" | "10";
  mode: "std" | "pro";
}

export function validateKlingVideoSpec(value: unknown): KlingVideoSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Kling video spec must be a JSON object.");
  const spec = value as Partial<KlingVideoSpec>;
  if (!spec.assetKey || !/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(spec.assetKey)) throw new Error("Kling video assetKey is invalid.");
  for (const field of ["title", "sourceImagePath", "prompt", "negativePrompt"] as const) {
    if (typeof spec[field] !== "string" || !spec[field].trim()) throw new Error(`${field} is required in the Kling video spec.`);
  }
  if (spec.duration !== "5" && spec.duration !== "10") throw new Error("duration must be 5 or 10 seconds.");
  if (spec.mode !== "std" && spec.mode !== "pro") throw new Error("mode must be std or pro.");
  return spec as KlingVideoSpec;
}
