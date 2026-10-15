import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { inspectImage } from "./image-metadata.ts";
import { listJobs, readJob, repoRoot, resolveRepoPath, writeJob } from "./store.ts";
import { sha256, type AssetJob } from "./domain.ts";

const execFileAsync = promisify(execFile);
const GRID = 5;
const TOOL = "ImageMagick 7 crop-avatar-sheets v1";

export async function cropAvatarSheets(femaleJobId: string, maleJobId: string): Promise<void> {
  const sources = [
    { gender: "female", jobId: femaleJobId },
    { gender: "male", jobId: maleJobId },
  ];
  const priorJobs = await listJobs();
  for (const { gender, jobId } of sources) {
    const parent = await readJob(jobId);
    if (parent.status !== "REVIEW_REQUIRED" || parent.assetKey !== `avatar-sheet-${gender}` || !parent.candidatePath) {
      throw new Error(`Expected a REVIEW_REQUIRED avatar-sheet-${gender} job with a candidate path: ${jobId}`);
    }
    const sourcePath = resolveRepoPath(parent.candidatePath);
    const sourceBytes = await readFile(sourcePath);
    const image = inspectImage(sourceBytes);
    if (image.mime !== "image/webp" || image.width !== 1600 || image.height !== 1600) {
      throw new Error(`${parent.candidatePath} must be a 1600x1600 WebP image; got ${image.width}x${image.height} ${image.mime}.`);
    }
    const sourceHash = sha256(sourceBytes);
    for (let row = 0; row < GRID; row++) {
      for (let column = 0; column < GRID; column++) {
        const index = row * GRID + column + 1;
        const childId = randomUUID();
        const crop = { x: column * 320, y: row * 320, width: 320, height: 320 };
        const assetKey = `player-avatar-${gender}-${String(index).padStart(2, "0")}`;
        if (priorJobs.some((job) => job.assetKey === assetKey && job.status === "REVIEW_REQUIRED" && job.derivedFrom?.jobId === parent.jobId)) continue;
        const candidatePath = `assets/candidates/${assetKey}/${childId}/source.webp`;
        const targetPath = resolveRepoPath(candidatePath);
        await mkdir(dirname(targetPath), { recursive: true });
        await execFileAsync("magick", [sourcePath, "-crop", `${crop.width}x${crop.height}+${crop.x}+${crop.y}`, "+repage", "-quality", "88", `webp:${targetPath}`]);
        const bytes = await readFile(targetPath);
        const metadata = inspectImage(bytes);
        if (metadata.mime !== "image/webp" || metadata.width !== crop.width || metadata.height !== crop.height) {
          throw new Error(`Avatar crop ${assetKey} was not encoded as a 320x320 WebP.`);
        }
        const now = new Date().toISOString();
        const job: AssetJob = {
          jobId: childId,
          assetKey,
          kind: "AVATAR",
          title: `${gender === "female" ? "女性" : "男性"}玩家头像 ${String(index).padStart(2, "0")}`,
          status: "REVIEW_REQUIRED",
          createdAt: now,
          updatedAt: now,
          provider: "derived",
          model: "ImageMagick 7 local derivation",
          specPath: parent.specPath,
          specSha256: parent.specSha256,
          styleReferencePath: parent.styleReferencePath,
          styleReferenceSha256: parent.styleReferenceSha256,
          visualReferenceImages: parent.visualReferenceImages,
          promptSeed: parent.promptSeed,
          promptVersion: parent.promptVersion,
          finalPrompt: parent.finalPrompt,
          promptResponseId: parent.promptResponseId,
          imageRequestId: parent.imageRequestId,
          generatedAt: parent.generatedAt,
          candidatePath,
          outputSha256: sha256(bytes),
          outputBytes: bytes.length,
          outputMime: "image/webp",
          outputWidth: crop.width,
          outputHeight: crop.height,
          cost: { status: "ESTIMATE", amount: 0, currency: "USD", basis: "local-derivative-no-api-call; generation cost is recorded on parent job" },
          derivedFrom: { jobId: parent.jobId, sourceSha256: sourceHash, crop, tool: TOOL },
        };
        await writeJob(job);
      }
    }
    console.log(`Cropped 25 ${gender} avatars from ${parent.candidatePath} into review candidates.`);
  }
  console.log(`Derived avatar candidates are under ${repoRoot}/assets/candidates/player-avatars/; each image has its own review job and parent-sheet provenance.`);
}

