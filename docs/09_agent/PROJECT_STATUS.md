# 项目状态（动态，随施工更新）

本文只记录"已验证实现 / 未完成 / 已知问题"，判定依据是代码与实测，不以"有页面/有路由"当完成。阶段性权威判定见 `docs/02_architecture/从原型到产品级的实施路线.md`（P0 收口，2026-10-23 基线 `2253603`）。

## 1. 已实现并验证（可依赖）

- 工程基线：CI 六道门禁（`.github/workflows/ci.yml`，pnpm 12.10.1 + node 24.21.0）、ESLint/Prettier/husky+lint-staged、增量门禁 `check:changed`/`test:changed`/`vitest related`。
- Koa 服务端骨架：统一 envelope、requestId 贯通、结构化日志（敏感字段脱敏）、错误边界、404→失败 envelope；`/health/live`、`/health/ready`（探针依赖当前为空数组）。
- 只读路由：游戏目录快照（LOCAL_DEMO）、公告空列表 stub、preflight（仅 LOCAL_PRACTICE 可返回 READY）。
- 数据库：Sequelize + Umzug 迁移框架 + 63 张表（0001~0018），对 compose `mysql:9.7.2` 真跑通过、`MIGRATION_TEST=1` 全链可升可降（backend 迁移器 18 项注册）。
- `packages/domain` 纯规则下沉：9 个模块（wallet/social/support/rooms/preferences/coin-market…），web 18 处 import；无 DOM/Node 全局依赖。
- **用例层下沉第一批（2026-11-02）**：12 个 application 文件（wallet/support/rooms/social×2/notifications/invite-agent/player-entry/preferences/referral/wallet-funding，~1200 行）已移入 `packages/domain`，`apps/web` 改为 `@gameing/domain/*` import；`packages/domain` 新增 `@sinclair/typebox` 依赖与 12 个 subpath 导出。domain 11/11、web 149/149 测试与三包 typecheck 全绿。剩 `local-identity-application`（495 行，强浏览器依赖）与 `social-message-asset-application`（80 行，本地加密）未下沉，见 `docs/09_agent/P1_WORKPLAN.md`。
- 十三张：rules 包（牌型评估、倒道校验、确定性 72,072 候选自动摆牌、配置化结算）+ Pixi 本地练习牌桌；本地演示不登录、不扣资产。
- 前端：大厅/子厅/难度流、钱包/社交/客服/邀请/公告/消息工作区（LOCAL_DEMO + LOCAL_BROWSER_SERVER 双模式，`apps/web/src/platform/browser-api/`）；AI WebP 背景与启动屏。
- Admin：19 个领域工作区 + 响应式导航（本地演示数据）。
- 生产镜像：多阶段 `Dockerfile` + `prod` profile。

## 2. 未完成（不要引用为已有能力）

- 服务端：wallet 写用例与事务、支付订单/渠道回调、返佣发放、房间与牌局权威、Socket.IO、outbox worker、Admin 路由。
  - **施工蓝图已立（2026-11-03）**：`docs/02_architecture/后端实施SDD.md`——63 表 model 注册与 0007~0018 迁移批次、`packages/backend` 模块/用例/端口布局、玩家 + Admin HTTP 端点清单、Socket.IO 三命名空间与 outbox 投递管线、Admin（Vue3.5+Element Plus）双轨切换映射、9 步实施顺序。
  - **实体与迁移已落地（2026-11-03）**：`packages/backend` 包脚手架 + 0007~0018 共 12 批次 57 张表（数据库设计 SDD §5 逐表对照、附录 A.13 校验）；`apps/server` 的 0001~0006 迁移基础设施迁入 backend，server 仅保留 Sequelize 实例 + 探针；server 迁移 CLI 与 `MIGRATION_TEST` 委托 backend 全链 0001~0018，63 张表 up→down→up 验证通过。
  - **Model 注册层已落地（2026-11-03）**：`packages/backend/src/infrastructure/database/models/` 13 文件注册全部 63 张表（11 领域文件 + coin-market + index.ts 中央注册器 + _shared.ts 公共支撑）；A.12 装配约定全部落实（中央 `addModels` + `associateAll` 跨文件 FK、不可变表 append-only hooks、outbox/coin-market `paranoid: false` 例外、生成列不进 attributes、保留字反引号、BINARY 近似映射）。container lint/format:check/typecheck 全绿。
  - **identity 模块已落地（2026-11-03，§9 第 1 步）**：`packages/backend/src/infrastructure/redis/`（ioredis 单例 + Redis 会话权威存储 + Lua 原子 refresh 轮换 + 30s 弱网重放窗口 + 限频）、`infrastructure/jwt/`（jose ES256 签发/验签，固定 claims，PEM env 或 dev 内存密钥）、`modules/identity/`（domain 密码/TOTP/联系方式规则 + 8 ports + 4 adapters + 11 用例 + 装配工厂 + public 唯一入口）；`apps/server` 新增 `http/auth.routes.ts`（auth 6 端点 + me/identity 3 端点）与 `infrastructure/auth/player-auth-middleware.ts`（Bearer 验签 + Redis session + auth_version 三重门禁），`main.ts` 装配 identityModule（MySQL/Redis 缺失时降级不挂载 auth 路由）。全量门禁（lint/format/typecheck/test/build）容器内全绿。
  - **Socket 握手鉴权基座已落地（2026-11-03，§6.1）**：`apps/server/src/socket/socket-auth.ts`（/platform 命名空间，握手三重门禁，session.reauthorize 原地更新，disconnectUser 按 user 断开）；socket.io ^4.8.1 入 lockfile；优雅关闭顺序 io → redis → sequelize。未闭环：/admin 与 /room/:roomId 命名空间（随 §9 第 4/9 步）、多实例 pub/sub 广播断开。
  - 未闭环登记（identity）：TOTP 密文 KMS 未接入（占位封装）、outbox worker 未建（8 topic 已登记）、WelcomeGiftPort 归 wallet 模块（TODO）、refresh 路由依赖 Cookie 双值（sid + refresh token）。
  - 下一步（§9 第 2 步）：auth 端点 contract test（把身份流程验收补全）+ 钱包闭环（summary/activity/transfer/exchange 真实 handler，替换 Browser API 为 REMOTE 权威，5% 手续费/分录守恒/流水门槛验收）。已知差异：contracts `CoinMarketTradeStatus` 9 值 vs DDL 11 值，双轨切换前须对齐。
