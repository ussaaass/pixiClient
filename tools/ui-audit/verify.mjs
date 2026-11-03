/**
 * 一次性打印报告里引用的所有口径数字，便于逐项核对。
 *
 * 用法：node verify.mjs results/<label>
 *
 * 与 summary.mjs 的区别：summary 面向「读人」的单端汇总，本脚本把
 * 桌面/移动、admin/web、样式层与 DOM 层的口径数字集中输出，
 * 便于把文档里的每个数字回指到具体 JSON。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] || 'results');
const pathOf = (url) => {
  try {
    return new URL(url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  } catch {
    return '';
  }
};

/** 读 dom-*.json，返回「可测」行：无 error、非 probe、最终 pathname 与声明一致。 */
function loadDom(file) {
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  const measured = payload.results.filter((row) => !row.error);
  const usable = measured.filter((row) => !row.probe && pathOf(row.finalUrl) === pathOf(row.path));
  return {
    meta: payload.meta,
    declared: payload.results.length,
    usable,
    redirected: measured.filter((row) => !row.probe && pathOf(row.finalUrl) !== pathOf(row.path)),
    probes: measured.filter((row) => row.probe),
    failed: payload.results.filter((row) => row.error),
  };
}

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0);
const edges = (row) => (row.containers || 0) + (row.controls || 0) + (row.grids || 0);

for (const [name, file] of [
  ['admin 1440x900', join(dir, 'dom-admin.json')],
  ['web   1440x900', join(dir, 'dom-web.json')],
  ['web   390x844', join(dir, 'mobile390/dom-web.json')],
]) {
  let dom;
  try {
    dom = loadDom(file);
  } catch {
    console.log(`\n== ${name}：缺少 ${file}，跳过`);
    continue;
  }
  const rows = dom.usable;
  const totalEdges = sum(rows, 'containers') + sum(rows, 'controls') + sum(rows, 'grids');
  console.log(`\n== ${name}  commit=${dom.meta.commit}  viewport=${dom.meta.viewport.width}x${dom.meta.viewport.height}`);
  console.log(`  清单 ${dom.declared} ｜ 可测 ${rows.length} ｜ 重定向 ${dom.redirected.length} ｜ probe ${dom.probes.length} ｜ 失败 ${dom.failed.length}`);
  if (dom.redirected.length) console.log(`  重定向：${dom.redirected.map((row) => row.path).join(', ')}`);
  console.log(`  容器 ${sum(rows, 'containers')} ｜ 嵌套 ${sum(rows, 'nested')}（${((sum(rows, 'nested') / Math.max(1, sum(rows, 'containers'))) * 100).toFixed(0)}%）`);
  console.log(`  控件 ${sum(rows, 'controls')} ｜ 表格线 ${sum(rows, 'grids')} ｜ 同屏边框元素合计 ${totalEdges} ｜ 单页均值 ${(totalEdges / Math.max(1, rows.length)).toFixed(1)}`);
  console.log(`  填充块 ${sum(rows, 'filled')}（嵌套 ${sum(rows, 'filledNested')}）`);
  console.log(`  最深 ${Math.max(0, ...rows.map((row) => row.maxDepth || 0))} ｜ 有嵌套的页 ${rows.filter((row) => row.nested > 0).length}/${rows.length}`);
  console.log(`  深度≥3 的页：${rows.filter((row) => row.maxDepth >= 3).map((row) => row.path).join(', ') || '无'}`);
  const top = [...rows].sort((a, b) => edges(b) - edges(a)).slice(0, 5);
  console.log(`  最密 5 页：${top.map((row) => `${row.path}=${edges(row)}`).join('  ')}`);
}

for (const [name, file] of [
  ['css web', join(dir, 'css-web.json')],
  ['css admin', join(dir, 'css-admin.json')],
]) {
  let css;
  try {
    css = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.log(`\n== ${name}：缺少 ${file}，跳过`);
    continue;
  }
  const solid = css.borderColorList.filter((color) => /^#[0-9a-f]{6}$/i.test(color));
  const alpha = css.borderColorList.filter((color) => /^#[0-9a-f]{8}$/i.test(color));
  const rgb = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  // 「肉眼难辨」：与另一种颜色的 R/G/B 三通道差值都 ≤ 8
  const nearDuplicates = solid.filter((color) => {
    const base = rgb(color);
    return solid.some((other) => other !== color && rgb(other).every((value, index) => Math.abs(value - base[index]) <= 8));
  });
  console.log(`\n== ${name}  root=${css.root}`);
  console.log(`  文件 ${css.files} ｜ 声明 ${css.declarations} ｜ 边框选择器 ${css.borderSelectors} ｜ cardRules ${css.cardRules}`);
  console.log(`  borderDecls ${css.borderDecls} ｜ radiusDecls ${css.radiusDecls} ｜ shadowDecls ${css.shadowDecls}`);
  console.log(`  cardClasses ${css.cardClasses} ｜ borderColors ${css.borderColors}（8 位 ${alpha.length} / 6 位 ${solid.length}）｜ radiusValues ${css.radiusValues} ｜ customProperties ${css.customProperties}`);
  console.log(`  6 位实色中与另一色三通道差 ≤8 的：${nearDuplicates.length}/${solid.length}`);
}
