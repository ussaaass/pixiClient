import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AssetJob } from "./domain.ts";

export const repoRoot = resolve(import.meta.dirname, "../../../");
const jobDir = resolve(repoRoot, "assets/provenance/jobs");

export function resolveRepoPath(path: string): string {
  const absolute = resolve(repoRoot, path);
  if (absolute !== repoRoot && !absolute.startsWith(`${repoRoot}/`)) throw new Error(`Path escapes repository root: ${path}`);
  return absolute;
}

export async function writeJob(job: AssetJob): Promise<void> {
  await mkdir(jobDir, { recursive: true });
  const target = resolve(jobDir, `${job.jobId}.json`);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  if (job.status === "APPROVED" || job.status === "PUBLISHED") {
    const approvedDir = resolve(repoRoot, "assets/provenance/approved");
    await mkdir(approvedDir, { recursive: true });
    const approvedPath = resolve(approvedDir, `${job.jobId}.json`);
    const approvedTemp = `${approvedPath}.tmp`;
    await writeFile(approvedTemp, `${JSON.stringify(job, null, 2)}\n`);
    await rename(approvedTemp, approvedPath);
  }
}

export async function readJob(jobId: string): Promise<AssetJob> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("Invalid job ID.");
  return JSON.parse(await readFile(resolve(jobDir, `${jobId}.json`), "utf8")) as AssetJob;
}

export async function listJobs(): Promise<AssetJob[]> {
  let entries;
  try {
    entries = await (await import("node:fs/promises")).readdir(jobDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jobs: AssetJob[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try { jobs.push(JSON.parse(await readFile(resolve(jobDir, entry.name), "utf8")) as AssetJob); } catch { /* ignore incomplete/corrupt local records */ }
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function copyDurably(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}
