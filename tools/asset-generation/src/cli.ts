import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { loadLocalEnv, readRuntimeConfig, requireKlingConfig, requireOpenAIConfig, requireSpaceBunnyConfig } from "./config.ts";
import { assertRequestedFormat } from "./image-metadata.ts";
import { composeSeedPrompt, sha256, validateSpec, type AssetJob, type AssetSpec } from "./domain.ts";
import { OpenAIAssetClient, OpenAIRequestError, type ImageReferenceInput } from "./openai-client.ts";
import { SpaceBunnyAssetClient } from "./spacebunny-client.ts";
import { KlingRequestError, KlingVideoClient } from "./kling-client.ts";
import { validateKlingVideoSpec } from "./kling-video-spec.ts";
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
  kling-submit <video-spec.json>    Submit a Kling image-to-video task using the supplied image as both start and end frame
  kling-resume <job-id>              Poll a saved Kling task and download its MP4 when complete
  kling-to-avif <job-id> [--width N --height N --fps N --crf N --ping-pong]  Convert MP4 to a responsive-size AVIF review candidate
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
  if (command === "kling-submit") return submitKlingVideo(rest[0]);
  if (command === "kling-resume") return resumeKlingVideo(rest[0]);
  if (command === "kling-to-avif") return convertKlingVideoToAvif(rest[0], rest);
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

async function submitKlingVideo(path?: string): Promise<void> {
  const config = readRuntimeConfig();
  requireKlingConfig(config);
  if (!path) throw new Error("Provide a Kling video spec JSON path.");
  const absolute = resolve(process.cwd(), path);
  const relativeSpecPath = relative(repoRoot, absolute);
  resolveRepoPath(relativeSpecPath);
  const sourceSpecBytes = await readFile(absolute);
  const spec = validateKlingVideoSpec(JSON.parse(sourceSpecBytes.toString("utf8")));
  const sourcePath = resolveRepoPath(spec.sourceImagePath);
  const sourceImage = await readFile(sourcePath);
  const apiImage = await klingCompatibleImage(sourcePath, sourceImage);
  if (apiImage.length > 10_000_000) throw new Error("Kling reference image must be 10 MB or smaller.");
  const jobId = randomUUID();
  const job: AssetJob = {
    jobId, assetKey: spec.assetKey, kind: "BACKGROUND", title: spec.title,
    status: "GENERATING", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    provider: "klingai", model: config.klingModel, specPath: relative(repoRoot, absolute),
    specSha256: sha256(sourceSpecBytes), promptSeed: spec.prompt, promptVersion: "kling-motion-v1",
    visualReferenceImages: [{ path: spec.sourceImagePath, sha256: sha256(sourceImage) }],
    cost: { status: "NOT_RECONCILED", amount: null, currency: null },
    videoTask: { taskId: "PENDING", taskStatus: "submitted", durationSeconds: Number(spec.duration), mode: spec.mode },
  };
  await writeJob(job);
  const network = await createAssetFetch(config.socks5Proxy);
  try {
    const client = new KlingVideoClient({ apiKey: config.klingApiKey, baseUrl: config.klingBaseUrl, model: config.klingModel }, network.fetch);
    const submitted = await client.createTask({
      imageBase64: apiImage.toString("base64"), imageTailBase64: apiImage.toString("base64"),
      prompt: spec.prompt, negativePrompt: spec.negativePrompt, duration: spec.duration,
      mode: spec.mode, externalTaskId: jobId,
    });
    job.videoTask = { taskId: submitted.taskId, taskStatus: submitted.taskStatus, durationSeconds: Number(spec.duration), mode: spec.mode };
    job.imageRequestId = submitted.requestId;
    job.updatedAt = new Date().toISOString();
    await writeJob(job);
    console.log(`Kling task submitted. Job: ${jobId}; task: ${submitted.taskId}; status: ${submitted.taskStatus}. From tools/asset-generation, poll with: npm run assetgen -- kling-resume ${jobId}`);
  } catch (error) {
    const requestError = error instanceof KlingRequestError ? error : undefined;
    job.status = requestError?.outcomeUnknown ? "UNKNOWN" : "FAILED";
    job.failure = { kind: requestError?.outcomeUnknown ? "UNKNOWN" : "DEFINITE", message: safeMessage(error), httpStatus: requestError?.httpStatus, requestId: requestError?.requestId, at: new Date().toISOString() };
    job.updatedAt = new Date().toISOString();
    await writeJob(job);
    throw new Error(`Kling job ${jobId} ${job.status}: ${job.failure.message}${job.status === "UNKNOWN" ? " Do not submit a duplicate until checking the Kling console." : ""}`);
  } finally {
    await network.close();
  }
}

