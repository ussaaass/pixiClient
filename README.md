# Gameing Hall Pixi

手机/PC 浏览器与 iOS、Android、Windows、macOS、Linux App 的游戏大厅项目。首个游戏为十三张；非游戏页面使用 Vue/H5，游戏使用 PixiJS。HTTP + Socket.IO，后端计划采用 Node LTS/Koa、MySQL、Redis。

项目正进入基础施工阶段：已建立 Docker Compose 数据服务、pnpm workspace、Vue H5 大厅壳和 Koa 探活 API。Docker Compose project name 固定为 `gameing-hall-pixi`；当前 MySQL/Redis 开发卷是具名卷，生产外部卷、备份/恢复演练尚未实施。

快速启动（需 Docker）：复制 `.env.example` 为 `.env` 并替换本地开发密码，创建外部具名数据卷，然后执行：

```sh
docker volume create gameing-hall-pixi_mysql_data
docker volume create gameing-hall-pixi_redis_data
docker compose --profile dev run --rm dev pnpm install
docker compose --profile full up --build -d --wait
```

> **关于 `prepare-volumes`**：Docker 创建具名卷时属主是 `root`，而 `dev`/`server`/`web`/`admin` 都以 `user: node` 运行。只要 lockfile 变化需要真正更新 `node_modules`，非 root 就会因权限不足而失败（`ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`）。Compose 已内置一次性服务 `prepare-volumes`（`user: root`）把各 `node_modules` 卷与 pnpm store 交给 `node` 后退出，四个工作服务都以 `condition: service_completed_successfully` 依赖它，因此上述安装命令无需手工干预。

MySQL/Redis 卷由 Compose 标为 `external`，普通 `down` 和 `down -v` 均不会删除它们；`docker volume prune --all`、显式 volume rm 和主机磁盘故障仍需通过运维限制与异机备份防护。

本机端口固定在 `10300–10400` 区间：服务端 `10300`、MySQL `10306`、Redis `10371`、Vue 大厅 `10373`、独立 Admin 后台 `10374`。浏览器打开 `http://localhost:10373` 进入玩家大厅，打开 `http://localhost:10374` 预览 Admin 页面壳；服务端探活为 `http://localhost:10300/api/v1/health/live`，就绪探针为 `http://localhost:10300/api/v1/health/ready`。Admin 当前只提供响应式导航/总览页面，不显示伪造运营数据，其领域 API 尚未接入。容器间仍使用 MySQL `3306`、Redis `6379`、服务端 `3000` 和 Vite `5173/5174`。类型检查、测试和前端构建均在 Docker dev 容器执行。前端单元/DOM 测试使用 Vitest + Happy DOM，不启动真实浏览器；`apps/web`、`apps/admin` 固定 4 个 worker 并行（26~28 个测试文件串行时每个都要各建一次 happy-dom，并行后墙钟时间约降到 1/4；上限压在 4 而非 CPU 数，用于控制 happy-dom 实例的常驻内存）。内存吃紧的机器可临时降回单 worker：

```sh
docker compose --profile dev run --rm dev pnpm typecheck
docker compose --profile dev run --rm dev pnpm test
docker compose --profile dev run --rm dev pnpm --filter @gameing/web test
docker compose --profile dev run --rm dev pnpm --filter @gameing/web build
docker compose --profile dev run --rm dev pnpm --filter @gameing/admin build
```

内存吃紧时可临时降回单 worker（命令行参数覆盖脚本里的 4，只影响本次执行）：

```sh
docker compose --profile dev run --rm dev pnpm --filter @gameing/admin test --maxWorkers=1 --no-file-parallelism
```

表结构只通过迁移变更，不在启动路径 `sync()`。迁移命令（`up` 为默认，另有 `down` / `status`）：

```sh
docker compose --profile dev run --rm dev pnpm --filter @gameing/server migrate
```

迁移依赖真实 MySQL；集成测试默认跳过，显式开启才会在目标库建表并回滚：

```sh
docker compose --profile dev run --rm -e MIGRATION_TEST=1 dev pnpm --filter @gameing/server test
```

## 质量门禁

仓库已接入 CI（`.github/workflows/ci.yml`），本地可复现同样的六道关卡：