export async function buildAvifAnimation(sourceJobId: string): Promise<void> {
  const parent = await readJob(sourceJobId);
  if (parent.status !== "REVIEW_REQUIRED" || !parent.candidatePath || !parent.assetKey.startsWith("shisanshui-motion-")) {
    throw new Error(`Expected a REVIEW_REQUIRED Shisanshui motion-sheet job with a candidate path: ${sourceJobId}`);
  }
  const sourcePath = resolveRepoPath(parent.candidatePath);
  const sourceBytes = await readFile(sourcePath);
  const image = inspectImage(sourceBytes);
  if (image.mime !== "image/webp" || image.width !== 1600 || image.height !== 1600) {
    throw new Error(`${parent.candidatePath} must be a 1600x1600 WebP sequence sheet; got ${image.width}x${image.height} ${image.mime}.`);
  }
  const alpha = await execFileAsync("magick", ["identify", "-format", "%[channels]", sourcePath]);
  if (!alpha.stdout.includes("a")) throw new Error("Motion sheet has no alpha channel; preserving transparency is required for Pixi overlays.");
  const existing = (await listJobs()).find((job) => job.assetKey === parent.assetKey && job.status === "REVIEW_REQUIRED" && job.derivedFrom?.jobId === parent.jobId && job.outputMime === "image/avif");
  if (existing) {
    console.log(`AVIF candidate already exists for ${parent.assetKey}: ${existing.candidatePath}`);
    return;
  }

  const id = randomUUID();
  const candidatePath = `assets/candidates/${parent.assetKey}/${id}/source.avif`;
  const outputPath = resolveRepoPath(candidatePath);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "shisanshui-avif-"));
  const framePaths: string[] = [];
  let generated = false;
  try {
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        const frameIndex = row * 4 + column;
        const framePath = resolve(temporaryDirectory, `frame-${String(frameIndex).padStart(2, "0")}.png`);
        await execFileAsync("magick", [sourcePath, "-crop", `400x400+${column * 400}+${row * 400}`, "+repage", `png:${framePath}`]);
        framePaths.push(framePath);
      }
    }
    await execFileAsync("avifenc", ["--repetition-count", "0", "--timescale", "12", "--qcolor", "72", "--qalpha", "85", "-j", "4", ...framePaths, outputPath]);
    const verification = await execFileAsync("avifdec", ["--info", outputPath], { maxBuffer: 2_000_000 });
    if (!/Alpha\s*:/m.test(verification.stdout) || !verification.stdout.includes("Image Sequence Frames: (16 expected frames)")) {
      throw new Error("AVIF validation failed: expected alpha and exactly 16 animation frames.");
    }
    const outputBytes = await readFile(outputPath);
    const outputStats = await (await import("node:fs/promises")).stat(outputPath);
    const now = new Date().toISOString();
    const job: AssetJob = {
    jobId: id,
    assetKey: parent.assetKey,
    kind: "EFFECT",
    title: `${parent.title}（AVIF 动画）`,
    status: "REVIEW_REQUIRED",
    createdAt: now,
    updatedAt: now,
    provider: "derived",
    model: "libavif avifenc",
    specPath: parent.specPath,
    specSha256: parent.specSha256,
    styleReferencePath: parent.styleReferencePath,
    styleReferenceSha256: parent.styleReferenceSha256,
    visualReferenceImages: parent.visualReferenceImages,
    promptSeed: parent.promptSeed,
    promptVersion: parent.promptVersion,
    finalPrompt: parent.finalPrompt,
    promptResponseId: parent.promptResponseId,
    imageRequestId: parent.imageRequestId,
    generatedAt: now,
    candidatePath,
    outputSha256: sha256(outputBytes),
    outputBytes: outputStats.size,
    outputMime: "image/avif",
    outputWidth: 400,
    outputHeight: 400,
    cost: { status: "ESTIMATE", amount: 0, currency: "USD", basis: "local-derivative-no-api-call; image generation cost is recorded on parent job" },
    derivedFrom: {
      jobId: parent.jobId,
      sourceSha256: sha256(sourceBytes),
      crop: { x: 0, y: 0, width: 1600, height: 1600 },
      tool: "ImageMagick 7 crop + libavif avifenc",
    },
    animation: { frameCount: 16, columns: 4, rows: 4, frameWidth: 400, frameHeight: 400, framesPerSecond: 12, repeatCount: 0 },
    };
    await writeJob(job);
    generated = true;
    console.log(`AVIF candidate saved: ${candidatePath}\nValidated: 16 frames, 400x400, alpha, 12 fps, one play-through. Status: REVIEW_REQUIRED.`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
    if (!generated) await rm(outputPath, { force: true });
  }
}
