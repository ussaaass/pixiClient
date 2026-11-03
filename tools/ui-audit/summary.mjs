/**
 * 汇总 dom-*.json：逐路由表格 + 合计。
 *
 * 用法：node summary.mjs results/<label> [--json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] || 'results');
const asJson = process.argv.includes('--json');
const files = readdirSync(dir).filter((name) => /^dom-.*\.json$/.test(name));

/** 取 URL 的 pathname；相对路径需要 base，解析失败返回空串。 */
const pathOf = (url) => {
  try {
    return new URL(url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  } catch {
    return '';
  }
};

for (const file of files) {
  const payload = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  // probe 路由（需要真实实体 ID 但 dev 数据里不存在）会落入空态或回退到大厅，
  // 会污染基线合计，因此单独列出、不计入汇总。带 dynamic 段但能正常渲染的页面仍计入。
  const dynamicRows = payload.results.filter((row) => row.probe);
  const all = payload.results.filter((row) => !row.error && !row.probe);
  // 必须比较完整 pathname：用 endsWith 会把 /support -> /messages/support 这类
  // 后缀相同的跳转误判为「未跳转」，从而把同一页面统计两次。
  const redirected = all.filter((row) => row.finalUrl && pathOf(row.finalUrl) !== pathOf(row.path));
  const rows = all.filter((row) => !redirected.includes(row));
  const failed = payload.results.filter((row) => row.error);
  const sum = (key) => rows.reduce((total, row) => total + (row[key] || 0), 0);
  const summary = {
    app: payload.meta.app,
    commit: payload.meta.commit,
    viewport: `${payload.meta.viewport.width}x${payload.meta.viewport.height}`,
    routes: rows.length,
    manifest: payload.results.length,
    dynamicExcluded: dynamicRows.map((row) => row.path),
    redirected: redirected.map((row) => row.path),
    failed: failed.length,
    containers: sum('containers'),
    nested: sum('nested'),
    deep: sum('deep'),
    maxDepth: Math.max(0, ...rows.map((row) => row.maxDepth || 0)),
    controls: sum('controls'),
    grids: sum('grids'),
    filled: sum('filled'),
    filledNested: sum('filledNested'),
    adjacentDoubleBorder: sum('adjacentDoubleBorder'),
    nestedRatio: rows.length ? Number((sum('nested') / Math.max(1, sum('containers'))).toFixed(3)) : 0,
    pagesWithNesting: rows.filter((row) => row.nested > 0).length,
    edgesPerPage: rows.length ? Number(((sum('containers') + sum('controls') + sum('grids')) / rows.length).toFixed(1)) : 0,
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 1));
    continue;
  }

  console.log(`\n== ${summary.app} @ ${summary.commit} ${summary.viewport}：${summary.routes} 条可测路由（失败 ${summary.failed}，重定向 ${summary.redirected.length}，动态实体另计 ${summary.dynamicExcluded.length}）`);
  if (summary.redirected.length) console.log(`  重定向未计入：${summary.redirected.join(', ')}`);
  if (summary.dynamicExcluded.length) console.log(`  动态实体未计入：${summary.dynamicExcluded.join(', ')}`);
  console.log(`容器 ${summary.containers}｜嵌套 ${summary.nested}（${(summary.nestedRatio * 100).toFixed(0)}%）｜最深 ${summary.maxDepth}｜控件 ${summary.controls}｜表格线 ${summary.grids}｜填充块 ${summary.filled}（嵌套 ${summary.filledNested}）｜单页边框元素均值 ${summary.edgesPerPage}`);
  const top = [...rows]
    .map((row) => ({ path: row.path, edges: (row.containers || 0) + (row.controls || 0) + (row.grids || 0), nested: row.nested, max: row.maxDepth }))
    .sort((a, b) => b.edges - a.edges)
    .slice(0, 10);
  for (const row of top) console.log(`  ${String(row.edges).padStart(3)}  ${row.path}  (嵌套 ${row.nested}, 最深 ${row.max})`);
}