```sh
pnpm lint          # ESLint（packages / games / apps/server，零容忍）
pnpm lint:apps     # ESLint（apps/web / apps/admin）
pnpm format:check  # Prettier（packages / games）
pnpm typecheck     # 全仓 tsc / vue-tsc
pnpm test          # 单元 + 契约测试
pnpm build         # 前端产物 + 服务端产物
```

提交时由 husky `pre-commit` 钩子自动对暂存文件跑 `eslint --fix` 与 `prettier --write`。

### 全量门禁只在容器内跑

**构建与部署一律在 Docker 内，不在宿主机直跑。** 宿主机直跑 `apps/web` 的 `vite build` 会因本机工具链的 IPC 管道问题报 `write EPIPE`，且 Vite 清空 `dist` 时会触发批量删除保护。用下面这组脚本，等价于 CI：

```sh
pnpm docker:install    # pnpm install --frozen-lockfile（顺带校验 lockfile 与 package.json 一致）
pnpm docker:typecheck  # 容器内全仓类型检查
pnpm docker:test       # 容器内全仓测试
pnpm docker:build      # 容器内全仓构建（server / shisanshui-client / admin / web）
pnpm docker:check      # 容器内连跑六道关卡，等价于 CI 的 verify job
```

### 本地只跑变动部分

全量 `test` 需要把 8 个包的测试都跑一遍，其中 `apps/admin`（26 个文件）和 `apps/web`（28 个文件）最重。日常改动用增量门禁：

```sh
pnpm check:changed     # lint + format + 仅变动包的类型检查与测试
pnpm typecheck:changed # 只对变动包做类型检查
pnpm test:changed      # 只对变动包跑测试
```

默认基线是 `origin/main`（即"我还没推上去的改动"）。要换基线用 `SINCE`：

```sh
SINCE=HEAD~1 pnpm test:changed      # 只跑最后一次提交影响到的包
SINCE=origin/main pnpm check:changed
```

包级筛选之外，还能再缩到文件级——`vitest related` 会沿 import 图找出真正受影响的测试文件：

```sh
pnpm --filter @gameing/web test:related src/platform/social/social-application.ts
# 实测：28 个测试文件里只挑出 5 个相关文件
```

**增量门禁只用于本地迭代，合并前必须跑一次 `pnpm docker:check`。**

排版由 Prettier 统一，ESLint 只负责正确性：Vue 侧仅启用 `flat/essential` 规则集，不启用含纯排版规则的 `recommended`/`strongly-recommended`，避免与 Prettier 职责重叠并产生无信息量的告警。

## 生产镜像

开发态用 `Dockerfile.dev`（挂载源码 + watch），生产态用根目录 `Dockerfile`（多阶段构建，运行层只含打包后的自包含 ESM 产物，非 root 运行，自带 HEALTHCHECK）：

```sh
docker compose --profile prod up -d --wait   # 生产 API（就绪探针打 /health/ready）
```

服务端生产产物由 esbuild 打成单个 ESM 文件（`apps/server/scripts/build.mjs`）。之所以不用 `tsc` 直接产出可运行文件：`@gameing/contracts` 等工作区包以 TypeScript 源码形式导出（`exports` 指向 `src/*.ts`），`tsc` 产物在运行时无法解析这些 `.ts`。

当前已提供 H5 大厅 → 十三张子厅 → 本地练习档位 → PixiJS 本地牌桌的可玩原型；本地演示不登录、不扣资产、不连接真实牌局。联机、房间、账号和真实结算仍未完成。

基础镜像当前锁定 Node 24.21.0、MySQL 9.7.2、Redis 8.10.2；pnpm 12.10.1 和 JS 依赖精确版本记录在 workspace 配置与 `pnpm-lock.yaml`。版本定期按支持周期和兼容测试更新。

ORM 指定 Sequelize。[数据库规范](./docs/05_data/数据库设计规范与Sequelize方案.md)统一 unsigned bigint ID、非零状态、三个 DATETIME、snake_case 引用与注释；[系统账户](./docs/04_domains/系统账户与资产记账设计.md)作为资产来源和归宿。

- [文档入口](./docs/README.md)
- [架构评估](./docs/02_architecture/架构评估与落地方案.md)
- [monorepo 结构规划](./docs/02_architecture/项目结构规划.md)
- [网络预加载设计](./docs/02_architecture/网络预加载设计.md)

