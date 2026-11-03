#!/usr/bin/env node
/**
 * OpenAPI 生成器。
 *
 * 从 `packages/contracts/src/openapi/registry.ts` 读取端点注册表，
 * 把 TypeBox schema 原样写成 OpenAPI 3.1 JSON。
 *
 * 用 `tsx` 运行（`apps/server` 同款 devDependency，pnpm hoist 到根 node_modules），
 * 避免引入 tsup/esbuild 等额外构建依赖。
 *
 * 用法（从仓库根目录执行）：
 *   pnpm --filter @gameing/contracts openapi          # 生成 dist/openapi.json
 *   pnpm --filter @gameing/contracts openapi:check    # 对比上次产物，CI diff 用
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, 'dist');
const outFile = resolve(outDir, 'openapi.json');
const checkOnly = globalThis.process?.argv.includes('--check') ?? false;
const log = globalThis.console ?? { log() {}, error() {} };
const exit = (code) => globalThis.process?.exit(code);

// tsx 在 CJS 侧注册 --import tsx/esm 之后，ESM 可以正常 import 同名 .ts。
// 这里用 dynamic import 延迟加载 registry，确保 tsx 钩子已经装好。
const { buildOpenApiDocument } = await import('./src/openapi/registry.ts');

const doc = buildOpenApiDocument();
const json = JSON.stringify(doc, null, 2) + '\n';

if (checkOnly && existsSync(outFile)) {
  const previous = readFileSync(outFile, 'utf8');
  if (previous === json) {
    log.log('[openapi:check] in sync with dist/openapi.json');
    exit(0);
  } else {
    log.error('[openapi:check] out of sync with dist/openapi.json');
    log.error('Run `pnpm --filter @gameing/contracts openapi` to regenerate.');
    exit(1);
  }
} else {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, json, 'utf8');
  log.log(`[openapi] wrote ${outFile}`);
}
