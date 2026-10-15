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

MySQL/Redis 卷由 Compose 标为 `external`，普通 `down` 和 `down -v` 均不会删除它们；`docker volume prune --all`、显式 volume rm 和主机磁盘故障仍需通过运维限制与异机备份防护。

本机端口固定在 `10300–10400` 区间：服务端 `10300`、MySQL `10306`、Redis `10371`、Vue 大厅 `10373`、独立 Admin 后台 `10374`。浏览器打开 `http://localhost:10373` 进入玩家大厅，打开 `http://localhost:10374` 预览 Admin 页面壳；服务端探活为 `http://localhost:10300/api/v1/health/live`。Admin 当前只提供响应式导航/总览页面，不显示伪造运营数据，其领域 API 尚未接入。容器间仍使用 MySQL `3306`、Redis `6379`、服务端 `3000` 和 Vite `5173/5174`。类型检查、测试和前端构建均在 Docker dev 容器执行。前端单元/DOM 测试使用 Vitest + Happy DOM，不启动真实浏览器；测试默认单 worker，避免并行测试增加内存占用：

```sh
docker compose --profile dev run --rm dev pnpm typecheck
docker compose --profile dev run --rm dev pnpm test
docker compose --profile dev run --rm dev pnpm --filter @gameing/web test
docker compose --profile dev run --rm dev pnpm --filter @gameing/web build
docker compose --profile dev run --rm dev pnpm --filter @gameing/admin build
```

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
