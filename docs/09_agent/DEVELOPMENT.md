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

## 3. Docker 资源管理与清理纪律

- 当前唯一 Compose project 名为 `gameing-hall-pixi`（`compose.yaml` 固定），所有开发、build、测试及集成测试都使用现有 Compose 文件和该命名空间；启动任何任务前先用 `docker compose ps -a`、`docker image ls`、`docker volume ls`、`docker system df` 检查项目资源，优先复用可用服务/镜像，不为小测试另建 stack 或 project。
- Compose 创建的容器、网络及卷沿用标准 `com.docker.compose.project` 等标签；手工资源必须采用含项目名和用途的名称并带 Docker ownership labels，禁止模糊通用名。临时容器优先 `docker compose run --rm`。build 使用已有缓存和稳定 tag，不按每次测试生成新镜像。
- 任务结束确认 `--rm` 临时容器已退出/移除；检查项目作用域内遗留容器、网络、镜像及临时产物，确认未被运行服务引用后再做最小必要清理。可以用 Compose 项目作用域操作；每次删除前核对资源名称、Compose project 标签、运行引用和是否需保留调试/回滚。
- `gameing-hall-pixi_mysql_data`、`gameing-hall-pixi_redis_data` 是 external 持久/共享数据卷，绝不自动删除。卷即使未挂载也不能推断可丢弃；任何持久或归属不明资源的破坏性清理必须先取得用户明确授权。禁止把 `docker compose down -v` 当常规清理，禁止自动执行 `docker system prune`、`docker image prune -a`、`docker volume prune -a` 等全局操作；不得触碰其他项目资源或共享基础镜像。
- Docker 密集型工作后按实际需要复核 `docker system df` 与 `docker compose ps -a`：说明资源被创建/保留/删除及有意保留项；确认临时容器清除、必要开发服务仍可用、持久卷与其他项目未受影响。不得声称未实际验证的清理已完成。

## 4. 镜像复用与容器拓扑效率

- 创建、拉取、构建或启动资源前先检查 `docker image ls`、`docker ps -a`、`docker compose config`、`docker system df` 以及项目卷/网络；需要时查看 digest、镜像实际使用者和其他项目采用的兼容 runtime 版本。严禁未检查本地兼容镜像就自动 pull，避免每项任务默认选最新版。
- 版本决策优先复用本项目既有且已验证的 runtime/service 镜像；没有时再选已存在且兼容的本地镜像。仅以明确技术需求、安全要求、锁定栈版本或复现性为理由引入新版本；使用明确版本/必要时 digest，不用浮动 `latest`，不为省空间降级到不安全版本。
- 同代码库、同 runtime 的自有应用进程优先共享一个稳定项目镜像；不同启动命令不构成拆分镜像的理由。多个容器共用同一镜像层本身不重复存储镜像，但会增加容器资源，应一并权衡。构建优先复用 layer cache、稳定 tag 和合适的多阶段构建，仅构建受影响服务，禁止无理由 `--no-cache`/强制 pull/按每次测试生成唯一 tag；检查 `.dockerignore` 避免发送无关大文件。
- 当前 `full` 开发 profile 的 `server`、`web`、`admin` 同用 `Dockerfile.dev`。检查本机 `gameing-hall-pixi-dev/web/admin:latest` 三个镜像均报告 325,773,852 bytes，web 与 admin 的 layer IDs 完全相同，dev/admin 只有末层不同；构建别名带来多标签/末层差异，但 Docker 共享基础层，不能误称镜像完整重复占用三倍空间。不要仅为删除标签而改构建拓扑；每次审阅仍须根据当时镜像实测。
- 当前 `full` 开发 profile 的 `server`、`web`、`admin` 同用 `Dockerfile.dev`。检查本机 `gameing-hall-pixi-dev/web/admin:latest` 三个镜像均报告 325,773,852 bytes，web 与 admin 的 layer IDs 完全相同，dev/admin 只有末层不同；构建别名带来多标签/末层差异，但 Docker 共享基础层，不能误称镜像完整重复占用三倍空间。不要仅为删除标签而改构建拓扑；每次审阅仍须根据当时镜像实测。
- 开发时，同项目兼容进程在确实无需独立重启、扩缩、资源限制、环境/安全隔离且可可靠管理的情况下，优先共用单一开发容器；否则使用多个角色容器但复用同一应用镜像。不得仅因端口或进程名称不同而造容器。API/WebSocket 可在同容器映射多个必要端口；worker 默认不发布端口。合并进程必须有可观察日志、关键进程退出检测、信号转发、graceful shutdown 和子进程回收；`init: true` 不是进程监督器，健康检查须反映全部关键服务就绪。只有经过证明的独立扩缩/重启、故障或安全隔离、runtime、资源/环境或发布生命周期需求才拆分容器。
- MySQL、Redis 等第三方依赖继续独立容器、独立生命周期及持久卷；不得为减少容器数合并数据库进应用容器。开发与生产拓扑允许不同，生产按安全、可靠性、扩缩、隔离和恢复需求决定；不要为此无理由复制 Dockerfile。

## 5. 本地服务与端口

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

## 6. 生产

- `docker compose --profile prod up -d --wait` 起 `api-prod`（多阶段 `Dockerfile`，非 root，HEALTHCHECK 打 `/health/ready`）。
- 生产构建产物是 esbuild 单文件 ESM（`node dist/server.js`），不携带 TS 源码。

## 7. 常见坑

- `node_modules` 属主：lockfile 变化后若直接 `pnpm install` 报 `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`，说明需经 `prepare-volumes`（compose 已内置依赖关系）。
- 宿主机跑 `pnpm build` 时 Vite 清空 `apps/web/dist` 会触发批量删除保护（>50 文件）——用容器命令或先移走旧 dist。
- 宿主机负载高时 4-worker 测试起不来：`--maxWorkers=1 --no-file-parallelism` 临时降级。
- husky `pre-commit` 会对暂存文件跑 `eslint --fix` + `prettier --write`；`post-checkout`/`post-commit` 钩子也会触发，clone 后首次操作可能较慢。
- `pnpm test` 顶层串行（`--workspace-concurrency=1`），但包内 vitest 是 4 worker（web/admin）。
- 根 `pnpm typecheck` / `pnpm build` 已加 `--workspace-concurrency=1` 顺序跑（2026-11-03）；容器内存上限下并行跑会 OOM SIGKILL。CI `ubuntu-latest`（7GB）大概率不触发，但顺序跑更稳。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-02 | 新建：登记容器化开发命令、端口表、迁移/生产命令与常见环境坑，口径与 README/CI 对齐。 |
| 2026-11-03 | §7 常见坑补充：根 `typecheck`/`build` 顺序跑（`--workspace-concurrency=1`），避免容器并行 OOM。 |
| 2026-11-06 | 增补 Docker 资源管理纪律：固定 project 名、先检查后复用、限定清理到已确认项目资源，保护持久数据卷并禁止全局 prune。 |
| 2026-11-06 | 增补镜像复用与容器拓扑效率规范：先查兼容本地镜像，优先共享应用镜像/合理合并开发进程，说明多进程管理与健康检查要求，并保留第三方依赖隔离；记录本机开发镜像实测层复用，避免误估空间后做无效拓扑改造。 |
