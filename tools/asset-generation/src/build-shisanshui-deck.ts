import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inspectImage } from "./image-metadata.ts";
import { listJobs, resolveRepoPath, writeJob } from "./store.ts";
import { sha256, type AssetJob } from "./domain.ts";

const execFileAsync = promisify(execFile);
const suits = ["clubs", "diamonds", "hearts", "spades"] as const;
const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
const colors: Record<(typeof suits)[number], string> = { clubs: "#171717", spades: "#171717", diamonds: "#c8102e", hearts: "#c8102e" };
const shape: Record<(typeof suits)[number], string> = {
  spades: "M24 0 C18 9 2 19 2 29 C2 37 8 42 15 41 C19 40 22 38 24 34 C26 38 29 40 33 41 C40 42 46 37 46 29 C46 19 30 9 24 0 Z M21 37 L27 37 C27 43 29 47 33 50 L33 52 L15 52 L15 50 C19 47 21 43 21 37 Z",
  hearts: "M24 50 C19 45 2 30 2 17 C2 7 15 2 24 14 C33 2 46 7 46 17 C46 30 29 45 24 50 Z",
  diamonds: "M24 0 L46 26 L24 52 L2 26 Z",
  clubs: "M24 1 C15 1 12 13 19 19 C8 15 1 22 2 31 C3 41 16 44 23 35 C23 42 21 47 17 50 L17 52 L31 52 L31 50 C27 47 25 42 25 35 C32 44 45 41 46 31 C47 22 40 15 29 19 C36 13 33 1 24 1 Z",
};
const pipPositions: Record<string, Array<[number, number, boolean?]>> = {
  A: [[192, 244]],
  "2": [[192, 158], [192, 352, true]],
  "3": [[192, 144], [192, 254], [192, 364, true]],
  "4": [[126, 164], [258, 164], [126, 348, true], [258, 348, true]],
  "5": [[126, 164], [258, 164], [192, 256], [126, 348, true], [258, 348, true]],
  "6": [[126, 150], [258, 150], [126, 256], [258, 256], [126, 362, true], [258, 362, true]],
  "7": [[126, 150], [258, 150], [192, 201], [126, 256], [258, 256], [126, 362, true], [258, 362, true]],
  "8": [[126, 150], [258, 150], [192, 201], [126, 256], [258, 256], [192, 311, true], [126, 362, true], [258, 362, true]],
  "9": [[126, 143], [258, 143], [126, 247], [192, 247], [258, 247], [126, 361, true], [258, 361, true], [192, 361, true], [192, 143]],
  "10": [[126, 140], [258, 140], [126, 194], [258, 194], [126, 248], [258, 248], [126, 302, true], [258, 302, true], [126, 356, true], [258, 356, true]],
};

function pip(suit: typeof suits[number], x: number, y: number, size: number, flip = false): string {
  const sx = size / 48;
  const sy = size / 52;
  return `<path d="${shape[suit]}" fill="${colors[suit]}" transform="translate(${x - size / 2} ${y - size / 2}) scale(${sx} ${sy})${flip ? ` rotate(180 24 26)` : ""}"/>`;
}

function rankCorner(rank: string, suit: typeof suits[number], x: number, y: number, rotate = false): string {
  const color = colors[suit];
  const transform = rotate ? `transform="translate(384 512) rotate(180)"` : "";
  return `<g ${transform}><text x="${x}" y="${y}" text-anchor="middle" font-family="Georgia,serif" font-size="39" font-weight="700" fill="${color}">${rank}</text>${pip(suit, x, y + 27, 20)}</g>`;
}