全部视觉美术由 AI 创作，资源按版本/格式分级加载；大厅通过 Workbox + vite-plugin-pwa 与自有网络调度提前缓存游戏资源。具体运行命令与五端工程在实施阶段初始化。

素材创作接入 OpenAI API，主模型采用 GPT-6 系列，图像工具模型单独配置，见 [AI 素材接口生产方案](./docs/07_assets/AI素材接口生产方案.md)。如需 Python，一律使用项目专用 venv，见 [项目约束](./AGENTS.md)。

先交付浏览器版，再封装 App。业务采用 game_config/system_config；账号、金币手续费与邀请返佣的最新定义见 [业务配置与账号代理细化](./docs/04_domains/业务配置与账号代理细化.md)。

登录采用 [JWT](./docs/04_domains/JWT登录与会话设计.md)。[累计客损](./docs/04_domains/累计客损结算口径.md) 剔除赠币补贴并按高位防重复；赠币和普通金币统一使用，赠送增加有效下注流水要求。人民币余额、TRON USDT 充值、默认 1:10、提现整数倍与三选一身份、直连邀请归因见 [最新支付与流水方案](./docs/04_domains/支付渠道流水要求与直连归因.md)。


## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-10-10 | 加入十三张纯规则 workspace：牌型评估、倒道校验、确定性 72,072 候选自动摆牌、配置化结算及低内存测试。 |
| 2026-10-10 | 将 OpenAI 生成的大厅背景接入 H5，并输出约 111 KiB 的 WebP 优化资源。 |
| 2026-10-10 | 为 Vue Web 包加入 Vitest + Happy DOM 测试基础、单 worker 测试脚本与健康检查 API 测试。 |
| 2026-10-10 | 根据主机端口冲突，将本机端口区间改为 `10300–10400`：server `10300`、MySQL `10306`、Redis `10371`、Vue `10373`。 |
| 2026-10-10 | 按项目约束新增变更历史区块；未改动原有正文。 |
| 2026-10-10 | 更新文档归档路径引用。 |
| 2026-10-10 | 增加基础工程 Docker 启动方式、服务探活入口及已锁定的初始运行时版本。 |
| 2026-10-10 | 将 Docker 类型检查、测试和前端构建命令补齐为可直接复制的完整命令。 |
| 2026-10-10 | 增加十三张 H5 子厅与档位流程，并按需动态加载 Pixi 本地练习牌桌。 |
| 2026-10-10 | 为十三张子厅接入专属 AI WebP 背景和进厅转场；难度厅改为横向直达牌桌。 |
| 2026-10-10 | 将大厅/子厅背景改为独立视口图层，保持图像比例并在视口内裁切，避免页面转场容器影响背景尺寸。 |
| 2026-10-12 | 新增独立 Admin 应用壳并开放本机 `10374` 预览端口；明确当前总览无真实运营数据。 |
| 2026-10-21 | 补齐工程基线：CI（lint/format/typecheck/test/build 五关）、ESLint + Prettier + EditorConfig + husky/lint-staged；契约包补独立 tsconfig/typecheck/test 与回归测试；工具并入 pnpm workspace；新增统一 envelope、错误码注册表、requestId 贯通、结构化日志、`/health/ready` 与生产镜像 + `prod` profile；修复 Compose 具名卷属主导致的 `pnpm install` 权限失败。 |
| 2026-10-22 | 增加数据库迁移命令与迁移集成测试的开启方式（`pnpm --filter @gameing/server migrate`、`MIGRATION_TEST=1`）。 |
| 2026-10-23 | 质量门禁改为六关并补齐增量路径：新增 `docker:install/typecheck/test/build/check` 把全量门禁收敛到容器内（宿主机直跑 web 构建会报 `write EPIPE`），新增 `check:changed`/`typecheck:changed`/`test:changed` 与 `test:related` 供本地只跑变动部分。 |
| 2026-10-23 | `apps/web`、`apps/admin` 的 Vitest 由单 worker 改为 4 worker 并行（串行时 26~28 个测试文件各建一次 happy-dom，是主要耗时），并注明内存吃紧时的降级命令。 |
