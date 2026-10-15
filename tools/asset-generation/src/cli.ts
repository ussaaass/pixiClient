import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { loadLocalEnv, readRuntimeConfig, requireOpenAIConfig, requireSpaceBunnyConfig } from "./config.ts";
import { assertRequestedFormat } from "./image-metadata.ts";
import { composeSeedPrompt, sha256, validateSpec, type AssetJob, type AssetSpec } from "./domain.ts";
import { OpenAIAssetClient, OpenAIRequestError, type ImageReferenceInput } from "./openai-client.ts";
import { SpaceBunnyAssetClient } from "./spacebunny-client.ts";
import { validateSvg } from "./svg-validation.ts";
import { createAssetFetch } from "./network.ts";
import { buildAvifAnimation, cropAvatarSheets } from "./derived-assets.ts";
import { buildShisanshuiDeck } from "./build-shisanshui-deck.ts";
import { copyDurably, listJobs, readJob, repoRoot, resolveRepoPath, writeJob } from "./store.ts";

const usage = `AI asset generation CLI

Commands:
  list-specs                         List JSON asset specifications
  plan <spec.json>                   Validate and preview a prompt (offline)
  generate <spec.json>               Generate PNG/WebP with OpenAI or SVG with Space Bunny
  generate-batch <spec.json...>      Generate specs sequentially; stop at first failure
  crop-avatar-sheets <female-job> <male-job>  Crop two 5x5 avatar WebP sheets into 50 review candidates
  build-avif-animation <sheet-job> Build and validate transparent 16-frame AVIF from a motion sheet
  build-shisanshui-deck            Compose all 52 exact card faces from code and reviewed-source candidates
  list                               List local generation jobs
  approve <job-id> --by <reviewer>   Approve a candidate for internal use
  publish <job-id>                   Publish an approved source and manifest
  record-cost <job-id> --amount N --currency USD --basis actual|estimate
  --help                             Show this help
`;

async function main(args: string[]): Promise<void> {
  await loadLocalEnv();
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "help") { console.log(usage); return; }
  if (command === "list-specs") return listSpecs();
  if (command === "plan") return plan(rest[0]);
  if (command === "generate") return generate(rest[0]);
  if (command === "generate-batch") return generateBatch(rest);
  if (command === "crop-avatar-sheets") {
    if (rest.length !== 2) throw new Error("Usage: crop-avatar-sheets FEMALE_JOB_ID MALE_JOB_ID");
    return cropAvatarSheets(rest[0], rest[1]);
  }
  if (command === "build-avif-animation") return buildAvifAnimation(rest[0]);
  if (command === "build-shisanshui-deck") return buildShisanshuiDeck();
  if (command === "list") return showJobs();
  if (command === "approve") return approve(rest[0], option(rest, "--by"));
  if (command === "publish") return publish(rest[0]);
  if (command === "record-cost") return recordCost(rest[0], rest);
  throw new Error(`Unknown command: ${command}\n\n${usage}`);
}

async function generateBatch(paths: string[]): Promise<void> {
  if (!paths.length) throw new Error("Provide at least one asset spec path.");
  for (let index = 0; index < paths.length; index++) {
    console.log(`\n[${index + 1}/${paths.length}] ${paths[index]}`);
    await generate(paths[index]);
  }
}

async function listSpecs(): Promise<void> {
  const dir = resolve(repoRoot, "assets/specs");
  const files: string[] = [];
  async function collect(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) await collect(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(fullPath);
    }
  }
  await collect(dir);
  for (const file of files.sort()) {
    const spec = validateSpec(JSON.parse(await readFile(file, "utf8")));
    console.log(`${spec.assetKey}\t${spec.title}\t${relative(repoRoot, file)}`);
  }
}

