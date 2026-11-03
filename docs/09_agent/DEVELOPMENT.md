# 开发环境速查

详细背景见 `README.md`（快速启动）与 `docs/02_architecture/项目结构规划.md` §7（Docker 规划）。本文只登记可执行事实。

## 1. 前置

- 宿主机只需 Docker（+ Node 仅用于 `graphify` 等工具）；**构建/测试/类型检查一律在 Docker dev 容器执行**，不要在宿主机直跑 `vite build`（IPC 管道 `write EPIPE`）。
- 首次初始化（外部具名卷 + frozen install）：

```sh
cp .env.example .env   # 替换开发密码
docker volume create gameing-hall-pixi_mysql_data
docker volume create gameing-hall-pixi_redis_data
docker compose --profile dev run --rm dev pnpm install
docker compose --profile full up --build -d --wait
```

`.env` 与 `tools/asset-generation/.env` 不提交；`.env.example` 只列配置名与本地示例。

## 2. 常用命令（宿主机直接执行，内部走 compose dev 容器）

```sh
pnpm docker:install     # pnpm install --frozen-lockfile
pnpm docker:check       # 六道关卡全量（= CI verify job）
pnpm docker:typecheck / docker:test / docker:build
pnpm check:changed      # 本地增量：lint+format+仅变动包 typecheck/test（SINCE 默认 origin/main）
pnpm typecheck:changed / pnpm test:changed
pnpm --filter @gameing/web test:related <file>   # 文件级增量（vitest related）
```

包级筛选示例：`pnpm --filter @gameing/web test`、`pnpm --filter @gameing/admin build`。

## 3. 本地服务与端口

| 服务 | 本机端口 | 说明 |
| --- | --- | --- |
| API | 10300 | `/api/v1/health/live`、`/health/ready` |
| MySQL | 10306 | 容器内 3306 |
| Redis | 10371 | 容器内 6379 |
| 大厅 web | 10373 | Vite 容器内 5173，`/api` 代理到 server:3000 |
| Admin | 10374 | Vite 容器内 5174 |

迁移与集成测试：

```sh
pnpm --filter @gameing/server migrate status        # 需 compose MySQL 已启动
docker compose --profile dev run --rm -e MIGRATION_TEST=1 dev pnpm --filter @gameing/server test
```

## 4. 生产

- `docker compose --profile prod up -d --wait` 起 `api-prod`（多阶段 `Dockerfile`，非 root，HEALTHCHECK 打 `/health/ready`）。
- 生产构建产物是 esbuild 单文件 ESM（`node dist/server.js`），不携带 TS 源码。

## 5. 常见坑

- `node_modules` 属主：lockfile 变化后若直接 `pnpm install` 报 `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`，说明需经 `prepare-volumes`（compose 已内置依赖关系）。
- 宿主机跑 `pnpm build` 时 Vite 清空 `apps/web/dist` 会触发批量删除保护（>50 文件）——用容器命令或先移走旧 dist。
- 宿主机负载高时 4-worker 测试起不来：`--maxWorkers=1 --no-file-parallelism` 临时降级。
- husky `pre-commit` 会对暂存文件跑 `eslint --fix` + `prettier --write`；`post-checkout`/`post-commit` 钩子也会触发，clone 后首次操作可能较慢。
- `pnpm test` 顶层串行（`--workspace-concurrency=1`），但包内 vitest 是 4 worker（web/admin）。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-02 | 新建：登记容器化开发命令、端口表、迁移/生产命令与常见环境坑，口径与 README/CI 对齐。 |
