/**
 * 边框套娃 / 表面层密度审计（运行时 DOM）
 *
 * 用法：
 *   node audit.mjs --app admin --out results/<label> [--shot] [--chrome <path>]
 *
 * 口径见 README.md。输出为原始 JSON，报告中的所有运行时数字都应能在此复现。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function findChrome() {
  const explicit = arg('chrome', process.env.CHROME_PATH);
  if (explicit) return explicit;
  const cache = join(process.env.HOME, 'Library/Caches/ms-playwright');
  for (const entry of ['chromium_headless_shell-1243', 'chromium_headless_shell-1223', 'chromium_headless_shell-1194']) {
    try {
      const path = join(cache, entry, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
      readFileSync(path);
      return path;
    } catch {
      /* try next */
    }
  }
  throw new Error('未找到 headless chromium，请通过 --chrome 指定可执行文件');
}

const app = arg('app', 'admin');
const outDir = resolve(arg('out', join(here, 'results', 'adhoc')));
const shot = process.argv.includes('--shot');
const only = arg('only', '');
const viewportArg = arg('viewport', '');
const manifest = JSON.parse(readFileSync(join(here, 'routes.json'), 'utf8'));
const target = manifest.apps[app];
if (!target) throw new Error(`routes.json 中不存在 app: ${app}`);
if (viewportArg) {
  const [width, height] = viewportArg.split('x').map(Number);
  if (!width || !height) throw new Error('--viewport 需形如 390x844');
  target.viewport = { width, height };
}
if (only) {
  const wanted = new Set(only.split(','));
  target.routes = target.routes.filter((route) => wanted.has(route.path));
}

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: resolve(here, '../..') }).toString().trim();