async function loadSpec(path?: string): Promise<{ spec: AssetSpec; absolute: string; bytes: Buffer }> {
  if (!path) throw new Error("Provide an asset spec JSON path.");
  const absolute = resolve(process.cwd(), path);
  resolveRepoPath(relative(repoRoot, absolute));
  const bytes = await readFile(absolute);
  return { spec: validateSpec(JSON.parse(bytes.toString("utf8"))), absolute, bytes };
}

async function styleReference(spec: AssetSpec): Promise<{ text: string; path?: string; hash?: string }> {
  if (!spec.styleReference) return { text: "" };
  const path = resolveRepoPath(spec.styleReference);
  const bytes = await readFile(path);
  return { text: bytes.toString("utf8"), path: relative(repoRoot, path), hash: sha256(bytes) };
}

async function loadVisualReferences(spec: AssetSpec): Promise<Array<{ path: string; hash: string; mimeType: ImageReferenceInput["mimeType"]; bytes: Buffer }>> {
  const refs = [];
  let totalBytes = 0;
  for (const reference of spec.visualReferenceImages ?? []) {
    const path = resolveRepoPath(reference.path);
    const extension = extname(path).toLowerCase();
    const mimeType = extension === ".png" ? "image/png"
      : extension === ".webp" ? "image/webp"
      : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg"
      : undefined;
    if (!mimeType) throw new Error(`Unsupported visual reference format: ${reference.path}`);
    const bytes = await readFile(path);
    totalBytes += bytes.length;
    if (bytes.length > 8_000_000 || totalBytes > 12_000_000) throw new Error("Visual reference images exceed the 8 MB per-file or 12 MB total limit.");
    refs.push({ path: relative(repoRoot, path), hash: sha256(bytes), mimeType, bytes });
  }
  return refs;
}

async function plan(path?: string): Promise<void> {
  const { spec } = await loadSpec(path);
  const style = await styleReference(spec);
  const config = readRuntimeConfig();
  console.log(JSON.stringify({
    assetKey: spec.assetKey,
    kind: spec.kind,
    title: spec.title,
    output: spec.output,
    mainModel: config.mainModel ?? "(configure OPENAI_MAIN_MODEL)",
    imageModel: config.imageModel ?? "(configure OPENAI_IMAGE_MODEL)",
    styleReferenceSha256: style.hash,
    prompt: composeSeedPrompt(spec, style.text),
  }, null, 2));
}

