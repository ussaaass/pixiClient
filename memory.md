# 项目长期记忆（MEMORY）

> 给未来会话/施工代理的项目事实速记：只记**跨会话不变、错了代价大**的事。动态状态见 `docs/09_agent/PROJECT_STATUS.md`（施工后必更），施工纪律见 `AGENTS.md`。本文不与那两处重复，只补"容易忘"的。

## 关键决策记录（用户拍板，勿擅自推翻）

| 日期 | 决策 |
| --- | --- |
| 2026-11-02 | 双轨（LOCAL 本地腿 / REMOTE 服务端腿）是**设计需要**：前后端不同步开发；后台代码开写前，`browser-api/` 本地腿是唯一可验收执行路径，**不得提前退役**。 |
| 2026-11-03 | 第二批双轨切换（`local-identity-application`、`social-message-asset-application`）**暂缓**，启动条件 = `apps/server` 业务写端点开写；在此之前 LOCAL_DEMO/LOCAL_BROWSER_SERVER 保持现状。 |
| 2026-11-03 | 后端施工蓝图 = `docs/02_architecture/后端实施SDD.md`（实体起步）；Admin 管理端固定 Vue 3.5 + Element Plus；Docker 复用现有 compose，不新造编排。 |
| 2026-10 基线 | PWA/Workbox 是 README 目标能力但**代码未实现**（无 SW/manifest）；落地前按未完成处理，不得当已有能力引用。 |

## 环境铁律（会反复踩）

- **宿主无 pnpm、npm 缓存 root-owned**：所有门禁走 `docker compose --profile dev run --rm dev ...` 或 `pnpm docker:check`；提交用 `git commit --no-verify`（husky 需 pnpm）。
- 容器**并行** `pnpm -r typecheck/build` 会 OOM SIGKILL（exit 137）；根脚本已改 `--workspace-concurrency=1` 顺序跑（commit `e246ecf`）。CI `ubuntu-latest`（7GB）大概率不触发，以 CI 日志为准。
- `pnpm install --frozen-lockfile` 在 `tools/ui-audit/`（未跟踪目录，含 package.json）存在时会报 `importers["tools/ui-audit"]` 缺失——CI 检出无此目录不受影响；本机需 `pnpm install`（非 frozen）或临时挪走该目录。
- `apps/server` 的 esbuild 打包**必须**把 Sequelize 非 MySQL dialect（pg/pg-hstore/oracledb/sqlite3/mariadb/ibm_db）标记 external，否则 bundle 阶段解析 postgres dialect 报错（P0 基线从 lockfile 剔除了那些 peer）。已修在 `apps/server/scripts/build.mjs`。

## 包/依赖现状（易被新会话误判）

- `packages/domain` 已下沉 9 纯规则模块 + 12 个 application 文件（第一批，~1200 行），带 `@sinclair/typebox` 依赖与 12 个 subpath 导出；`apps/web` 全量走 `@gameing/domain/*` import。
- `packages/contracts` 的 OpenAPI 生成器（`openapi.mjs` + `tsx` devDep）已落地，CI 第 7/8 关；`dist/openapi.json` 被 gitignore。
- lockfile 已含 `tsx`、`@sinclair/typebox`、`tools/ui-audit`（playwright-core importer）三个新增 section（commit `b8eb09b`）。
- 后端业务代码（identity/wallet 写端点/支付/Socket.IO/outbox）**尚未开写**；现有 server 只有探活 + 7 个只读路由 + 0001~0006 迁移。施工起点见 `docs/02_architecture/后端实施SDD.md` §9（第一步 = 身份与会话，批次 0007）。

## 表数口径（别被旧数字带偏）

数据库设计 SDD 开头写"全库 62 张表"，但其 §5 逐表定义实为 **63 张**（`outbox` 后补、开头数字未更新）。后端实施 SDD 按 63 张为准并已登记该差异。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-03 | 新建：沉淀双轨决策、环境铁律、包依赖现状、表数口径四类跨会话事实。 |
