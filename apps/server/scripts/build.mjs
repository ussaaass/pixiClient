#!/usr/bin/env node
/**
 * 生产打包脚本。
 *
 * 为什么不用 `tsc` 直接产出可运行产物：
 * `@gameing/contracts` 等工作区包以 TypeScript 源码形式被导出（exports 指向 `src/*.ts`），
 * `tsc` 编译出的 JS 在运行时无法解析这些 `.ts` 源文件。
 * 这里用 esbuild 把服务端连同工作区依赖打成一个自包含的 ESM 文件，
 * 生产镜像只需 `node dist/server.js`，不需要携带 TS 源码与 workspace 链接。
 *
 * 契约包只打包被引用的具体入口（`@gameing/contracts/health` 等），
 * 未被引用的契约模块不会进入产物。
 *
 * Sequelize 内置多 dialect 驱动（pg/oracledb/sqlite 等），本项目只使用 mysql2；
 * 这些 peer 依赖不在锁文件中（P0 基线有意移除），esbuild 必须标记为 external，
 * 否则 postgres dialect 的 `require("pg-hstore")` 会在 bundle 阶段报错。
 */

import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const outfile = resolve(packageRoot, 'dist/server.js');

await mkdir(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [resolve(packageRoot, 'src/main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  // 生产环境不内联 sourcemap 内容到产物注释，避免泄漏源码路径结构。
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  // Sequelize 内置多 dialect 驱动（pg/oracledb/sqlite 等），本项目只使用 mysql2；
  // 这些 peer 依赖不在锁文件中（P0 基线有意移除），esbuild 必须标记为 external，
  // 否则 postgres dialect 的 `require("pg-hstore")` 会在 bundle 阶段报错。
  external: ['pg', 'pg-hstore', 'oracledb', 'snowflake-sdk', 'sqlite3', 'mariadb', 'ibm_db'],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  metafile: true,
});

const outputBytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
process.stdout.write(`生产产物已生成：${outfile}（${(outputBytes / 1024).toFixed(1)} KiB）\n`);