async function generate(path?: string): Promise<void> {
  const config = readRuntimeConfig();
  const { spec, absolute: specAbsolute, bytes: specBytes } = await loadSpec(path);
  const isSvg = spec.output.format === "svg";
  if (isSvg) requireSpaceBunnyConfig(config);
  else requireOpenAIConfig(config);
  const style = await styleReference(spec);
  const visualRefs = await loadVisualReferences(spec);
  const seed = composeSeedPrompt(spec, style.text);
  const job: AssetJob = {
    jobId: randomUUID(), assetKey: spec.assetKey, kind: spec.kind, title: spec.title,
    status: "GENERATING", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    provider: isSvg ? "spacebunny" : "openai",
    model: isSvg ? config.spaceBunnyModel : config.imageModel!,
    mainModel: isSvg ? undefined : config.mainModel,
    imageModel: isSvg ? undefined : config.imageModel,
    specPath: relative(repoRoot, specAbsolute), specSha256: sha256(specBytes),
    styleReferencePath: style.path, styleReferenceSha256: style.hash,
    visualReferenceImages: visualRefs.map(({ path, hash }) => ({ path, sha256: hash })),
    promptSeed: seed, promptVersion: "asset-prompt-v2", cost: { status: "NOT_RECONCILED", amount: null, currency: null },
  };
  const network = await createAssetFetch(config.socks5Proxy);
  await writeJob(job);
  console.log(`Created job ${job.jobId}; contacting ${isSvg ? "Space Bunny" : "OpenAI"}${config.socks5Proxy ? " through SOCKS5" : ""} (credentials are not logged).`);
  try {
    const candidate = `assets/candidates/${spec.assetKey}/${job.jobId}/source.${spec.output.format}`;
    const candidateAbs = resolveRepoPath(candidate);
    await mkdir(dirname(candidateAbs), { recursive: true });
    if (isSvg) {
      const generated = await new SpaceBunnyAssetClient({
        apiKey: config.spaceBunnyApiKey!, baseUrl: config.spaceBunnyBaseUrl, model: config.spaceBunnyModel,
      }, network.fetch).generateSvg(spec, seed);
      const checked = validateSvg(generated.svg);
      if (checked.bytes > config.maxOutputBytes) throw new Error(`Generated SVG exceeds ASSET_MAX_OUTPUT_BYTES (${config.maxOutputBytes}).`);
      await writeFile(candidateAbs, checked.svg, { flag: "wx" });
      job.finalPrompt = seed;
      job.imageRequestId = generated.requestId;
      job.usage = generated.usage;
      job.outputSha256 = sha256(checked.svg);
      job.outputBytes = checked.bytes;
      job.outputMime = "image/svg+xml";
      job.outputWidth = checked.metadata.width;
      job.outputHeight = checked.metadata.height;
    } else {
      const client = new OpenAIAssetClient({ apiKey: config.apiKey!, baseUrl: config.baseUrl, mainModel: config.mainModel!, imageModel: config.imageModel! }, network.fetch);
      const refined = await client.refinePrompt(seed, spec);
      job.finalPrompt = refined.data.prompt;
      job.promptResponseId = refined.data.responseId;
      job.usage = refined.usage;
      job.updatedAt = new Date().toISOString();
      await writeJob(job);
      const generated = await client.generateImage(spec, refined.data.prompt, visualRefs);
      job.imageRequestId = generated.requestId;
      job.usage = { ...(job.usage ?? {}), image: generated.usage };
      const metadata = assertRequestedFormat(generated.data.bytes, spec.output.format as "png" | "webp");
      if (generated.data.bytes.length > config.maxOutputBytes) throw new Error(`Generated image exceeds ASSET_MAX_OUTPUT_BYTES (${config.maxOutputBytes}).`);
      const { width, height } = metadata;
      const expected = /^\d{3,4}x\d{3,4}$/.test(spec.output.size) ? spec.output.size.split("x").map(Number) : [];
      if (width && height && (width !== expected[0] || height !== expected[1])) throw new Error(`Generated dimensions ${width}x${height} do not match requested ${spec.output.size}.`);
      await writeFile(candidateAbs, generated.data.bytes, { flag: "wx" });
      job.outputSha256 = sha256(generated.data.bytes);
      job.outputBytes = generated.data.bytes.length;
      job.outputMime = metadata.mime;
      job.outputWidth = width;
      job.outputHeight = height;
      job.generatedAt = generated.data.createdAt ? new Date(generated.data.createdAt * 1000).toISOString() : new Date().toISOString();
    }
    job.candidatePath = candidate;
    job.generatedAt ??= new Date().toISOString();
    job.status = "REVIEW_REQUIRED";
    job.updatedAt = new Date().toISOString();
    await writeJob(job);
    console.log(`Candidate saved: ${candidate}\nStatus: REVIEW_REQUIRED\nReview it before approval; no automatic publish occurred.`);
  } catch (error) {
    const requestError = error instanceof OpenAIRequestError ? error : undefined;
    job.status = requestError?.outcomeUnknown ? "UNKNOWN" : "FAILED";
    job.failure = {
      kind: requestError?.outcomeUnknown ? "UNKNOWN" : "DEFINITE",
      message: safeMessage(error), httpStatus: requestError?.httpStatus,
      requestId: requestError?.requestId, at: new Date().toISOString(),
    };
    job.updatedAt = new Date().toISOString();
    await writeJob(job);
    throw new Error(`Job ${job.jobId} ${job.status}: ${job.failure.message}${job.failure.requestId ? ` (request ${job.failure.requestId})` : ""}`);
  } finally {
    await network.close();
  }
}

