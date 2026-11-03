# 系统架构

本文为结构层面的速查与导航；权威决策与完整论证见 `docs/02_architecture/` 各 SDD（本文不复制其内容，只登记现状与指针）。

## 1. 系统总览

```text
浏览器 H5 (apps/web, Vue+Vite)          独立后台 (apps/admin, Vue+Element Plus)
   │  fetch /api/v1（Vite 代理 → server:3000）      │  /admin-api/v1（规划，未实现）
   ▼                                                 ▼
Koa API (apps/server)  ── 统一 envelope / requestId / 结构化日志 / 错误边界
   │  └ MySQL 9.7.2 (Sequelize+Umzug, external 卷)   └ Redis 8.10.2（会话/归因规划）
   ▼
领域：identity / wallet / referral / social / support / rooms / coin-market / platform-events
```

- 五端目标：H5/PWA 先行，App（Capacitor）与桌面（Electron）后置封装；不复制第二套玩法/钱包实现。
- 玩家浏览器端同时存在三种运行模式（`docs/02_architecture/代码分层与接口实现规范.md` §18）：
  - `LOCAL_DEMO`：内存仓储适配器，导览/练习用，不签发身份。
  - `LOCAL_BROWSER_SERVER`：`apps/web/src/platform/browser-api/dispatcher.ts` + IndexedDB，复用与 Koa 相同的 endpoint registry/DTO/envelope，仅 dev 构建装配。
  - `REMOTE`：真实 HTTP/Socket.IO（Socket.IO 尚未实现）。
- 服务端 P0 现状：6 个只读/探活路由（health、公告空列表 stub、游戏目录快照），无 DB 接入的写业务、无 Redis、无 Socket。

## 2. 模块依赖与边界（铁律）

来源：`docs/02_architecture/项目结构规划.md` §4、`docs/02_architecture/代码分层与接口实现规范.md` §2。

| 使用方 | 允许依赖 | 禁止 |
| --- | --- | --- |
| `apps/web` | contracts、domain、shisanshui-client、Pixi、idb | backend 源码、Sequelize、Koa、Node fs |
| `apps/admin` | admin-contracts、contracts、rules | backend 源码、web store、游戏 renderer |
| `apps/server` | contracts、domain（经后端模块）、MySQL/Redis 适配器 | web/UI、浏览器 DOM |
| `packages/domain` | 仅 contracts | DOM/Node 全局、Sequelize、Redis、时钟/随机 |
| `packages/contracts` | 仅 TypeBox | Node built-ins、Koa、Sequelize、密钥配置 |
| `games/*/client` | 该游戏 rules/contracts、Pixi、game SDK（规划） | backend、原始 Socket、钱包仓储 |
| `games/*/rules` | 纯 TS | 随机/时钟/IO/UI |

后端内部约定（尚未落地为目录，落地时遵守）：`modules/<domain>/{domain,application,ports,adapters,public.ts}`；跨域编排放 workflows，只依赖参与域 `public.ts`；事务经共享 opaque `TransactionScope`，由 infrastructure 创建。当前 `apps/server` 只有 `main.ts`/`app.ts`/`infrastructure/`，domain 模块目录等待 P1 建立。

## 3. 应用生命周期

- 服务端：`apps/server/src/main.ts`（配置、装配、SIGTERM/SIGINT 优雅关闭、未捕获异常退出）→ `createApp`（中间件顺序固定：requestId → 访问日志 → 错误边界 → router → 404 兜底转失败 envelope）。生产产物为 esbuild 单文件 ESM（`apps/server/scripts/build.mjs`），因 contracts 以 TS 源码导出，不能用 tsc 直出。
- 浏览器端：`apps/web/src/main.ts` 按 DEV/PROD 分支装配；启动屏 `__LG_BOOT__`（mounted/painted/ready）在 `index.html`。注意：生产构建当前仅注入 `gameExperienceApi`，钱包/社交/客服/邀请在 REMOTE 下缺失（差距项，见 PROJECT_STATUS）。
- 容器：`prepare-volumes`（root 一次性修卷属主）→ dev/full 各服务；`prod` profile 起 `api-prod`。

## 4. 数据流（资金主链）

充值（实付净额）→ 系统 CNY 账户加、系统金币账户减 → 玩家 COIN 账户（asset_operation + asset_entry 同事务）→ 牌局下注冻结/结算（round_player 有效下注累计流水）→ 金币兑换 CNY（coin_exchange，1:10 默认）→ 提现审核通过后出款。不可变分录、幂等键、锁顺序是资产品类测试的一等公民。金额在库内为有符号精确整数，跨 HTTP 用十进制字符串。

## 5. 基础设施

- Compose `gameing-hall-pixi`：MySQL/Redis external 具名卷（`gameing-hall-pixi_mysql_data` / `..._redis_data`），`down -v` 不删除；生产须外部备份。
- 端口：本机 10300/10306/10371/10373/10374；容器内 MySQL 3306、Redis 6379、server 3000、Vite 5173/5174。
- 知识图谱：Graphify（`~/.local/bin/graphify`），`graphify-out/` 不提交，用法见 `docs/08_reference/WorkBuddy工具链与知识图谱接入.md`。
- 素材生成：`tools/asset-generation`（OpenAI/Kling），密钥走 `tools/asset-generation/.env`（gitignore）。

## 6. 关键架构决策（已定，勿在代码中擅改）

| 决策 | 选择 | 出处 |
| --- | --- | --- |
| ORM | Sequelize v6 + Umzug 自定义 migration_history（不用 sync、不用 Kysely） | `docs/05_data/数据库设计规范与Sequelize方案.md` |
| 迁移执行 | 独立部署任务，启动路径不 sync | 同上 §5、`docs/02_architecture/项目结构规划.md` §6 |
| 身份 | 服务端 JWT（访问/设备/刷新/二维码凭证分离 + 服务端撤销） | `docs/04_domains/JWT登录与会话设计.md` |
| 领域规则归属 | 前后端共用 `packages/domain`，浏览器只留适配器 | `docs/02_architecture/从原型到产品级的实施路线.md` 决策 A |
| 实时通信 | Socket.IO + 房间 worker 持锁（规划 C，未实施） | 同上 |
| 游戏注册 | 构建期白名单 + 动态 import 独立 chunk，禁止 barrel 聚合 | `docs/02_architecture/游戏引擎与游戏模块边界.md` |
| 客损 | 代理线下结算，平台不建计算模块 | `docs/04_domains/累计客损结算口径.md` |

矛盾登记：README/规划提到 “Workbox + vite-plugin-pwa 提前缓存游戏资源”，但 `apps/web` 当前无 PWA 配置（无 SW、无 manifest）——按规划属实施阶段能力，落地前不得当作已有能力引用。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-02 | 新建：登记系统总览、模块边界铁律、生命周期、资金数据流、基础设施与关键架构决策；登记 PWA 未落地矛盾。 |