async function resumeKlingVideo(jobId?: string): Promise<void> {
  if (!jobId) throw new Error("Provide a Kling asset job ID.");
  const config = readRuntimeConfig();
  requireKlingConfig(config);
  const job = await readJob(jobId);
  if (job.provider !== "klingai" || !job.videoTask) throw new Error("This is not a Kling video job.");
  if (job.status === "REVIEW_REQUIRED" && job.candidatePath) { console.log(`Candidate already downloaded: ${job.candidatePath}`); return; }
  const network = await createAssetFetch(config.socks5Proxy);
  try {
    const client = new KlingVideoClient({ apiKey: config.klingApiKey, baseUrl: config.klingBaseUrl, model: config.klingModel }, network.fetch);
    const task = await client.getTask(job.videoTask.taskId === "PENDING" ? job.jobId : job.videoTask.taskId);
    job.videoTask.taskId = task.taskId;
    job.videoTask.taskStatus = task.taskStatus;
    job.imageRequestId = task.requestId ?? job.imageRequestId;
    job.usage = { ...(job.usage ?? {}), klingFinalBalanceDeduction: task.balanceDeduction };
    job.updatedAt = new Date().toISOString();
    if (task.taskStatus === "failed") {
      job.status = "FAILED";
      job.failure = { kind: "DEFINITE", message: task.taskStatusMessage ?? "Kling video task failed.", requestId: task.requestId, at: new Date().toISOString() };
      await writeJob(job);
      console.log(`Kling task failed: ${job.failure.message}`);
      return;
    }
    if (task.taskStatus !== "succeed") {
      job.status = "GENERATING";
      await writeJob(job);
      console.log(`Kling task ${task.taskStatus}; from tools/asset-generation, resume with: npm run assetgen -- kling-resume ${job.jobId}`);
      return;
    }
    if (!task.videoUrl) throw new KlingRequestError("Kling task succeeded but returned no video URL; the task record is preserved for retry.", undefined, task.requestId, true);
    const bytes = await client.downloadVideo(task.videoUrl, config.maxOutputBytes);
    const candidatePath = `assets/candidates/${job.assetKey}/${job.jobId}/source.mp4`;
    const destination = resolveRepoPath(candidatePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
    job.candidatePath = candidatePath;
    job.outputMime = "video/mp4";
    job.outputBytes = bytes.length;
    job.outputSha256 = sha256(bytes);
    job.status = "REVIEW_REQUIRED";
    job.updatedAt = new Date().toISOString();
    await writeJob(job);
    console.log(`Video candidate saved: ${candidatePath}\nStatus: REVIEW_REQUIRED. Review before converting/publishing; no automatic publish occurred.`);
  } catch (error) {
    const requestError = error instanceof KlingRequestError ? error : undefined;
    job.status = requestError?.outcomeUnknown ? "UNKNOWN" : "FAILED";
    job.failure = { kind: requestError?.outcomeUnknown ? "UNKNOWN" : "DEFINITE", message: safeMessage(error), httpStatus: requestError?.httpStatus, requestId: requestError?.requestId, at: new Date().toISOString() };
    job.updatedAt = new Date().toISOString();
    await writeJob(job);
    throw new Error(`Kling job ${jobId} ${job.status}: ${job.failure.message}`);
  } finally {
    await network.close();
  }
}

async function klingCompatibleImage(path: string, bytes: Buffer): Promise<Buffer> {
  const extension = extname(path).toLowerCase();
  if ([".png", ".jpg", ".jpeg"].includes(extension)) return bytes;
  if (extension !== ".webp") throw new Error("Kling image-to-video source must be PNG, JPEG, or WebP.");
  try {
    return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-q:v", "2", "-f", "image2", "-vcodec", "mjpeg", "pipe:1"], { input: bytes, maxBuffer: 10_000_000, timeout: 30_000 });
  } catch {
    throw new Error("Converting WebP to Kling-supported JPEG failed. Install ffmpeg and retry.");
  }
}

async function convertKlingVideoToAvif(jobId?: string, args: string[] = []): Promise<void> {
  if (!jobId) throw new Error("Provide a completed Kling video job ID.");
  const parent = await readJob(jobId);
  if (parent.provider !== "klingai" || parent.status !== "REVIEW_REQUIRED" || parent.outputMime !== "video/mp4" || !parent.candidatePath || !parent.outputSha256) {
    throw new Error("Only a downloaded Kling MP4 candidate can be converted.");
  }
  const source = resolveRepoPath(parent.candidatePath);
  const sourceSize = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", source], { encoding: "utf8", timeout: 30_000 }).trim().split("x").map(Number);
  const sourceWidth = sourceSize[0];
  const sourceHeight = sourceSize[1];
  const sourceDuration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", source], { encoding: "utf8", timeout: 30_000 }).trim());
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) throw new Error("Could not detect the Kling MP4 frame size.");
  const width = Number(option(args, "--width") ?? (sourceWidth >= sourceHeight ? 960 : 640));
  const height = Number(option(args, "--height") ?? (sourceWidth >= sourceHeight ? 640 : 960));
  const fps = Number(option(args, "--fps") ?? 5);
  const crf = Number(option(args, "--crf") ?? 35);
  const pingPong = args.includes("--ping-pong");
  if (![width, height].every((value) => Number.isInteger(value) && value >= 320 && value <= 1920)) throw new Error("--width and --height must be integers from 320 to 1920.");
  if (width / height !== sourceWidth / sourceHeight) throw new Error(`Output aspect ratio must match the source (${sourceWidth}x${sourceHeight}) to avoid stretching. Generate a separate portrait source for mobile.`);
  if (!Number.isFinite(fps) || fps < 2 || fps > 15) throw new Error("--fps must be between 2 and 15.");
  if (!Number.isInteger(crf) || crf < 0 || crf > 63) throw new Error("--crf must be an integer from 0 to 63.");
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error("Could not detect the Kling MP4 duration.");
  const sourceFrameCount = Math.max(2, Math.floor(sourceDuration * fps + 0.0001));
  const baseFilter = `fps=${fps},scale=${width}:${height}:flags=lanczos,unsharp=5:5:0.5:3:3:0,format=yuv420p`;
  const filterArgs = pingPong
    ? ["-filter_complex", `${baseFilter},split[forward][reverse_in];[forward]setpts=PTS-STARTPTS[forward_out];[reverse_in]reverse,trim=start_frame=1:end_frame=${sourceFrameCount - 1},setpts=PTS-STARTPTS[reverse];[forward_out][reverse]concat=n=2:v=1:a=0[outv]`, "-map", "[outv]"]
    : ["-vf", baseFilter];
  const childJobId = randomUUID();
  const outputPath = `assets/candidates/${parent.assetKey}/${childJobId}/source.avif`;
  const output = resolveRepoPath(outputPath);
  await mkdir(dirname(output), { recursive: true });
  try {
    execFileSync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-i", source, ...filterArgs,
      "-an", "-c:v", "libaom-av1", "-crf", String(crf), "-b:v", "0", "-cpu-used", "6",
      "-still-picture", "0", "-loop", "0", "-f", "avif", output,
    ], { maxBuffer: 1_000_000, timeout: 180_000 });
    const info = execFileSync("avifdec", ["--info", output], { encoding: "utf8", maxBuffer: 1_000_000, timeout: 30_000 });
    const frameCount = Number(/Image Sequence Frames:\s*\((\d+) expected frames\)/.exec(info)?.[1] ?? 0);
    if (frameCount < 2 || !/Repeat Count\s*:\s*Infinite/.test(info)) throw new Error("AVIF validation failed: expected a looping multi-frame sequence.");
    const bytes = await readFile(output);
    const job: AssetJob = {
      jobId: childJobId, assetKey: parent.assetKey, kind: parent.kind, title: `${parent.title} AVIF 清晰版`,
      status: "REVIEW_REQUIRED", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      provider: "derived", model: "ffmpeg-libaom-av1", specPath: parent.specPath, specSha256: parent.specSha256,
      visualReferenceImages: parent.visualReferenceImages,
      promptSeed: `${parent.promptSeed}\nDerived from review candidate ${parent.jobId}; converted to a ${width}x${height}, ${fps} fps infinite-loop AVIF${pingPong ? " using ping-pong forward/reverse playback to close the loop" : ""} with mild sharpening.`,
      promptVersion: pingPong ? "kling-mp4-to-avif-v5-ping-pong" : "kling-mp4-to-avif-v4", candidatePath: outputPath,
      outputSha256: sha256(bytes), outputBytes: bytes.length, outputMime: "image/avif", outputWidth: width, outputHeight: height,
      generatedAt: new Date().toISOString(),
      cost: { status: "ACTUAL", amount: 0, currency: "USD", basis: "local transcode; no generation API call" },
      derivedFrom: { jobId: parent.jobId, sourceSha256: parent.outputSha256, crop: { x: 0, y: 0, width: sourceWidth, height: sourceHeight }, tool: `ffmpeg libaom-av1 + avifdec validation${pingPong ? " + ping-pong loop" : ""}` },
      animation: { frameCount, columns: frameCount, rows: 1, frameWidth: width, frameHeight: height, framesPerSecond: fps, repeatCount: 0, loopMode: pingPong ? "ping-pong" : "forward" },
    };
    await writeJob(job);
    console.log(`Animated AVIF candidate saved: ${outputPath}\n${frameCount} frames, ${width}x${height}, ${fps} fps, infinite loop, ${(bytes.length / 1024).toFixed(1)} KiB. Review before approval/publish.`);
  } catch (error) {
    throw new Error(`Kling video-to-AVIF conversion failed: ${safeMessage(error)}. Install ffmpeg with libaom-av1 and libavif (avifdec).`);
  }
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
  const refs: Array<{ path: string; hash: string; mimeType: Exclude<ImageReferenceInput["mimeType"], undefined>; bytes: Buffer }> = [];
  let totalBytes = 0;
  for (const reference of spec.visualReferenceImages ?? []) {
    const path = resolveRepoPath(reference.path);
    const extension = extname(path).toLowerCase();
    let mimeType: Exclude<ImageReferenceInput["mimeType"], undefined>;
    if (extension === ".png") mimeType = "image/png";
    else if (extension === ".webp") mimeType = "image/webp";
    else if (extension === ".jpg" || extension === ".jpeg") mimeType = "image/jpeg";
    else throw new Error(`Unsupported visual reference format: ${reference.path}`);
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