async function showJobs(): Promise<void> {
  const jobs = await listJobs();
  if (!jobs.length) { console.log("No local jobs."); return; }
  for (const job of jobs) console.log(`${job.jobId}\t${job.status}\t${job.assetKey}\t${job.createdAt}${job.candidatePath ? `\t${job.candidatePath}` : ""}`);
}

async function approve(jobId?: string, reviewer?: string): Promise<void> {
  if (!jobId || !reviewer?.trim()) throw new Error("Usage: approve JOB_ID --by REVIEWER");
  const job = await readJob(jobId);
  if (job.status !== "REVIEW_REQUIRED" || !job.candidatePath) throw new Error(`Only REVIEW_REQUIRED jobs can be approved (current: ${job.status}).`);
  const extension = extname(job.candidatePath);
  const sourcePath = `assets/source/${job.assetKey}/${job.jobId}/source${extension}`;
  await copyDurably(resolveRepoPath(job.candidatePath), resolveRepoPath(sourcePath));
  job.sourcePath = sourcePath;
  job.review = { reviewer: reviewer.trim(), decision: "APPROVED", reviewedAt: new Date().toISOString() };
  job.status = "APPROVED";
  job.updatedAt = new Date().toISOString();
  await writeJob(job);
  console.log(`Approved source: ${sourcePath}`);
}

async function publish(jobId?: string): Promise<void> {
  if (!jobId) throw new Error("Usage: publish JOB_ID");
  const job = await readJob(jobId);
  if (job.status !== "APPROVED" || !job.sourcePath || !job.review) throw new Error(`Only APPROVED jobs can be published (current: ${job.status}).`);
  const extension = extname(job.sourcePath);
  const releasePath = `assets/releases/${job.assetKey}/${job.jobId}/source${extension}`;
  await copyDurably(resolveRepoPath(job.sourcePath), resolveRepoPath(releasePath));
  const manifest = {
    schemaVersion: 1, assetKey: job.assetKey, kind: job.kind, title: job.title,
    jobId: job.jobId, provider: job.provider, model: job.model, mainModel: job.mainModel, imageModel: job.imageModel,
    promptVersion: job.promptVersion, sourceSha256: job.outputSha256, mime: job.outputMime,
    styleReferencePath: job.styleReferencePath, styleReferenceSha256: job.styleReferenceSha256,
    visualReferenceImages: job.visualReferenceImages,
    derivedFrom: job.derivedFrom,
    animation: job.animation,
    width: job.outputWidth, height: job.outputHeight, bytes: job.outputBytes,
    releasePath, publishedAt: job.updatedAt, reviewer: job.review.reviewer,
  };
  const manifestPath = resolveRepoPath(`assets/manifests/generated/${job.jobId}.json`);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  job.releasePath = releasePath;
  job.status = "PUBLISHED";
  job.updatedAt = new Date().toISOString();
  await writeJob(job);
  console.log(`Published ${releasePath}\nManifest: ${relative(repoRoot, manifestPath)}`);
}

async function recordCost(jobId: string | undefined, args: string[]): Promise<void> {
  if (!jobId) throw new Error("Usage: record-cost JOB_ID --amount N --currency USD --basis actual|estimate");
  const amountRaw = option(args, "--amount");
  const currency = option(args, "--currency");
  const basis = option(args, "--basis");
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount < 0 || !currency || !["actual", "estimate"].includes(basis ?? "")) throw new Error("Provide a non-negative --amount, --currency, and --basis actual|estimate.");
  const job = await readJob(jobId);
  job.cost = { status: basis === "actual" ? "ACTUAL" : "ESTIMATE", amount, currency: currency.toUpperCase(), basis };
  job.updatedAt = new Date().toISOString();
  await writeJob(job);
  console.log(`Recorded ${job.cost.status.toLowerCase()} cost for ${jobId}.`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown generation error.";
  return message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 1000);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Asset generation failed.");
  process.exitCode = 1;
});
