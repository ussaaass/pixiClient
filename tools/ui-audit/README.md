# UI 表面层审计工具（ui-audit）

用于量化「边框套娃」：统计页面里带边框/阴影的容器嵌套了几层、同屏有多少个边框元素，以及样式层有多少互不一致的边框颜色与圆角。

产出为**原始 JSON**，报告中的运行时数字与样式数字都应能由本工具复现。

## 依赖

- Node `>=24.0.0 <25`
- `playwright-core`（本目录 `package.json` 已锁定版本；`npm install` 后使用）
- 本机 Playwright 缓存的 headless chromium（默认探测 `~/Library/Caches/ms-playwright/chromium_headless_shell-1243`，可用 `--chrome` 指定）

本目录与 `tools/asset-generation` 一样**不属于 pnpm workspace**，使用独立 `package.json`，避免把浏览器依赖带进业务包。

## 用法

先启动要审计的前端（开发模式，保证 `import.meta.env.DEV` 分支与本地 IndexedDB 装配生效）：

```sh
# 主工作区
cd apps/admin && ./node_modules/.bin/vite --host 127.0.0.1 --port 10384
cd apps/web   && ./node_modules/.bin/vite --host 127.0.0.1 --port 10383
```

再执行：

```sh
cd tools/ui-audit && npm install

node css-stats.mjs --root ../../apps/web/src   --out results/<label>/css-web.json
node css-stats.mjs --root ../../apps/admin/src --out results/<label>/css-admin.json

node audit.mjs --app admin --out results/<label>
node audit.mjs --app web   --out results/<label>

# 核对报告里引用的全部数字
node verify.mjs results/<label>
```

`<label>` 建议用 `<commit短哈希>-<日期>`，例如 `a62c22d-2026-10-24`，便于把结论钉到具体版本。

可选参数：`--shot` 为每条路由保存首屏截图（默认关闭，避免仓库膨胀）；`--chrome <path>` 指定浏览器可执行文件。

## 统计口径

| 名词 | 定义 |
| --- | --- |
| 容器（container） | `div/section/article/main/aside/header/footer/nav/form/ul/ol/dl` 中**有可见边框或阴影**的元素 |
| 控件（control） | `button/input/select/textarea/a/summary`（或 `role=button`）中有可见边框或阴影的元素 |
| 表格线（grid） | `table/thead/tbody/tr/td/th` 中有可见边框的元素 |
| 填充块（filled） | 有非透明背景色且圆角 ≥ 8px 的任意元素 |
| 深度（depth） | 从自身向上数「有边框容器祖先」的数量，自身计 1；只统计容器，不把按钮/单元格算进层级 |
| 嵌套（nested） | 深度 ≥ 2 的容器数 |
| 相邻双线 | 自身有边框，且最近的带边框祖先与自身左上间距 < 2px |
| 可见 | 非 `display:none`、非 `visibility:hidden`、`opacity≠0`、宽 ≥ 40px 且高 ≥ 24px |

`routes.json` 中的两个标记会改变汇总口径：

- `dynamic`：该路由含被替换成具体值的动态段（如 `/admin/users/1`）。**仍计入汇总**，因为它渲染的是真实页面。
- `probe`：该路由需要真实实体 ID，但 dev 数据里不存在，会落入空态或回退（如 `/messages/1` 回退到大厅）。**不计入汇总**，只在 `summary.mjs` 里单独列出，避免污染基线。

样式层口径见 `css-stats.mjs` 文件头注释，要点：

- `cardRules` = 同时设置**非 none 边框**与**非透明背景**的规则数；
- `cardClasses` = 这些规则选择器中**出现过的不同类名数**，只表示「命名分散程度」，**不能证明类名未被复用**；
- `borderColors` = 边框声明里的颜色字面量去重数（含 `#hex`、`rgb()/rgba()`、`hsl()`、`var(--x)`）；
- `radiusValues` = `border-radius` 取值按文本去重数（`10px` 与 `10px 10px 10px 10px` 视为两个值）。

## 覆盖范围与限制

- **路由覆盖**：`routes.json` 中的 admin 清单来自 `apps/admin/src/router.ts` 的全部 `path` 条目（动态段替换为具体值）；web 清单来自 `apps/web/src/App.vue` 的 pathname 解析规则。新增路由需同步维护该文件。
- **重定向识别**：`summary.mjs` 比较完整 pathname，不用 `endsWith`——否则 `/support → /messages/support` 这类后缀相同的跳转会被误判为未跳转，把同一页面统计两次。
- 只统计**可见元素**；圆形头像等装饰性边框会计入控件/容器。
- 统计对象是**开发模式**页面，包含开发态浮层；脚本会先点击「跳过/知道了/关闭」再统计，但自定义浮层可能漏关。
- 未覆盖真实设备、Safari/WebKit 与生产构建产物。
- 同一页面在不同数据量下（表格行数、消息条数）结果会变化，比较时需固定数据种子或说明数据状态。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-10-24 | 建立工具：DOM 表面层审计 + 样式层统计，固化路由清单与口径定义，替代此前未留存的临时脚本。 |
| 2026-10-24 | 修正重定向识别（`endsWith` → 完整 pathname 比较）；新增 `probe` 标记，把落入空态/回退的动态实体路由排除出汇总。 |