/** 页面内执行：统计表面层、控件、表格单元格与嵌套深度。 */
const MEASURE = () => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    if (rect.width < 40 || rect.height < 24) return false;
    return rect.bottom > 0 && rect.top < innerHeight + 4000;
  };
  const hasBorder = (style) => {
    const pairs = [
      [style.borderTopWidth, style.borderTopStyle],
      [style.borderRightWidth, style.borderRightStyle],
      [style.borderBottomWidth, style.borderBottomStyle],
      [style.borderLeftWidth, style.borderLeftStyle],
    ];
    return pairs.some(([width, kind]) => parseFloat(width) > 0 && kind !== 'none' && kind !== 'hidden');
  };
  const hasShadow = (style) => style.boxShadow !== 'none' && style.boxShadow.trim() !== '';
  const hasBg = (style) => {
    const color = style.backgroundColor;
    return color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent';
  };
  const radius = (style) => Math.max(
    ...[style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius]
      .map((value) => parseFloat(value) || 0),
  );

  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (['button', 'input', 'select', 'textarea', 'a', 'summary'].includes(tag) || el.getAttribute('role') === 'button') return 'control';
    if (['table', 'thead', 'tbody', 'tr', 'td', 'th'].includes(tag)) return 'grid';
    if (['div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'form', 'ul', 'ol', 'dl'].includes(tag)) return 'container';
    return 'other';
  };

  const nodes = [...document.querySelectorAll('body *')].filter((el) => {
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'svg', 'path', 'img', 'canvas', 'br', 'hr', 'input', 'option'].includes(tag)) return false;
    return visible(el);
  });

  const info = new Map();
  for (const el of nodes) {
    const style = getComputedStyle(el);
    info.set(el, {
      role: roleOf(el),
      border: hasBorder(style),
      shadow: hasShadow(style),
      bg: hasBg(style),
      radius: radius(style),
      filled: hasBg(style) && radius(style) >= 8,
    });
  }

  const surfaces = [...info.entries()].filter(([, value]) => (value.border || value.shadow) && value.role === 'container');
  const surfaceSet = new Set(surfaces.map(([el]) => el));
  const controls = [...info.entries()].filter(([, value]) => (value.border || value.shadow) && value.role === 'control');
  const grids = [...info.entries()].filter(([, value]) => (value.border || value.shadow) && value.role === 'grid');
  const filled = [...info.entries()].filter(([, value]) => value.filled);

  const label = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${cls}`;
  };
  const depthOf = (el, set) => {
    let depth = 0;
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      if (set.has(parent)) depth += 1;
      parent = parent.parentElement;
    }
    return depth + 1;
  };

  const dist = {};
  let sum = 0;
  for (const [el] of surfaces) {
    const depth = depthOf(el, surfaceSet);
    dist[depth] = (dist[depth] || 0) + 1;
    sum += depth;
  }
  const filledSet = new Set(filled.map(([el]) => el));
  const filledDist = {};
  for (const [el] of filled) {
    const depth = depthOf(el, filledSet);
    filledDist[depth] = (filledDist[depth] || 0) + 1;
  }

  // 相邻双线：自身有边框，且最近的带边框祖先与自身左上间距 < 2px
  let adjacentDoubleBorder = 0;
  for (const [el, value] of surfaces) {
    if (!value.border) continue;
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      const parentInfo = info.get(parent);
      if (parentInfo && parentInfo.border) {
        const outer = parent.getBoundingClientRect();
        const inner = el.getBoundingClientRect();
        if (Math.min(Math.abs(inner.left - outer.left), Math.abs(inner.top - outer.top)) < 2) adjacentDoubleBorder += 1;
        break;
      }
      parent = parent.parentElement;
    }
  }

  // 完整祖先链：surface=true 表示该节点参与边框嵌套计数，false 表示被省略的中间节点
  const chainOf = (el) => {
    const chain = [];
    let current = el;
    while (current && current !== document.body) {
      const value = info.get(current);
      chain.unshift({
        tag: current.tagName.toLowerCase(),
        class: typeof current.className === 'string' ? current.className.trim().slice(0, 80) : '',
        surface: Boolean(value && (value.border || value.shadow) && value.role === 'container'),
      });
      current = current.parentElement;
    }
    return chain;
  };

  const worst = [...surfaces]
    .map(([el]) => ({ el, depth: depthOf(el, surfaceSet) }))
    .sort((a, b) => b.depth - a.depth)
    .slice(0, 6)
    .map(({ el, depth }) => ({ depth, chain: chainOf(el) }));

  const count = (entries) => entries.length;
  return {
    containers: count(surfaces),
    controls: count(controls),
    grids: count(grids),
    filled: count(filled),
    filledNested: filled.filter(([el]) => depthOf(el, filledSet) >= 2).length,
    nested: surfaces.filter(([el]) => depthOf(el, surfaceSet) >= 2).length,
    deep: surfaces.filter(([el]) => depthOf(el, surfaceSet) >= 3).length,
    maxDepth: Math.max(0, ...Object.keys(dist).map(Number)),
    avgDepth: surfaces.length ? Number((sum / surfaces.length).toFixed(2)) : 0,
    dist,
    filledDist,
    adjacentDoubleBorder,
    worst,
    bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
  };
};

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
const results = [];

for (const route of target.routes) {
  const context = await browser.newContext({ viewport: target.viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const entry = { path: route.path, group: route.group, dynamic: route.dynamic, developmentOnly: route.developmentOnly, probe: route.probe };
  try {
    await page.goto(target.base + route.path, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(1200);
    // 关闭新手引导等浮层，避免把引导层计入页面统计
    await page.evaluate(() => {
      const labels = new Set(['跳过', '跳过引导', '知道了', '关闭', '稍后再说']);
      [...document.querySelectorAll('button, a')]
        .filter((el) => labels.has((el.textContent || '').trim()))
        .forEach((el) => el.click());
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(600);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    Object.assign(entry, await page.evaluate(MEASURE));
    entry.finalUrl = page.url();
    if (shot) {
      const name = route.path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
      entry.screenshot = `screenshots/${app}-${name}.png`;
      await page.screenshot({ path: join(outDir, entry.screenshot), fullPage: false });
    }
    console.log(`${app} ${route.path} containers=${entry.containers} nested=${entry.nested} max=${entry.maxDepth} controls=${entry.controls} grids=${entry.grids}`);
  } catch (error) {
    entry.error = String(error).slice(0, 240);
    console.log(`${app} ${route.path} ERROR ${entry.error}`);
  } finally {
    results.push(entry);
    await context.close();
  }
}

await browser.close();
const payload = {
  meta: {
    app,
    commit,
    base: target.base,
    viewport: target.viewport,
    measuredAt: new Date().toISOString(),
    routeCount: target.routes.length,
    definitions: {
      container: 'div/section/article/main/aside/header/footer/nav/form/ul/ol/dl 中带可见边框或阴影的元素',
      control: 'button/input/select/textarea/a/summary 中带可见边框或阴影的元素',
      grid: 'table/thead/tbody/tr/td/th 中带可见边框或阴影的元素',
      filled: '有非透明背景色且圆角 >= 8px 的任意元素',
      depth: '从自身向上数，最近的有边框容器祖先逐级累加，自身为 1',
    },
  },
  results,
};
writeFileSync(join(outDir, `dom-${app}.json`), JSON.stringify(payload, null, 1));
console.log(`已写入 ${join(outDir, `dom-${app}.json`)}（${results.length} 条路由，commit ${commit}）`);