- 前端生产态：生产构建只注入 `gameExperienceApi`，钱包/社交/客服/邀请在 REMOTE 下缺失（P0-P1 差距项）。
- Admin：无登录鉴权、无领域 API（19 个工作区全是本地演示数据）。
- 规划未建：`packages/game-sdk`/`game-host`/`resource-runtime`/`platform-client`、`apps/worker`/`mobile`/`desktop`、`tests/`（e2e/负载/弱网）。
- PWA/Workbox 预加载：README 描述为目标能力，代码中无 SW/manifest。

## 3. 已知问题与技术债

- 用例层下沉第一批已完成（12 文件，见 §1）；**剩余第二批暂缓**（用户 2026-11-03 确认双轨为设计需要，前后端不同步开发）：`local-identity-application`（495 行，强浏览器依赖：IndexedDB/TOTP/crypto）与 `social-message-asset-application`（80 行，本地资产加密）保持现状，待后台代码开写后按端点分批双轨切换，最后删 `browser-api/`。
- **lockfile 已更新（2026-11-02 容器内 `pnpm install`）**：`packages/domain` 新增 `@sinclair/typebox` 依赖、`packages/contracts` 新增 `tsx` devDependency，lockfile 已同步（含 pnpm 自动 bump 的 supports-color 可选依赖链）。容器内 8 门逐包顺序跑全绿。
- 文档与代码矛盾：README/规划称 "Workbox + vite-plugin-pwa"，实际未实现——落地前按未完成处理。
- `apps/web` 宿主机构建 EPIPE、清 dist 触发批量删除保护：一律走容器命令。
- CI 耗时：4-worker 测试改动未在健康机器验证；以 CI 日志为准（路线文档 P0 执行状态表有实测记录）。
- 公告 `GET /platform/announcements/active` 空列表 stub 不得视为公告业务闭环。

## 4. 更新纪律

每次施工完成后：
1. **必须更新本文件**对应小节（已实现/未完成/已知问题三选其一或组合）。
2. 更新受影响 SDD 与所有改动 Markdown 的"变更历史"。
3. 改完代码跑 `graphify update .`。
4. 报告实现范围、验证结果及未闭环事项。未运行的检查不得描述为通过。

> 本文件是"代理施工前必读"的状态快照（见 `AGENT_WORKFLOW.md` 步骤 2）。任何把本文标记为"已完成"的代码改动，必须同步修改本文对应小节，否则视为未闭环。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-02 | 新建：按 2026-10-23 P0 收口基线整理已实现/未完成/已知问题清单，并登记 PWA 矛盾与用例层未下沉债。 |
| 2026-11-02 | 强化 §4 更新纪律：把"本文件"列为施工后必更项，并明确"标记已完成必须同步修改对应小节"，与 `AGENT_WORKFLOW.md` 对齐。 |
| 2026-11-02 | §1 增加"用例层下沉第一批（12 文件）已完成"条目；§3 把"用例层未下沉"债改为"第二批剩余 + lockfile 待更新"。 |
| 2026-11-02 | §3 lockfile 债标记为"已更新（容器内 pnpm install）"；8 门逐包顺序跑全绿；修 `apps/server/scripts/build.mjs` 加 Sequelize dialect external。 |
| 2026-11-03 | 第二批双轨切换标记为"暂缓"（用户确认前后端不同步开发，启动条件为后台代码开写）。 |
| 2026-11-03 | §2 登记《后端实施 SDD》为服务端施工蓝图（63 表实体起步 → 模块 → HTTP/Socket.IO → Admin 双轨切换 → 9 步实施顺序）；代码未开写。 |
| 2026-11-03 | §1 数据库条目更新为 63 张表（0001~0018）；§2 登记"实体与迁移已落地"——`packages/backend` 脚手架 + 57 张新表迁移 + server 迁移基础设施迁入 backend + CLI/MIGRATION_TEST 委托全链，63 表 up→down→up 容器实测通过；model 注册与模块用例仍属未完成。 |
| 2026-11-03 | §2 登记"Model 注册层已落地"（13 文件 63 表，A.12 全落实）与"identity 模块已落地"（Redis 会话 + JWT ES256 + 11 用例 + auth 路由 + 认证中间件，全量门禁绿）；未闭环登记 TOTP KMS / outbox worker / WelcomeGiftPort / refresh Cookie 双值。 |
| 2026-11-03 | §2 登记"Socket 握手鉴权基座已落地"（/platform 命名空间 + session.reauthorize + disconnectUser，socket.io ^4.8.1）；§9 第 1 步收口，下一步 §9 第 2 步钱包闭环。 |
