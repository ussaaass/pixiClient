/**
 * 样式层统计（静态）：边框/背景/圆角/自定义属性的分布。
 *
 * 用法：node css-stats.mjs --root apps/web/src --out results/<label>/css-web.json
 *
 * 口径（与报告一致，均可在此复现）：
 * - declarations：所有 CSS 规则体内的 `prop: value` 对数，含 .vue 的 <style> 块。
 * - borderSelectors：规则体中出现任一非 none 边框长/简写的规则数。
 * - cardRules：同时设置边框与非透明背景的规则数。
 * - cardClasses：上述规则选择器中出现的不同类名数量（**只代表出现过的类名，不代表未被复用**）。
 * - borderDecls：`border` / `border-*` 声明条数；borderColors 为其颜色字面量去重数（hex/rgb/hsl/var）。
 * - radiusValues：`border-radius` 取值去重数（按文本归一化）。
 * - customProperties：文件中出现过的 `--name:` 定义去重数。
 */
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const root = resolve(arg('root', 'apps/web/src'));
const out = resolve(arg('out', 'results/adhoc/css.json'));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'node_modules' || name === 'dist' || name === 'dist-dev') return [];
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(root).filter((file) => ['.css', '.vue'].includes(extname(file)));
const RULE = /([^{}]+)\{([^{}]*)\}/gs;

const stats = {
  root: relative(process.cwd(), root),
  files: files.length,
  declarations: 0,
  borderSelectors: 0,
  cardRules: 0,
  borderDecls: 0,
  radiusDecls: 0,
  shadowDecls: 0,
  cardClasses: new Set(),
  borderColors: new Set(),
  radiusValues: new Set(),
  customProperties: new Set(),
  perFile: {},
};

for (const file of files) {
  let text = readFileSync(file, 'utf8');
  if (file.endsWith('.vue')) text = (text.match(/<style[^>]*>([\s\S]*?)<\/style>/g) || []).join('\n');
  if (!text.trim()) continue;

  for (const match of text.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) stats.customProperties.add(match[1]);

  let localBorder = 0;
  for (const [, rawSelector, body] of text.matchAll(RULE)) {
    const selector = rawSelector.replace(/\s+/g, ' ').trim();
    if (!selector || selector.startsWith('@')) continue;
    const decls = body.split(';').map((d) => d.trim()).filter((d) => d.includes(':'));
    stats.declarations += decls.length;

    const borderDecls = decls.filter((d) => /^border(-(top|right|bottom|left))?(-(width|style|color))?\s*:/.test(d));
    const visibleBorders = borderDecls.filter((d) => !/:\s*(none|0)\b/.test(d) && !/style\s*:\s*none/.test(d));
    const background = decls.filter((d) => /^background(-color)?\s*:/.test(d) && !/transparent/.test(d));
    const radius = decls.filter((d) => /^border-radius\s*:/.test(d));
    const shadow = decls.filter((d) => /^box-shadow\s*:/.test(d) && !/:\s*none/.test(d));

    stats.borderDecls += borderDecls.length;
    stats.radiusDecls += radius.length;
    stats.shadowDecls += shadow.length;
    for (const d of borderDecls) {
      for (const color of d.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|var\(--[a-zA-Z0-9-]+\)/g) || []) {
        stats.borderColors.add(color.toLowerCase());
      }
    }
    for (const d of radius) stats.radiusValues.add(d.split(':')[1].trim().replace(/\s+/g, ' '));

    if (visibleBorders.length) {
      stats.borderSelectors += 1;
      localBorder += 1;
    }
    if (visibleBorders.length && background.length) {
      stats.cardRules += 1;
      for (const cls of selector.match(/\.([a-zA-Z0-9_-]+)/g) || []) stats.cardClasses.add(cls.slice(1));
    }
  }
  if (localBorder) stats.perFile[relative(root, file)] = localBorder;
}

const payload = {
  root: stats.root,
  files: stats.files,
  declarations: stats.declarations,
  borderSelectors: stats.borderSelectors,
  cardRules: stats.cardRules,
  borderDecls: stats.borderDecls,
  radiusDecls: stats.radiusDecls,
  shadowDecls: stats.shadowDecls,
  cardClasses: stats.cardClasses.size,
  borderColors: stats.borderColors.size,
  radiusValues: stats.radiusValues.size,
  customProperties: stats.customProperties.size,
  radiusValueList: [...stats.radiusValues].sort(),
  borderColorList: [...stats.borderColors].sort(),
  topFiles: Object.entries(stats.perFile).sort((a, b) => b[1] - a[1]).slice(0, 10),
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(payload, null, 1));
console.log(JSON.stringify({ ...payload, borderColorList: undefined, radiusValueList: undefined }, null, 1));