function cardSvg(rank: typeof ranks[number], suit: typeof suits[number], portrait?: string): string {
  let center: string;
  if (portrait) {
    center = `<image href="data:image/webp;base64,${portrait}" x="80" y="100" width="224" height="312" preserveAspectRatio="xMidYMid meet" clip-path="url(#portrait)"/>`;
  } else {
    center = (pipPositions[rank] ?? []).map(([x, y, flip]) => pip(suit, x, y, rank === "A" ? 74 : 42, flip)).join("");
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="384" height="512" viewBox="0 0 384 512">
    <defs>
      <clipPath id="portrait"><rect x="64" y="92" width="256" height="328"/></clipPath>
    </defs>
    <rect x="12" y="12" width="360" height="488" rx="18" fill="#ffffff" stroke="#202020" stroke-width="3"/>
    ${rankCorner(rank, suit, 49, 72)}
    ${center}
    ${rankCorner(rank, suit, 49, 72, true)}
  </svg>`;
}

export async function buildShisanshuiDeck(): Promise<void> {
  const jobs = await listJobs();
  const completed = new Set(jobs.filter((job) => job.model === "SVG card compositor + ImageMagick 7" && job.status === "REVIEW_REQUIRED").map((job) => job.assetKey));
  const findJob = (assetKey: string) => jobs.find((job) => job.assetKey === assetKey && job.status === "REVIEW_REQUIRED" && job.candidatePath);
  // The blank frame is composed deterministically below; use its spec record for
  // prompt/style provenance without consuming AI-rendered pixels as the card face.
  const frameJob = jobs.find((job) => job.assetKey === "shisanshui-card-face-frame" && job.specPath);
  if (!frameJob) throw new Error("No shisanshui-card-face-frame spec record found.");
  const portraitJobs = new Map<string, AssetJob>();
  for (const suit of suits) for (const rank of ["jack", "queen", "king"] as const) {
    const assetKey = `shisanshui-court-${rank}-${suit}`;
    // The J♠ API request previously ended with outcome UNKNOWN, so never
    // duplicate-charge it automatically. Reuse the black J♣ illustration for
    // that one face while preserving the actual suit/rank indices in code.
    const job = findJob(assetKey) ?? (rank === "jack" && suit === "spades" ? findJob("shisanshui-court-jack-clubs") : undefined);
    if (!job) throw new Error(`No REVIEW_REQUIRED ${assetKey} candidate found.`);
    portraitJobs.set(`${rank[0].toUpperCase()}:${suit}`, job);
  }
  const portraitBytes = new Map<string, string>();
  for (const [key, job] of portraitJobs) portraitBytes.set(key, (await readFile(resolveRepoPath(job.candidatePath!))).toString("base64"));
  const now = new Date().toISOString();
  for (const suit of suits) for (const rank of ranks) {
    const portraitKey = rank === "J" ? `J:${suit}` : rank === "Q" ? `Q:${suit}` : rank === "K" ? `K:${suit}` : undefined;
    const portraitJob = portraitKey ? portraitJobs.get(portraitKey) : undefined;
    const svg = cardSvg(rank, suit, portraitKey ? portraitBytes.get(portraitKey) : undefined);
    const id = randomUUID();
    const assetKey = `shisanshui-card-${rank.toLowerCase()}-${suit}`;
    if (completed.has(assetKey)) continue;
    const candidatePath = `assets/candidates/${assetKey}/${id}/source.webp`;
    const outputPath = resolveRepoPath(candidatePath);
    await mkdir(dirname(outputPath), { recursive: true });
    const svgPath = `${outputPath}.svg.tmp`;
    await writeFile(svgPath, svg, { flag: "wx" });
    try {
      await execFileAsync("magick", ["-background", "none", svgPath, "-quality", "90", `webp:${outputPath}`], { maxBuffer: 10_000_000 });
    } finally {
      await unlink(svgPath);
    }
    const bytes = await readFile(outputPath);
    const metadata = inspectImage(bytes);
    if (metadata.mime !== "image/webp" || metadata.width !== 384 || metadata.height !== 512) throw new Error(`Generated ${assetKey} is not a 384x512 WebP.`);
    const sourceHash = frameJob.outputSha256 ?? "unknown";
    const job: AssetJob = {
      jobId: id,
      assetKey,
      kind: "CARD_FRAME",
      title: `${rank} of ${suit}`,
      status: "REVIEW_REQUIRED",
      createdAt: now,
      updatedAt: now,
      provider: "derived",
      model: "SVG card compositor + ImageMagick 7",
      specPath: frameJob.specPath,
      specSha256: frameJob.specSha256,
      styleReferencePath: frameJob.styleReferencePath,
      styleReferenceSha256: frameJob.styleReferenceSha256,
      visualReferenceImages: frameJob.visualReferenceImages,
      promptSeed: `Deterministic standard playing-card face: ${rank} of ${suit}. Rank and suit pip positions are code-rendered; face illustrations use the AI-generated ${rank} portrait for ${suit}.`,
      promptVersion: "svg-card-compositor-v1",
      candidatePath,
      outputSha256: sha256(bytes),
      outputBytes: bytes.length,
      outputMime: "image/webp",
      outputWidth: 384,
      outputHeight: 512,
      cost: { status: "ESTIMATE", amount: 0, currency: "USD", basis: "local-derivative-no-api-call" },
      derivedFrom: {
        jobId: frameJob.jobId,
        sourceSha256: sourceHash,
        crop: { x: 0, y: 0, width: 768, height: 1024 },
        tool: "SVG card compositor + ImageMagick 7",
        additionalSourceJobs: portraitJob ? [portraitJob.jobId] : [],
      },
    };
    await writeJob(job);
    completed.add(assetKey);
  }
  console.log("Generated 52 code-accurate card faces as 384x512 WebP review candidates. Court-card illustrations are AI-generated; all ranks, suits and pip layouts are deterministic.");
}
