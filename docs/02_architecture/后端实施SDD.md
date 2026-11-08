# 后端实施 SDD（Admin 管理端 + API + Socket.IO）

**状态：施工基线稿，按本文顺序纵向推进。版本：0.1（2026-11-03）。**

本 SDD 是[代码分层与接口实现规范](./代码分层与接口实现规范.md)、[HTTP 接口与共享 DTO 协议 SDD](./HTTP接口与共享DTO协议SDD.md)、[数据库设计 SDD](../05_data/数据库设计SDD.md)、[JWT 登录与会话设计](../04_domains/JWT登录与会话设计.md)与[客服 IM 设计](../04_domains/客服IM与用户工单设计.md)的**后端落地层**：从实体（Sequelize model）起步，到 HTTP/Socket 传输、Admin 管理端（Vue 3.5 + Element Plus），Docker 复用现有 compose。它**不重定义**任何业务规则；金额、状态、权限、审计一律指向既有权威文档。

## 0. 与现状的差异与口径

- 已存在（P0 基线 `2253603`/`dc78c34`）：`apps/server` Koa 基座（envelope / 错误边界 / requestId / 探活 / 游戏目录只读路由）、Sequelize + Umzug（0001~0006 六张表已迁移验证）、Redis/MySQL 探针。
- 本 SDD 新增：`packages/backend` 领域模块包（实体 / 用例 / 端口 / 适配器）、`apps/server` 的 HTTP 业务路由与 Socket.IO 接入、`apps/admin` 的认证与 Admin API 对接。
- **依赖方向铁律不变**：实体（Sequelize model）只在 `packages/backend` 的 `infrastructure/database` 与各领域 `adapters/`；`packages/domain` 与 `packages/contracts` 不 import Sequelize/Koa/Socket。Admin 前端只依赖 `@gameing/admin-contracts` + 平台 HTTP/Socket 能力，不碰 backend 源码。
- **Docker**：全部沿用现有 `compose.yaml`（`dev`/`full` profile），不新增编排；本文只规定服务内依赖与就绪检查。
- 后端代码**尚未开写**（用户 2026-11-03 确认）；本 SDD 即第二批双轨切换的"后台代码开写"起点。

## 1. 包布局与依赖

```text
packages/backend/                 @gameing/backend（Node-only，禁浏览器引用）
  src/
    infrastructure/
      database/                   # 已有 Sequelize/Umzug 从 apps/server 迁入并扩展
        models/                   # 全部 63 张表的 Sequelize model（§3）
        migrations/               # Umzug 迁移（0001~0006 已有；新增 0007+）
        repository-support.ts     # 行映射 / 分页游标 / 锁辅助（技术件，非业务）
      redis/                      # 会话 / 匹配队列 / 临时归因 / 限频计数
      jwt/                        # access 签发/校验、refresh 轮换（Redis Lua）
      outbox/                     # outbox 消费者、topic 注册
      auth/                       # HTTP/Socket 认证中间件（玩家 + Admin 双 audience）
      idempotency/                # 幂等键存取（asset_operation / 域级 key）
    modules/
      identity/                   # user/device/recovery_credential/安全事件
      wallet/                     # asset_account/operation/entry/hold + coin_exchange/gift_grant/turnover_state
      payments/                   # provider/channel/product/order/payment_event/withdrawal/payout/external_settlement/chain_*
      referral/                   # referral_binding/event/reward_allocation
      game/                       # game/game_tier/game_config/game_entry + room/round*/settlement
      social/                     # 8 社交实体 + 审核
      support/                    # support_conversation/message
      admin/                      # admin_permission/admin_audit_event/agent_domain/agent_audit_event
      configuration/              # system_config/game_config 读取与发布
      platform-events/            # game_event_instance/outbox 事件投影
      ai-assets/                  # ai_asset_job/artifact/reference + asset/asset_release*
    workflows/                    # 跨域编排（结算入账、配置发布+审计、提现出款）
    public.ts                     # 仅导出各模块 public.ts 聚合 + 装配工厂
  依赖：@gameing/contracts、@gameing/admin-contracts、@gameing/domain、sequelize、mysql2、redis、socket.io、jsonwebtoken
  禁止：Vue/DOM/浏览器 API
```

- `apps/server` 瘦身为**传输装配层**：HTTP（Koa 路由 → 调 backend 用例）、Socket.IO（命名空间/命令 → 调 backend 用例 + outbox 投递）、worker（outbox 消费、恢复任务）。装配在 `apps/server/src/bootstrap/`。
- 现有 `apps/server/src/infrastructure/database/`（Sequelize 实例 + 0001~0006 迁移）迁入 `packages/backend/src/infrastructure/database/`；`apps/server` 的探针（mysql/redis-probe）保留在 server 侧（进程健康，非领域）。
- 用例/规则纯逻辑复用 `packages/domain`（钱包 5% 手续费、返点 10/8/5/3、流水门槛等**已下沉**）；backend 模块的 `domain/` 子目录只放该实体专属的不变量与映射，不复制 domain 包规则。

## 2. 实体层（§3 详表）与模型约定

每个 Sequelize model 与数据库设计 SDD 的逐表定义一一对应，硬性约定：

1. **全表公共字段**：`id BIGINT UNSIGNED`（model 用 `string` 承载 + `DataTypes.BIGINT`，读写一律十进制字符串）、`status`、`created_at/updated_at/deleted_at DATETIME(3)`（UTC）、全字段 `comment`。迁移逐字段写注释。
2. **ID/金额 wire 格式**：model getter/setter 保持 BIGINT；**DTO 映射层**（adapter 的 row-mapper）把 ID/金额转十进制字符串，禁止 JS number 跨越 `Number.MAX_SAFE_INTEGER`。
3. **不可变表**（asset_operation/asset_entry、referral_binding_event、round_event、agent_audit_event/admin_audit_event、user_security_event、payment_event、ai_asset_reference）：model 关闭 `updated_at` 自动更新与软删钩子；用例层提供 append-only API，不提供 update/destroy。`outbox` 例外：行 append-only 但 status 有投递状态机（OutboxStatus 1~4），updated_at 随投递更新。
4. **generated 列**（`system_marker`、`active_marker`）：建列表达式与 SDD §5 完全一致，Sequelize 声明 `DataTypes.VIRTUAL` 只读或原生列（按 MySQL 支持选择原生 persisted 以便唯一索引生效）。
5. **保留字**：`order` 表、`user` 表在 SQL 与 Sequelize 引用处一律加反引号。
6. 每个 model 文件头部注释写明：**领域所有者、读写用例、对应 SDD 章节**；评审时按注释核对越界写入。

## 3. 实体注册表（63 表 → model 文件 → 领域模块 → 迁移批次）

### 3.1 迁移批次（沿用 0001~0006，新增 0007+）

| 批次 | 表 | 说明 |
| --- | --- | --- |
| 0001~0006（已有） | migration_history / user / asset_account / asset_operation / asset_entry / asset_hold | P0 已迁移验证 |
| 0007 | device / recovery_credential / user_security_event | 身份与会话 |
| 0008 | game / game_tier / game_config / system_config / game_event_instance | 大厅与配置 |
| 0009 | agent_domain / admin_permission / admin_audit_event / agent_audit_event | 管理与审计 |
| 0010 | coin_exchange / gift_grant / turnover_state / order / payment_provider / payment_channel / product / payment_event / external_settlement / withdrawal / payout_account / payout_attempt | 资产与支付 |
| 0011 | chain_address / chain_deposit_event / chain_scan_cursor | 链到账 |
| 0012 | referral_binding / referral_binding_event / referral_reward_allocation | 邀请返佣 |
| 0013 | room / room_membership / round / round_player / round_event / settlement / game_entry | 房间牌局 |
| 0014 | 社交 8 表（social_topic / social_post / social_post_reply / social_friendship / social_conversation / social_message / social_block / social_report / social_content_interaction） | 社交 |
| 0015 | support_conversation / support_message | 客服 |
| 0016 | coin_market_listing / coin_market_trade | 金币集市 |
| 0017 | ai_asset_job / ai_asset_artifact / ai_asset_reference / asset / asset_release / asset_release_item | AI 素材台账与统一资产 |
| 0018 | outbox | 事件与任务 |

（数据库设计 SDD 开头写"全库定义 62 张表"，但其 §5 逐表定义实际为 **63 张**（多出 `outbox`，开头数字未随 outbox 加入而更新）。本 SDD 按 §5 的 63 张逐表定义为准；实施时若业务方裁决出 `outbox` 等表增删，以更新后的数据库设计 SDD 为准并同步修订本表。批次划分可按模块施工顺序调整，但**每个批次必须能独立 up/down**。）

### 3.2 实体归属矩阵（model 文件放各模块 `adapters/sequelize-*.ts` 或共享 `infrastructure/database/models/`）

| 模块 | owns（唯一写入者） | model 文件 |
| --- | --- | --- |
| identity | user / device / recovery_credential / user_security_event | `models/identity.ts` |
| wallet | asset_account / asset_operation / asset_entry / asset_hold / coin_exchange / gift_grant / turnover_state | `models/wallet.ts` |
| payments | payment_provider / payment_channel / product / order / payment_event / external_settlement / withdrawal / payout_account / payout_attempt | `models/payments.ts` |
| chain（payments 的子域） | chain_address / chain_deposit_event / chain_scan_cursor（USDT 链到账，写入归 payments 用例；model 文件可独立 `models/chain.ts` 便于 worker 扫描租约隔离） | `models/chain.ts` |
| referral | referral_binding / referral_binding_event / referral_reward_allocation | `models/referral.ts` |
| game | game / game_tier / game_config / system_config / game_entry / room / room_membership / round / round_player / round_event / settlement | `models/game.ts` |
| social | social_*（9 表） | `models/social.ts` |
| support | support_conversation / support_message | `models/support.ts` |
| admin | admin_permission / admin_audit_event / agent_domain / agent_audit_event | `models/admin.ts` |
| platform-events | game_event_instance / outbox | `models/events.ts` |
| ai-assets | asset / asset_release / asset_release_item / ai_asset_* | `models/assets.ts` |
| configuration | system_config 读取（写入经 admin 模块审计） | 复用 `models/game.ts` |

跨域写入只允许经 `workflows/`（同一 `UnitOfWork`），禁止模块 A 直接 `Model.update()` 模块 B 的表。

## 4. 用例与端口（application / ports / adapters）

每个模块按[代码分层规范 §4/§5](./代码分层与接口实现规范.md)布局：

```text
modules/wallet/
  domain/            # 本实体专属不变量（金额守恒校验、版本冲突判定）；纯函数，依赖 @gameing/domain
  application/       # transferCoins / quoteExchange / settleRound / grantWelcomeGift / withdrawalHold...
  ports/             # WalletRepository / AssetLedger / IdempotencyStore / Clock / ConfigReader
  adapters/          # sequelize-wallet-repository.ts、redis-idempotency.ts、row-mappers.ts
  public.ts          # 跨模块唯一入口
```

关键约定：

- **事务**：用例调用 `unitOfWork.run(scope)`；锁顺序固定 `sender account → receiver account → hold`（按 asset_account.id）；幂等先抢 `asset_operation.operation_key` 唯一约束，所有分录/outbox 同事务。
- **幂等**：资金命令走 `asset_operation`；域级（客服消息、帖子、订单）走各自 `*_key`/`request_key` 唯一约束；HTTP `Idempotency-Key` 由 adapter 映射到域 key。
- **ConfigReader 端口**：`system_config`/`game_config` 的运行时解析（parser allowlist + 范围校验）归 `configuration` 模块 public API；wallet/payments 通过端口读，不直接查表。
- **审计**：admin 模块的用例负责把 `admin_audit_event` 与目标域变更**同事务**提交（`workflows/` 编排），拒绝/失败也在回滚后补记审计（`result_type=DENIED/FAILED`）。

## 5. HTTP API

### 5.1 路由组织（`apps/server/src/http/`）

```text
http/
  player/                     # 前缀 /api/v1/（玩家 audience）
    auth.routes.ts            # /auth/device-register、device-login、password-login、refresh、logout、recovery（§JWT 设计 §4）
    identity.routes.ts        # /me/identity/*（设置、联系方式、TOTP）
    wallet.routes.ts          # /me/wallet/summary、activity、transfers(quote)、exchanges(quote)
    payments.routes.ts        # /me/orders、/me/withdrawals、/me/payout-accounts
    referral.routes.ts        # /me/invite-link、/me/referrals/*、/me/agent-domain/*
    game.routes.ts            # /games/*（替换 LOCAL_DEMO stub）、/me/rooms、/me/rounds
    social.routes.ts          # /me/social/*、/social/*（公开 feed）
    support.routes.ts         # /me/support/conversations*（客服 SDD §3）
  admin/                      # 前缀 /admin-api/v1/（Admin audience + admin_permission 校验）
    users.routes.ts           # 用户查询/停用/TOTP 人工处置（关联 support 会话）
    wallet.routes.ts          # 资产调整（双人复核：operated_by ≠ approved_by）
    payments.routes.ts       # 订单/提现审核与出款、渠道与产品配置、Mock 支付操作页
    referral.routes.ts        # 换绑审批、奖励复核
    game.routes.ts           # 目录/档位/配置发布、期望计算器任务（异步 202）
    social.routes.ts         # 社区审核、私信调阅（agent 域经 agent_audit_event）
    support.routes.ts        # 坐席队列：list/claim/reply/resolve/reopen（客服 SDD §6）
    config.routes.ts         # system_config 发布（前后值审计）
    audit.routes.ts          # admin_audit_event 查询
```

### 5.2 认证中间件（`infrastructure/auth/`）

- 玩家：`Authorization: Bearer <access>` → 验签 + Redis session 仍 ACTIVE + `auth_version` 一致（[JWT 设计 §2/§3](../04_domains/JWT登录与会话设计.md)）。
- Admin：同 JWT 流程但 `aud=admin`，`user.role_type & 4`；每个路由在 registry 声明 `permission_code`，中间件按 `admin_permission(http_method, path_pattern)` 目录 + 当前 `user.permissions` 双重校验。Support claim/resolve 已先在 route 事务内实施此 fail-closed 模式，权限码分别为 `admin.support.claim` / `admin.support.resolve`；其余 Admin endpoints 的通用 registry/middleware 尚未接入。
- 失败映射：401 缺/无效/过期/撤销；403 权限不足；与 envelope `code` 注册表一致（[HTTP 协议 SDD §5](./HTTP接口与共享DTO协议SDD.md)）。

### 5.3 Endpoint registry 与 OpenAPI

- 每条路由在 `packages/backend/src/http/registry/` 登记 `method/path/audience/permission/request schema/response schema/success status/idempotency/error codes/摘要`；**请求/响应 schema 一律引用 `@gameing/contracts` 与 `@gameing/admin-contracts` 的 TypeBox schema，不手写第二套 DTO**。
- 生成器沿用 `packages/contracts` 的 OpenAPI registry（`openapi.mjs` + CI 第 7/8 关）；Admin API 在 `packages/admin-contracts` 增加对应 `openapi/registry.ts`，CI 并列检查。
- 现有 stub（`/platform/announcements/active`、`/games*` 的 LOCAL_DEMO 快照）在 platform-events / game 模块落地后替换为真实查询，**替换后必须跑 contract test**（HTTP 协议 SDD §12 未闭环项）。

### 5.4 玩家端点清单（与共享 contracts 已登记的 DTO 对齐）

| 域 | 端点（/api/v1/） | 状态 |
| --- | --- | --- |
| auth | device-register / device-login / password-login / refresh / logout / recovery | 新实现 |
| identity | settings、username、password、email、phone、totp setup/confirm/disable、devices list/revoke | 契约已有，handler 新实现 |
| wallet | me/wallet/summary、activity、transfers/quote+submit、exchanges/quote+submit | 契约已有，handler 新实现 |
| payments | me/orders(create+list+detail)、me/withdrawals、me/payout-accounts、me/funding/channels+products | 新实现 |
| referral | me/invite-link、me/referrals/direct-invitees、me/referrals/rewards、me/agent-domain/* | 契约已有 |
| game | games/*（真目录）、me/rooms/*、me/rounds/*（快照/历史）、me/game-entries（preflight 真资格） | stub 替换 |
| social | me/social/*、/social/posts|replies（公开） | 契约已有 |
| support | me/support/conversations* | 契约已有 |
| platform-events | me/platform-events/active（替换公告 stub） | 新实现 |

## 6. Socket.IO（`apps/server/src/socket/` + `infrastructure/`）

### 6.1 命名空间与鉴权

| 命名空间 | 连接方 | 鉴权 |
| --- | --- | --- |
| `/platform` | 玩家大厅（消息与事项、公告、客服新消息提示） | 握手 `auth.accessToken` → 同 §5.2 玩家验证；`sid` 存连接 |
| `/admin` | Admin 坐席（客服新会话/消息、提现待审队列） | Admin audience + 最小 capability |
| `/room/:roomId`（动态） | 牌局参与人 | 玩家 token + 房间成员校验（room_membership） |

- 握手拒绝（401 语义）不建立连接；**连接建立 ≠ 永久授权**：每条受保护命令重查会话过期与 `auth_version`（[JWT 设计 §2](../04_domains/JWT登录与会话设计.md)）。
- 过期前客户端提前 HTTP refresh，经 `session.reauthorize` 命令更新该连接认证上下文（同 sid/userId），重连走标准握手。
- 登出/封禁/停权：identity/admin 用例撤销 Redis session 后，server 侧按 `user_id` 断开相关连接（Redis Set 维护 user→connection）。

### 6.2 命令与事件（共享 payload schema）

- 命令 envelope `{ commandId, schemaVersion, payload }`，ACK `{ accepted|rejected, code?, data? }`；`commandId` 幂等（资金/牌局动作复用原 commandId 重发不产生第二笔）。
- 事件 envelope `{ eventId, schemaVersion, stateVersion?, payload }`。
- payload 与 HTTP 共用**同一 TypeBox DTO**（如 `WalletSummaryDto`、`RoundSnapshotDto`、`SupportMessageDto`），传输 wrapper 各自独立（[HTTP 协议 SDD §9](./HTTP接口与共享DTO协议SDD.md)）。

### 6.3 事件投递管线（outbox 为权威）

```text
领域事务（wallet/payments/social/support/game...）
  → 同事务写 outbox(topic, user_id, payload, available_at)
  → outbox worker（apps/server worker 入口或进程内 ticker，首版进程内 + 租约）
  → 按 user_id 投递 /platform；room 事件投递 /room/:roomId；Admin 队列事件投递 /admin
  → 投递成功置 SENT；消费者幂等（event_key）
```

- **先持久化、后推送**：Socket 只发提示/增量，客户端收到 `stateVersion` 变化后按域 HTTP 补权威快照；断线补拉走 HTTP（`social_message` 按 message_no、`support_message` 按 id、牌局按 round 快照）。
- 平台营销公告**无 per-user 已读回执**；Socket 推送的是变化提示（[数据库 SDD outbox 实体规则](../05_data/数据库设计SDD.md)）。
- 生产客服附件与坐席实时消息：`support_message` 落库 + outbox 后投递 `/platform` 与 `/admin` 两侧（客服 SDD §6 未闭环项）。

## 7. Admin 管理端（`apps/admin`，Vue 3.5 + Element Plus）

### 7.1 现状与切换

- 现状：19 个领域工作区全部 **LOCAL_DEMO / IndexedDB 适配器**（无认证、无领域 API）。
- 切换策略（双轨）：每工作区把 `composition.ts` 的本地 adapter 换成 **Admin API client**（`@gameing/admin-contracts` 同一套 TypeBox schema + 统一 envelope + `/admin-api/v1` 前缀），feature flag 保留本地演练入口；服务端就绪一个、切换一个，最后退役 `browser-development-database.ts` 的 admin 侧（玩家侧 browser-api 退役条件另见 P1_WORKPLAN §5）。
- 页面/组件**不改** Element Plus 布局与既有几何验收口径；只换数据源与鉴权，每改一个工作区做视口几何验收（AGENTS.md 纪律）。

### 7.2 认证与权限 UI

- Admin 登录：`/admin-api/v1/auth/*`（username+password+可选 TOTP，Admin audience）。令牌存内存 + HttpOnly refresh cookie（同 JWT 设计 §2 的 App 侧策略）。
- 权限隐藏**只优化 UI**：路由/按钮按 `admin_permission` 目录 + 当前 user.permissions 渲染；服务端仍逐端点校验。
- 双人复核 UI：资产调整/提现审批页区分"申请人"与"审批人"操作位（`operated_by ≠ approved_by` 由服务端强制）。

### 7.3 工作区 ↔ Admin API 映射

| 工作区（现有） | 对应 /admin-api/v1 域 | 审计 |
| --- | --- | --- |
| admin-users / admin-permissions | users / 权限授予（auth_version 递增） | admin_audit_event |
| admin-audit | 审计查询 | — |
| agent-domain-review | agent_domain 审批/暂停/撤销 | admin_audit_event |
| agent-downlines / agent-social / agent-announcements / agent-game-config | 代理域读模型与配置发布（代理端走 /api/v1/agent/*，Admin 侧走域管理） | agent_audit_event |
| mock-payment / payment-channels | 支付渠道/产品/Mock 操作页（MOCK provider 仅开发环境） | admin_audit_event |
| game-catalog / game-operations / event-operations | game/game_tier/game_config/game_event_instance 与期望计算器（202 异步任务） | admin_audit_event |
| system-config / announcement-templates | 配置与公告模板发布（前后值快照） | admin_audit_event |
| referrals | 换绑审批、奖励复核 | admin_audit_event |
| social-moderation / support-desk | 社区审核、坐席队列 | admin_audit_event / support 关联 |

## 8. Docker（沿用现有 compose，不新造）

- 不新增 service/profile；`full` profile 已有 server/admin/web，缺的只有**生产发布形态**（release-build、worker 独立入口、迁移 job 独立执行）——列为后续运维项，不在本 SDD 范围。
- 本 SDD 在现有服务内的约定：
  - server 启动顺序：`prepare-volumes` → 迁移（`pnpm --filter @gameing/server migrate up`，独立任务执行，**多副本不并发改表**）→ readiness（mysql/redis 探针）→ HTTP + Socket 监听。
  - 会话/限频/匹配队列全部走现有 Redis（10371）；MySQL（10306）为唯一账本权威。
  - dev 容器内 `pnpm install` 已 frozen-lockfile 化；本 SDD 新增依赖（socket.io、jsonwebtoken、ioredis 或 redis client、argon2/bcrypt）须走 `pnpm install` 更新 lockfile 后合入（不可手改 lockfile）。
- 依赖选型建议（实施时按许可/维护政策核实并锁定）：Socket.IO 4.x（自带 polling 降级 + CORS）、`jsonwebtoken` 或 `jose`（ES256）、`ioredis`（Lua/租约支持好）、argon2 原生绑定失败时回退 bcrypt（与 user 表注释一致）。

## 9. 实施顺序（纵向闭环，按模块验收）

每步 = 迁移批次 + 模块用例 + 路由 + 契约测试 + `pnpm check:changed` + 受影响的 Admin 工作区切换；资金/迁移相关补 `MIGRATION_TEST=1` 集成测试。

1. **身份与会话**（0007）：auth 6 端点 + TOTP/联系方式 + Redis 会话与 refresh 轮换 + Socket 握手鉴权基座。验收：设备注册→登录→刷新轮换→撤销重放检测→Socket 断连。
2. **钱包闭环**（0010 子集）：summary/activity/transfer/exchange 真实 handler（替换 Browser API 为 REMOTE 权威）。验收：转账幂等/5% 手续费/分录守恒/流水门槛，Admin 资产调整双人复核。
3. **支付与提现**（0010/0011）：orders/withdrawals/payouts + 渠道 + Mock 操作页 + 链到账 worker。验收：Mock 下单→支付事件→履约→提现审核→出款状态机全链路。
4. **房间与牌局**（0013）：game_entry 真资格、room/round handler 接入 `games/shisanshui/server`（结算一次、`settlement` 唯一入账）、`/room/:roomId` 命名空间。验收：开局→提交→结算入账→断线恢复重放。
5. **社交与客服**（0014/0015）：好友/私信/社区 + 坐席队列 + 消息 outbox→Socket 双端投递 + 断线补拉。验收：双账号私信幂等、坐席领取/回复/重开、消息补拉一致性。
6. **邀请返佣与代理域**（0012/0009）：归因（Redis 直连 IP/邀请码）、返佣分配、agent_domain 审批与域配置发布。验收：五级 10/8/5/3、域隔离与审计。
7. **平台事件与金币集市**（0008/0016/0018）：game_event_instance 投影 + 公告替换 stub + 集市挂牌/成交/裁决。
8. **AI 素材台账**（0017）：asset/ai_asset_* 与发布（与现有 tools/asset-generation 台账对接）。
9. **Admin 全量切换收口**：19 工作区全部 REMOTE；退役 admin 侧 IndexedDB 演练（玩家侧 browser-api 按 P1_WORKPLAN §5 另行启动条件）。

每完成一步更新 `docs/09_agent/PROJECT_STATUS.md`（施工后必更纪律）与受影响 SDD 变更历史，跑 `graphify update .`。

## 10. 验收口径（红线）

- 服务端是唯一资产/身份权威；任何"本地 IndexedDB 改余额"路径不得进入生产构建（LOCAL_BROWSER_SERVER 保持 dev-only，token 生产拒收）。
- 资金命令：幂等键先抢、同事务分录 + outbox、失败可重查原结果，不产生第二笔。
- 审计表 append-only；Admin/Agent 敏感读取（含私聊调阅）必留痕（request_key 幂等、snapshot 脱敏、不含正文外的敏感信息）。
- 金额/ID wire 一律十进制字符串；状态常量非零；DTO 只出自 contracts 包，OpenAPI 由 registry 生成。
- 不把未跑的检查描述为通过；Admin 页面改动做视口几何验收。

## 附录 A：模型与表结构规划（63 表 → Sequelize Model）

> 本附录是 §3 实体注册表的**落地细节**：每张表对应的 Model 类名、关键字段（公共 5 字段 `id/status/created_at/updated_at/deleted_at` 按 §2 约定省略，仅列业务字段）、状态/类型常量、索引与约束。DDL 以 `docs/05_data/数据库设计SDD.md` §5 逐表定义为唯一权威，本附录只做 **Sequelize model 映射规划**，不重新定义表结构；发现矛盾先报告再修数据库设计 SDD。
>
> 约定（同 §2）：
> - Model 类名 = 表名 PascalCase + `Model`（`asset_account` → `AssetAccountModel`）；表名 `tableName` 显式指定 snake_case，`order`/`user` 加反引号。
> - 所有 `BIGINT UNSIGNED` ID 字段在 Model 类型中声明为 `string`（十进制字符串 wire），Sequelize attribute 用 `DataTypes.BIGINT.UNSIGNED`；金额列用有符号 `DataTypes.BIGINT`。
> - `DATETIME(3)` → `DataTypes.DATE(3)`，UTC；JSON → `DataTypes.JSON`；VARBINARY/BINARY(32) → `DataTypes.BINARY(n)`；MEDIUMBLOB → `DataTypes.BLOB`。
> - generated 列（`system_marker`/`active_marker`）：Model 声明 `field` 指向原生列，`onlyInCreate/onlyInUpdate: false`，读写均走 DB 表达式；Sequelize `DataTypes.VIRTUAL` 无法建唯一索引，故 **DDL 用原生 `GENERATED ALWAYS AS (..) STORED`**（与 0002 `user.system_marker` 写法一致），Model 侧标只读。
> - 不可变表（`asset_operation`/`asset_entry`/`*_event`/`*_audit_event`/`outbox`）：Model 选项 `timestamps: false` + 手工列 `created_at`/`updated_at`（`updated_at` 默认 = `created_at`，见 0004 写法），禁用 soft delete。

### A.1 identity（0007 批次：device / recovery_credential / user_security_event；user 已有 0002）

**Model 文件：`models/identity.ts`**（`UserModel` 已存在于 `apps/server` 0002 迁移，迁入 backend 后扩展）

| 表 | Model 类 | 关键字段（类型） | 常量/约束 |
| --- | --- | --- | --- |
| `user`（0002 已有） | `UserModel` | role_type SMALLINT UNSIGNED; reward_type; public_code VARCHAR(32) U; username VARCHAR(64) U; password_hash VARCHAR(255); email VARCHAR(254) U; phone VARCHAR(32) U; totp_secret_ciphertext VARBINARY(512); totp_last_accepted_counter BIGINT UNSIGNED; totp_recovery_code_hashes JSON; nickname VARCHAR(64); asset_id BIGINT UNSIGNED（FK 待 0017）; auth_version BIGINT UNSIGNED DEFAULT 1; permissions JSON; invite_code VARCHAR(32) U; system_marker GENERATED STORED U | UserStatus ACTIVE=1/DISABLED=2/CLOSED=3；role_type CHECK IN (1,3,4,8)；reward_type IN (1,2)；TOTP 成对 CHECK |
| `device` | `DeviceModel` | user_id FK; fingerprint_hash BINARY(32); device_digest BINARY(32); credential_key CHAR(36) U; credential_secret_hash BINARY(32); credential_status SMALLINT UNSIGNED（NULL=从未签发）; platform_type SMALLINT UNSIGNED; last_seen_at | CredentialStatus ACTIVE=1/REVOKED=2/EXPIRED=3；PlatformType WEB=1/IOS=2/ANDROID=3/WINDOWS=4/MACOS=5/LINUX=6 |
| `recovery_credential` | `RecoveryCredentialModel` | user_id FK; credential_key CHAR(36) U; secret_hash BINARY(32); active_marker GENERATED U(user_id,active_marker); expires_at; last_used_at; revoked_at | RecoveryStatus ISSUED=1/REVOKED=2/EXPIRED=3 |
| `user_security_event` | `UserSecurityEventModel`（不可变） | user_id; session_key CHAR(36); admin_session_key CHAR(36); admin_user_id; device_id; support_conversation_id; event_key VARCHAR(160) U; action_type SMALLINT UNSIGNED; result_type SMALLINT UNSIGNED; snapshot JSON | RecordStatus RECORDED=1；ActionType LOGIN=1/CONTACT=2/PASSWORD=3/RECOVERY=4/REVOKE=5/TOTP=6；ResultType SUCCESS=1/DENIED=2/FAILED=3 |

### A.2 game（0008：game / game_tier / game_config / system_config / game_event_instance；0013：room / room_membership / round / round_player / round_event / settlement / game_entry）

**Model 文件：`models/game.ts`**

| 表 | Model 类 | 关键字段（类型） | 常量/约束 |
| --- | --- | --- | --- |
| `game` | `GameModel` | game_code VARCHAR(64) U; name; integration_type SMALLINT UNSIGNED; client_module_key VARCHAR(128); asset_id BIGINT UNSIGNED FK(0017); sort_order INT | IntegrationType INTERNAL=1/EXTERNAL_STUB=2 |
| `game_tier` | `GameTierModel` | game_id FK; tier_code VARCHAR(64) U(game_id,tier_code); name; min_coins BIGINT; max_coins BIGINT NULL; sort_order INT | CHECK min_coins>=0 AND (max_coins IS NULL OR max_coins>=min_coins) |
| `system_config` | `SystemConfigModel` | config_key VARCHAR(128) U; config_type SMALLINT UNSIGNED; config_value TEXT; description VARCHAR(255) | ConfigType STRING=1/BOOLEAN=2/INTEGER=3/DECIMAL=4/JSON=5 |
| `game_config` | `GameConfigModel` | game_id FK; game_tier_id FK NULL; agent_domain_id FK NULL; scope_type SMALLINT UNSIGNED; config_key; config_type; config_value TEXT; description | U(COALESCE(agent_domain_id,0),game_id,COALESCE(game_tier_id,0),config_key)；CHECK scope_type 与 game_tier_id 空值匹配 |
| `game_event_instance` | `GameEventInstanceModel` | event_key CHAR(36) U; trigger_key VARCHAR(160) U; event_type SMALLINT UNSIGNED; agent_domain_id NULL; audience_scope_type SMALLINT UNSIGNED; game_id/game_tier_id NULL; source_round_id NULL; source_actor_type; subject_user_id NULL; state_version BIGINT UNSIGNED DEFAULT 1; starts_at/expires_at/ended_at; end_reason_type NULL; config_snapshot JSON; effect_snapshot JSON; runtime_snapshot JSON NULL; announcement_snapshot JSON | GameEventInstanceStatus ACTIVE=1/ENDED=2/CANCELLED=3；EndReason EXPIRED=1/POOL_EXHAUSTED=2/ADMIN_CANCELLED=3；AudienceScope GLOBAL=1/GAME=2/GAME_TIER=3 |
| `room` | `RoomModel` | game_id/game_tier_id FK; room_key VARCHAR(64) U; room_type SMALLINT UNSIGNED; capacity SMALLINT UNSIGNED; rules_snapshot JSON; version BIGINT UNSIGNED DEFAULT 1; owner_key VARCHAR(128) NULL; fencing_token BIGINT UNSIGNED DEFAULT 1; checkpoint_version BIGINT UNSIGNED DEFAULT 0; closed_at | RoomStatus WAITING=1/ACTIVE=2/RECOVERING=3/CLOSED=4；RoomType PRIVATE=1/MATCHED=2 |
| `room_membership` | `RoomMembershipModel` | room_id/user_id FK; seat_no SMALLINT UNSIGNED; joined_at; left_at NULL; game_state_ciphertext MEDIUMBLOB NULL; game_state_version BIGINT UNSIGNED DEFAULT 1; active_marker GENERATED | MembershipStatus SEATED=1/LEFT=2；U(user_id,active_marker)；U(room_id,seat_no,active_marker) |
| `round` | `RoundModel` | room_id FK; round_no BIGINT UNSIGNED; round_key CHAR(36) U; fencing_token; handler_version VARCHAR(64); rules_snapshot JSON; rules_hash BINARY(32); game_state_ciphertext MEDIUMBLOB NULL; playing_started_at/playing_deadline_at NULL; settlement_input JSON NULL; settlement_input_hash BINARY(32) NULL; settled_at NULL | RoundStatus PREPARING=1/ACTIVE=2/SETTLING=3/SETTLED=4/CANCELLED=5/RECOVERING=6；U(room_id,round_no)；U(round_key) |
| `round_player` | `RoundPlayerModel` | round_id/user_id FK; room_membership_id NULL; seat_no SMALLINT UNSIGNED; asset_hold_id FK U; player_state_ciphertext MEDIUMBLOB NULL; submission_snapshot JSON NULL; submission_key CHAR(36) NULL U; submission_hash BINARY(32) NULL; submitted_at NULL; submission_type NULL; wager_coins BIGINT; max_loss_hold_coins BIGINT; net_coin_delta BIGINT NULL | RoundPlayerStatus ACTIVE=1/SUBMITTED=2/SETTLED=3/ABORTED=4；SubmissionType MANUAL=1/TIMEOUT_AUTO=2；U(round_id,user_id)；U(round_id,seat_no) |
| `round_event` | `RoundEventModel`（不可变） | round_id/round_player_id FK; seq BIGINT UNSIGNED; event_key VARCHAR(160) U; event_type SMALLINT UNSIGNED; fencing_token; payload_ciphertext MEDIUMBLOB | RecordStatus RECORDED=1；EventType START=1/SUBMIT=2/INTENT=3/SETTLE=4/RECOVER=5/CANCEL=6；U(round_id,seq)；U(event_key) |
| `settlement` | `SettlementModel` | round_id FK U; asset_operation_id FK NULL U; input_hash BINARY(32); result_hash BINARY(32); result_snapshot JSON; completed_at NULL | SettlementStatus PREPARED=1/COMMITTED=2/CANCELLED=3；U(round_id)；U(asset_operation_id) |
| `game_entry` | `GameEntryModel` | user_id/game_id/game_tier_id FK; entry_key CHAR(36) U; rules_snapshot JSON; room_id NULL; expires_at; active_marker GENERATED | EntryStatus QUEUED=1/SEATED=2/FINISHED=3/CANCELLED=4/EXPIRED=5；U(user_id,active_marker) |

### A.3 wallet（0003~0006 已有 + 0010：coin_exchange / gift_grant / turnover_state）

**Model 文件：`models/wallet.ts`**（`AssetAccountModel`/`AssetOperationModel`/`AssetEntryModel`/`AssetHoldModel` 已存在于 0003~0006，迁入 backend）

| 表 | Model 类 | 关键字段（类型） | 常量/约束 |
| --- | --- | --- | --- |
| `asset_account`（0003） | `AssetAccountModel` | user_id FK U(user_id,asset_type,currency); account_type SMALLINT UNSIGNED; asset_type SMALLINT UNSIGNED; currency CHAR(3); amount BIGINT DEFAULT 0; frozen_amount BIGINT DEFAULT 0; version BIGINT UNSIGNED DEFAULT 1 | AccountType PLAYER=1/SYSTEM=2；AssetType COIN=1/CNY_BALANCE=2；Currency COI/CNY；CHECK frozen<=GREATEST(amount,0) |
| `asset_operation`（0004，不可变） | `AssetOperationModel` | operation_key VARCHAR(160) U; operation_type SMALLINT UNSIGNED; request_hash BINARY(32); initiated_by_user_id NULL; operated_by_admin_user_id NULL; approved_by_admin_user_id NULL; admin_session_key CHAR(36) NULL; reverses_asset_operation_id NULL; reason VARCHAR(500) NULL; extra JSON NULL; result_snapshot JSON NULL; committed_at NULL | OperationStatus POSTED=1；AssetOperationType TRANSFER=1/COIN_EXCHANGE=2/GIFT_GRANT=3/GAME_SETTLEMENT=4/ORDER_FULFILLMENT=5/WITHDRAWAL_HOLD=6/WITHDRAWAL_SETTLEMENT=7/WITHDRAWAL_RELEASE=8/ADMIN_ADJUSTMENT=9/COMPENSATION=10/REFERRAL_REWARD=11/COIN_MARKET_HOLD=12/COIN_MARKET_TRADE=13/COIN_MARKET_RELEASE=14 |
| `asset_entry`（0006，不可变） | `AssetEntryModel` | asset_operation_id FK; asset_account_id FK; asset_hold_id NULL; entry_seq INT UNSIGNED; entry_type SMALLINT UNSIGNED; delta BIGINT; frozen_delta BIGINT DEFAULT 0; amount_after BIGINT; frozen_after BIGINT; account_version BIGINT UNSIGNED; memo VARCHAR(500) | EntryType INTERNAL=1/EXTERNAL=2/HOLD=3/COMPENSATION=4；U(asset_operation_id,entry_seq)；U(asset_account_id,account_version) |
| `asset_hold`（0005） | `AssetHoldModel` | asset_account_id FK; asset_operation_id FK; hold_key VARCHAR(160) U; hold_type SMALLINT UNSIGNED; amount BIGINT; remaining_amount BIGINT; expires_at NULL; closed_at NULL | HoldStatus OPEN=1/PARTIAL=2/CONSUMED=3/RELEASED=4；HoldType GAME=1/WITHDRAWAL=2/REWARD=3/CHANNEL_UNSETTLED=4/COIN_MARKET_LISTING=5；CHECK 0<=remaining<=amount AND amount>0 |
| `coin_exchange` | `CoinExchangeModel`（不可变） | user_id FK; asset_operation_id FK U; coins BIGINT; cash_cents BIGINT; fee_cents BIGINT DEFAULT 0; rate_coin_units BIGINT; rate_cash_cents BIGINT; rounding_type SMALLINT UNSIGNED DEFAULT 2; preview_key CHAR(36) U | RoundingMode CEIL_CHARGE=1/FLOOR_CREDIT=2；U(preview_key) |
| `gift_grant` | `GiftGrantModel`（不可变） | user_id FK; asset_operation_id FK U; order_id NULL; grant_key VARCHAR(160) U; coins BIGINT; turnover_multiplier DECIMAL(12,4) DEFAULT 5; required_turnover_coins BIGINT | U(asset_operation_id)；U(grant_key) |
| `turnover_state` | `TurnoverStateModel` | user_id FK U; remaining_coins BIGINT DEFAULT 0; version BIGINT UNSIGNED DEFAULT 1 | TurnoverStatus ACTIVE=1/COMPLETE=2/REVERSED=3 |

### A.4 payments + chain（0010/0011）

**Model 文件：`models/payments.ts`** 与 **`models/chain.ts`**

| 表 | Model 类 | 关键字段（类型） | 常量/约束 |
| --- | --- | --- | --- |
| `payment_provider` | `PaymentProviderModel` | provider_code VARCHAR(64) U; provider_type SMALLINT UNSIGNED; name; adapter_key VARCHAR(64); secret_reference VARCHAR(255) NULL; capability_snapshot JSON | PaymentProviderType AGGREGATOR=1/SELF_TRON=2/MOCK=3 |
| `payment_channel` | `PaymentChannelModel` | payment_provider_id FK U(payment_provider_id,channel_code); channel_code VARCHAR(64); method_type SMALLINT UNSIGNED; channel_config JSON; fee_config JSON; priority INT DEFAULT 0 | MethodType ALIPAY=1/WECHAT=2/BANK=3/UNIONPAY_QR=4/ECNY=5/USDT_TRON=6 |
| `product` | `ProductModel` | product_code VARCHAR(64) U(product_code,version); product_type SMALLINT UNSIGNED; version BIGINT UNSIGNED; name; price_amount DECIMAL(36,12); price_currency VARCHAR(16); fulfillment_spec JSON; active_marker GENERATED U(product_code,active_marker) | ProductStatus DRAFT=1/ON_SALE=2/OFF_SALE=3/RETIRED=4；ProductType COIN_TOP_UP=1 |
| `order`（保留字，反引号） | `OrderModel` | user_id FK; product_id FK; payment_channel_id FK; order_key CHAR(36) U; provider_order_key VARCHAR(160) U(payment_channel_id,provider_order_key); payment_currency VARCHAR(16); requested_amount DECIMAL(36,12); actual_amount DECIMAL(36,12) NULL; actual_cny_cents BIGINT NULL; extra JSON; asset_operation_id FK NULL U; expires_at; paid_at NULL; fulfilled_at NULL | OrderStatus CREATED=1/PAYING=2/PAID=3/FULFILLED=4/EXPIRED=5/EXCEPTION=6/CANCELLED=7 |
| `payment_event`（不可变） | `PaymentEventModel` | payment_provider_id FK; order_id NULL; payout_attempt_id NULL; coin_market_trade_id NULL; event_key VARCHAR(160); event_type SMALLINT UNSIGNED; verification_result SMALLINT UNSIGNED; payload_hash BINARY(32); payload_ciphertext MEDIUMBLOB; occurred_at; received_at | RecordStatus RECORDED=1；EventType CALLBACK=1/QUERY=2/RECONCILIATION=3；Verification VERIFIED=1/REJECTED=2；U(payment_provider_id,event_key)；CHECK 三目标恰一非空 |
| `external_settlement` | `ExternalSettlementModel` | payment_provider_id NULL; order_id NULL; payout_attempt_id NULL; coin_market_trade_id NULL; related_external_settlement_id NULL; asset_operation_id NULL; settlement_key VARCHAR(160) U; external_transaction_key VARCHAR(160); flow_type SMALLINT UNSIGNED; original_currency VARCHAR(16); original_amount DECIMAL(36,12); gross_cny_cents BIGINT; fee_cny_cents BIGINT DEFAULT 0; net_cny_cents BIGINT; valuation_snapshot JSON; settled_at NULL | ExternalStatus OPEN=1/RECONCILED=2/DISPUTED=3/REVERSED=4；ExternalFlowType IN=1/OUT=2/FEE_ADJUSTMENT=3/FUNDING=4；CHECK net=gross-fee |
| `payout_account` | `PayoutAccountModel` | user_id FK; account_key CHAR(36) U(account_key,version); version BIGINT UNSIGNED; method_type SMALLINT UNSIGNED; account_ciphertext VARBINARY(8192); lookup_hash BINARY(32) U; masked_label VARCHAR(128) | ActiveStatus |
| `withdrawal` | `WithdrawalModel` | user_id FK; payout_account_id FK; asset_operation_id FK U; asset_hold_id FK U; withdrawal_key CHAR(36) U; cash_cents BIGINT; fee_cents BIGINT DEFAULT 0; coin_equivalent DECIMAL(38,12); minimum_coins BIGINT; policy_snapshot JSON; payout_not_before_at; approval_key CHAR(36) NULL U; approved_at NULL; completed_at NULL; failure_reason VARCHAR(500) NULL | WithdrawalStatus REQUESTED=1/REVIEWING=2/APPROVED=3/PAYING=4/SUCCEEDED=5/REJECTED=6/CANCELLED=7/UNKNOWN=8/FAILED=9 |
| `payout_attempt` | `PayoutAttemptModel` | withdrawal_id FK U(withdrawal_id,attempt_no); payment_channel_id NULL; attempt_no INT UNSIGNED; payout_key VARCHAR(160) U; provider_payout_key VARCHAR(160) NULL; request_hash BINARY(32); requested_at NULL; resolved_at NULL; active_marker GENERATED | PayoutStatus PREPARED=1/SENDING=2/UNKNOWN=3/SUCCEEDED=4/FAILED=5；U(withdrawal_id,active_marker) |
| `chain_address` | `ChainAddressModel` | user_id FK; order_id FK U; chain_code VARCHAR(32); address VARCHAR(128) U(chain_code,address); signer_reference VARCHAR(255) NULL; assigned_at | ActiveStatus |
| `chain_deposit_event` | `ChainDepositEventModel` | chain_address_id FK; order_id NULL; chain_code; tx_hash VARCHAR(128); event_index INT UNSIGNED; contract_address VARCHAR(128); sender_address VARCHAR(128); amount_atomic DECIMAL(36,0); token_decimals SMALLINT UNSIGNED; block_height BIGINT UNSIGNED; block_hash VARCHAR(128); confirmed_at NULL; confirmation_snapshot JSON NULL | ChainDepositStatus SEEN=1/CONFIRMING=2/CONFIRMED=3/MATCHED=4/UNMATCHED=5/FAILED=6/REORGED=7；U(chain_code,tx_hash,event_index) |
| `chain_scan_cursor` | `ChainScanCursorModel` | chain_code VARCHAR(32); scanner_key VARCHAR(64); last_finalized_height BIGINT UNSIGNED DEFAULT 0; last_block_hash VARCHAR(128) NULL; owner_key VARCHAR(128) NULL; fencing_token BIGINT UNSIGNED DEFAULT 0; lease_until NULL | ActiveStatus；U(chain_code,scanner_key) |

### A.5 referral（0012）

**Model 文件：`models/referral.ts`**

| 表 | Model 类 | 关键字段（类型） | 常量/约束 |
| --- | --- | --- | --- |
| `referral_binding` | `ReferralBindingModel` | user_id FK U; parent_1_user_id FK 非空; parent_2/3/4_user_id NULL; parent_1..4_benefit_cents BIGINT UNSIGNED DEFAULT 0; bound_at; binding_source SMALLINT UNSIGNED | ActiveStatus；BindingSource IP_ATTRIBUTION=1/INVITE_CODE=2/ADMIN=3；CHECK 链连续（parent_2 非空 ⇒ parent_1 非空，依此类推）；4 个覆盖索引 (parent_n_user_id,parent_n_benefit_cents,user_id) |
| `referral_binding_event`（不可变） | `ReferralBindingEventModel` | user_id FK; previous_parent_1_user_id NULL; new_parent_1_user_id FK; admin_user_id NULL; binding_key VARCHAR(160) U; request_key VARCHAR(160); source_type SMALLINT UNSIGNED; invite_code_used VARCHAR(32) NULL; ip_lookup_hash BINARY(32) NULL; attribution_version VARCHAR(64) NULL; relation_snapshot JSON; reason VARCHAR(500) | RecordStatus RECORDED=1；U(binding_key) |
| `referral_reward_allocation`（不可变） | `ReferralRewardAllocationModel` | user_id FK（领取上级）; ancestry_snapshot JSON; order_id FK; asset_operation_id FK; asset_hold_id NULL U; reward_type SMALLINT UNSIGNED; ancestor_depth SMALLINT UNSIGNED (1~4); rate_bps INT UNSIGNED; basis_subcents DECIMAL(38,12); exact_reward_subcents DECIMAL(38,12); reward_cents BIGINT; rounding_snapshot JSON; unlock_at NULL; skip_reason VARCHAR(255) NULL | RewardStatus POSTED=1/SKIPPED=2；U(order_id,user_id)；U(asset_hold_id) |

### A.6 social（0014，9 表）

**Model 文件：`models/social.ts`**

| 表 | Model 类 | 关键字段（类型） | 常量/约束 |
| --- | --- | --- | --- |
| `social_topic` | `SocialTopicModel` | agent_domain_id NULL; topic_key VARCHAR(64) U(COALESCE(agent_domain_id,0),topic_key); name; description VARCHAR(1000) NULL; cover_asset_id NULL; sort_order INT DEFAULT 0 | ActiveStatus |
| `social_post` | `SocialPostModel` | agent_domain_id NULL; social_topic_id FK; user_id FK; post_key VARCHAR(160) U; title VARCHAR(160) NULL; body_text MEDIUMTEXT NULL; asset_ids JSON（ID 数组，写时校验归属/READY/图片 MIME）; pinned_until NULL; pinned_by_user_id NULL; moderated_by_user_id/moderated_at/moderation_note NULL | SocialPostStatus PENDING_REVIEW=1/PUBLISHED=2/HIDDEN=3/REDACTED=4；U(post_key)；status=4 清正文 |
| `social_post_reply` | `SocialPostReplyModel` | social_post_id FK; parent_social_post_reply_id NULL; user_id FK; reply_key VARCHAR(160) U; body_text TEXT NULL; moderated_* 同上 | SocialPostReplyStatus PENDING_REVIEW=1/PUBLISHED=2/HIDDEN=3/REDACTED=4；最多一层嵌套 |
| `social_friendship` | `SocialFriendshipModel` | agent_domain_id NULL; low_user_id/high_user_id FK U(low_user_id,high_user_id); requester_user_id; responded_at NULL; ended_at NULL | SocialFriendshipStatus PENDING=1/ACCEPTED=2/REJECTED=3/REMOVED=4；CHECK low<high，requester ∈ pair |
| `social_conversation` | `SocialConversationModel` | agent_domain_id NULL; low_user_id/high_user_id FK U(low_user_id,high_user_id); last_message_no BIGINT UNSIGNED DEFAULT 0; user_low_read_through_no / user_high_read_through_no BIGINT UNSIGNED DEFAULT 0; last_message_at NULL; pending_first_message_user_id NULL; open_messaging_day DATE NULL | SocialConversationStatus ACTIVE=1/READ_ONLY=2/CLOSED=3；游标单调递增且 ≤ 高水位 |
| `social_message` | `SocialMessageModel` | social_conversation_id FK; message_no BIGINT UNSIGNED; sender_user_id FK; client_message_id VARCHAR(160); message_type SMALLINT UNSIGNED; body_text TEXT NULL; asset_id NULL; redacted_by_user_id NULL; redacted_at NULL | SocialMessageStatus SENT=1/REDACTED=2；MessageType TEXT=1/IMAGE=2；U(social_conversation_id,message_no)；U(sender_user_id,client_message_id) |
| `social_content_interaction` | `SocialContentInteractionModel` | user_id FK; target_type SMALLINT UNSIGNED; target_id BIGINT UNSIGNED; interaction_type SMALLINT UNSIGNED | SocialContentInteractionStatus；U(user_id,target_type,target_id,interaction_type) |
| `social_block` | `SocialBlockModel` | agent_domain_id NULL; user_id FK; blocked_user_id FK | SocialBlockStatus；U(user_id,blocked_user_id) |
| `social_report` | `SocialReportModel` | reporter_user_id FK; target_type SMALLINT UNSIGNED; target_id BIGINT UNSIGNED; report_reason SMALLINT UNSIGNED; report_note VARCHAR(500) NULL; handled_by_user_id NULL; handled_at NULL | SocialReportStatus PENDING=1/RESOLVED=2/DISMISSED=3；处理留痕不复制正文 |

> 社交 `status` 枚举中 0 均不出现；`last_message_no`/游标是普通计数（允许 0），不属于业务常量。

### A.7 support（0015）

**Model 文件：`models/support.ts`**（DTO 契约见 `packages/contracts/src/support.ts`）

| 表 | Model 类 | 关键字段（类型） | 常量/约束 |
| --- | --- | --- | --- |
| `support_conversation` | `SupportConversationModel` | user_id FK; assigned_admin_user_id NULL; category_type SMALLINT UNSIGNED; subject VARCHAR(160); order_id NULL; withdrawal_id NULL; last_message_at NULL; user_unread_count INT UNSIGNED DEFAULT 0; support_unread_count INT UNSIGNED DEFAULT 0; closed_at NULL | SupportConversationStatus WAITING_SUPPORT=1/WAITING_USER=2/CLOSED=3；CategoryType ACCOUNT=1/PAYMENT=2/WITHDRAWAL=3/GAME=4/OTHER=5 |
| `support_message` | `SupportMessageModel` | support_conversation_id FK; message_key CHAR(36) U; sender_user_id NULL; sender_type SMALLINT UNSIGNED; message_type SMALLINT UNSIGNED; body_text TEXT NULL; asset_id NULL; redacted_by_user_id NULL; redacted_at NULL | SupportMessageStatus VISIBLE=1/REDACTED=2；SenderType CUSTOMER=1/ADMIN=2/SYSTEM=3；MessageType TEXT=1/IMAGE=2/ATTACHMENT=3/SYSTEM_NOTICE=4；CHECK SYSTEM⇒sender_user_id NULL，CUSTOMER/ADMIN⇒非空 |

### A.8 admin（0009）

**Model 文件：`models/admin.ts`**

| 表 | Model 类 | 关键字段（类型） | 常量/约束 |
| --- | --- | --- | --- |
| `agent_domain` | `AgentDomainModel` | user_id FK U; capabilities JSON DEFAULT []; approved_at/suspended_at/revoked_at NULL | AgentDomainStatus PENDING_REVIEW=1/ACTIVE=2/SUSPENDED=3/REVOKED=4/WITHDRAWN=5；审批同事务置 user.role_type AGENT 位 |
| `admin_permission` | `AdminPermissionModel` | permission_code VARCHAR(128) U; name VARCHAR(100); http_method VARCHAR(12); path_pattern VARCHAR(255) | ActiveStatus；U(http_method,path_pattern) |
| `admin_audit_event`（不可变） | `AdminAuditEventModel` | admin_user_id FK; admin_session_key CHAR(36) NULL; user_id NULL; target_admin_user_id NULL; asset_operation_id/withdrawal_id/system_config_id/game_config_id/agent_domain_id/referral_binding_event_id/support_conversation_id/coin_market_trade_id 各 NULL; request_key VARCHAR(160); action_code VARCHAR(128); result_type SMALLINT UNSIGNED; reason VARCHAR(500); snapshot JSON; ip_hash BINARY(32) | RecordStatus RECORDED=1；ResultType SUCCESS=1/DENIED=2/FAILED=3；CHECK(system_config_id IS NULL OR game_config_id IS NULL) |
| `agent_audit_event`（不可变） | `AgentAuditEventModel` | agent_domain_id FK; user_id FK; action_code VARCHAR(128); resource_type VARCHAR(64); resource_key VARCHAR(160); purpose VARCHAR(255); request_key VARCHAR(160) U; result_type SMALLINT UNSIGNED; snapshot JSON; ip_hash BINARY(32) | RecordStatus RECORDED=1；U(request_key) |

### A.9 ai-assets / 文件资产（0017）

**Model 文件：`models/assets.ts`**

| 表 | Model 类 | 关键字段（类型） | 常量/约束 |
| --- | --- | --- | --- |
| `asset` | `AssetModel` | asset_type SMALLINT UNSIGNED; storage_provider SMALLINT UNSIGNED; bucket_name VARCHAR(128); object_key VARCHAR(512); content_hash BINARY(32); mime_type VARCHAR(128); byte_size BIGINT UNSIGNED; width/height INT UNSIGNED NULL; duration_ms BIGINT UNSIGNED NULL; codec VARCHAR(64) NULL; visibility SMALLINT UNSIGNED; storage_metadata JSON NULL | AssetStatus STORED=1/READY=2/QUARANTINED=3/RETIRED=4；AssetType IMAGE=1/ANIMATED_IMAGE=2/VIDEO=3/ATLAS=4/MANIFEST=5/BINARY=6；StorageProvider S3_COMPATIBLE=1/LOCAL_DEV=2；Visibility PRIVATE=1/PUBLIC=2；U(storage_provider,bucket_name,object_key)；U(content_hash,byte_size) |
| `asset_release` | `AssetReleaseModel` | release_key VARCHAR(128) U; release_type SMALLINT UNSIGNED; manifest_hash BINARY(32); published_at NULL | ReleaseStatus DRAFT=1/REVIEW=2/PUBLISHED=3/RETIRED=4 |
| `asset_release_item` | `AssetReleaseItemModel` | asset_release_id FK; asset_id FK; item_type SMALLINT UNSIGNED; order_no INT UNSIGNED | RecordStatus；U(asset_release_id,asset_id) |
| `ai_asset_job` | `AiAssetJobModel` | job_key CHAR(36) U; asset_key VARCHAR(128); asset_kind SMALLINT UNSIGNED; provider_code VARCHAR(32); main_model_code/image_model_code VARCHAR(128); api_mode SMALLINT UNSIGNED; prompt MEDIUMTEXT; prompt_hash BINARY(32); style_version VARCHAR(64); generation_config JSON; provider_request_key VARCHAR(160) NULL; usage_snapshot JSON NULL; cost_micro_usd BIGINT NULL; attempts INT UNSIGNED DEFAULT 0; completed_at NULL | AiJobStatus QUEUED=1/RUNNING=2/SUCCEEDED=3/FAILED=4/CANCELLED=5/REVIEW_REQUIRED=6；ApiMode RESPONSES_IMAGE_TOOL=1/IMAGES=2；AssetKind BACKGROUND=1/CHARACTER=2/CARD=3/ICON=4/EFFECT=5 |
| `ai_asset_artifact` | `AiAssetArtifactModel` | ai_asset_job_id FK; asset_id FK U; artifact_type SMALLINT UNSIGNED; license_snapshot JSON; review_note VARCHAR(1000) NULL | ArtifactStatus GENERATED=1/APPROVED=2/REJECTED=3；ArtifactType ORIGINAL=1/WEBP=2/AVIF=3/ATLAS=4/METADATA=5 |
| `ai_asset_reference`（不可变） | `AiAssetReferenceModel` | ai_asset_job_id FK; asset_id FK; reference_role SMALLINT UNSIGNED; sort_order INT UNSIGNED DEFAULT 0 | RecordStatus RECORDED=1；ReferenceRole STYLE=1/CHARACTER=2/EDIT_TARGET=3；U(ai_asset_job_id,asset_id,reference_role) |

### A.10 platform-events / outbox（0018）与迁移历史

**Model 文件：`models/events.ts`**（`GameEventInstanceModel` 若与 game 模块共用可放 `models/game.ts`，本处登记归属 platform-events）

| 表 | Model 类 | 关键字段（类型） | 常量/约束 |
| --- | --- | --- | --- |
| `outbox` | `OutboxModel` | event_key VARCHAR(160) U; topic VARCHAR(128); user_id NULL; asset_operation_id NULL; round_id NULL; payload JSON; payload_version INT UNSIGNED DEFAULT 1; available_at; attempts INT UNSIGNED DEFAULT 0; locked_by VARCHAR(128) NULL; lease_until NULL; sent_at NULL; last_error_code VARCHAR(64) NULL | OutboxStatus PENDING=1/PROCESSING=2/SENT=3/DEAD=4；U(event_key)；I(status,available_at,id)；I(lease_until,id) |
| `migration_history`（0001 已有） | `MigrationHistoryModel` | name VARCHAR(255); checksum CHAR(64); action_type SMALLINT UNSIGNED; execution_no BIGINT UNSIGNED; started_at; finished_at NULL; executor_key VARCHAR(128); error_code VARCHAR(64) NULL；U(name,execution_no) | MigrationStatus RUNNING=1/SUCCEEDED=2/FAILED=3；Umzug 自定义存储（已实现于 `apps/server`，迁入 backend 后原样保留，DDL 不再动） |

### A.11 coin-market（0016）

**Model 文件：`models/coin-market.ts`**

| 表 | Model 类 | 关键字段（类型） | 常量/约束 |
| --- | --- | --- | --- |
| `coin_market_listing` | `CoinMarketListingModel` | seller_user_id FK; listing_key VARCHAR(160) U; asset_hold_id FK U; listed_coins BIGINT; available_coins BIGINT; reserved_coins/filled_coins/cancelled_coins BIGINT DEFAULT 0; price_cents_per_1000_coins BIGINT UNSIGNED; receive_method SMALLINT UNSIGNED; receive_snapshot JSON NULL; platform_payment_opt_in TINYINT UNSIGNED DEFAULT 0（布尔）; cancelled_at NULL; suspended_by_user_id NULL | CoinMarketListingStatus ACTIVE=1/PAUSED=2/COMPLETED=3/CANCELLED=4/SUSPENDED=5；CHECK listed=available+reserved+filled+cancelled 且各非负、listed>0 |
| `coin_market_trade` | `CoinMarketTradeModel` | coin_market_listing_id FK; buyer_user_id FK; trade_key VARCHAR(160) U; coins BIGINT; gross_cents BIGINT; payment_mode SMALLINT UNSIGNED; payment_channel_id NULL; fee_rate_bps INT UNSIGNED DEFAULT 0; fee_cents BIGINT DEFAULT 0; seller_net_cents BIGINT DEFAULT 0; payment_proof_asset_id NULL; chain_tx_id VARCHAR(160) NULL U; usdt_rate_snapshot DECIMAL(20,8) NULL; payment_deadline_at; seller_response/buyer_evidence/seller_evidence/platform_decision 各 deadline_at + asset_id + submitted_at; seller_dispute_note VARCHAR(1000) NULL; paid_at NULL; support_conversation_id NULL; adjudicated_by_user_id NULL; resolution_code SMALLINT UNSIGNED NULL; resolution_note VARCHAR(1000) NULL; adjudicated_at NULL; asset_operation_id NULL U | CoinMarketTradeStatus PAYMENT_PENDING=1/SELLER_CONFIRMATION_PENDING=2/DISPUTED=3/BUYER_EVIDENCE_PENDING=4/SELLER_EVIDENCE_PENDING=5/PLATFORM_REVIEW=6/RELEASED=7/AUTO_RELEASED=8/PAYMENT_EXPIRED=9/RESOLVED_RETURN=10/CANCELLED=11；PaymentMode DIRECT=1/PLATFORM_CHANNEL=2/USDT=3；ResolutionCode RELEASE_TO_BUYER=1/RETURN_TO_SELLER=2；U(trade_key)；U(chain_tx_id)；U(asset_operation_id) |

### A.12 模型注册与装配约定

1. **注册中心**：`packages/backend/src/infrastructure/database/models/index.ts` 导出 `allModels` 数组，`sequelize.addModels(allModels)` 统一注册；各 Model 文件只做 `define`，不自行绑 instance（避免循环依赖）。
2. **关联声明**：Sequelize `belongsTo/hasOne/hasMany` 只在**读模型查询**需要 join 的模块内声明，`foreignKey` 显式指定、`constraints: false`（外键约束以 DDL 为准，避免 ORM 自动补列/补索引，见[Sequelize 方案 §2](../05_data/数据库设计规范与Sequelize方案.md)）。资金/审计引用列 DDL 建 `RESTRICT` 外键。
3. **常量单一来源**：本附录列出的全部 status/type 常量在 `packages/contracts`（玩家可见部分）与 `packages/admin-contracts`（Admin 部分）以 `as const` 对象 + 数值断言导出，**Model 文件引用 contracts 常量而非本地再定义**；数据库设计 SDD §3 的枚举草案是权威，发现数值冲突先改 SDD 再改代码。
4. **row-mapper 归属**：每个 Model 文件的同目录 `*-row-mapper.ts` 负责 Model ↔ DTO（十进制字符串化、`DataTypes.JSON` 解析、BINARY(32) 摘要的 hex 化），禁止在 controller/socket handler 里直接读 Model 实例字段出 wire。
5. **不可变表钩子**：`asset_operation`/`asset_entry`/`*_event`/`outbox` 等 Model 用 `hooks.afterUpdate` 抛错 + `paranoid: false` + 关闭 `updated_at` 自动写，保证 append-only（与 0004 迁移 DDL 的"不可更新删除"一致）。
6. **生成列只读**：`system_marker`/`active_marker` 在 Model 里 `field` 映射到原生 STORED 列、`defaultValue` 不设、create/update 时忽略入参（由 DDL 表达式计算），唯一索引在 DDL 层生效。
7. **保留字**：`OrderModel.tableName = 'order'`，所有 raw SQL 与 Sequelize 查询对该表加反引号；`user` 表同理。
8. **迁移顺序依赖**：FK 目标表必须先迁移（如 `user.asset_id → asset` 在 0017 建 `asset` 表后补 `ADD CONSTRAINT`；`0002` 已按"只建列不建外键"处理）。批次内表序 = 被引用表在前。

### A.13 与数据库设计 SDD 的对照校验清单（写迁移前逐表过）

- [ ] 每张表 DDL 字段/类型/可空/默认值与数据库设计 SDD §5 逐表一致（本附录 A.1~A.11 为中间映射，发现不一致以数据库设计 SDD 为准并先修订本附录）。
- [ ] 全表公共 5 字段齐全（`migration_history` 按 0001 既有写法例外：无 `status/deleted_at` 业务语义，保持现状不改旧迁移；Model 按 A.10 登记，DDL 不动）。
- [ ] 状态列默认值为非零常量；所有 CHECK 约束逐条落到 DDL。
- [ ] generated 列表达式与 SDD 给出的 `CASE WHEN` 完全一致（`user.system_marker`、`recovery_credential.active_marker`、`product.active_marker`、`game_entry.active_marker`、`room_membership.active_marker`、`payout_attempt.active_marker`）。
- [ ] 唯一索引含 `COALESCE(...,0)` 归一的（`game_config`、`social_topic`）在 DDL 用函数索引或生成列等价实现，MySQL 9 直接支持表达式索引。
- [ ] 不可变表（asset_operation/asset_entry、referral_binding_event、round_event、agent_audit_event/admin_audit_event、user_security_event、payment_event、ai_asset_reference、coin_exchange、gift_grant）确认 `updated_at=created_at`、无软删。`outbox` **不是**不可变表：其行 append-only（不删不改），但 `status` 有 OutboxStatus PENDING=1/PROCESSING=2/SENT=3/DEAD=4 状态机，`updated_at` 随投递正常更新、仅 `deleted_at` 恒 NULL（A.10 登记口径以此为准，§2 第 3 条"不可变表"清单的 outbox 为笔误，2026-11-03 校准）。
- [ ] `order`/`user` 保留字反引号全覆盖（Sequelize `table` 选项 + raw query）。
- [ ] 资金 FK（`asset_operation`/`asset_entry`/`withdrawal.asset_operation_id`/`settlement.asset_operation_id`/`coin_market_trade.asset_operation_id`）DDL `ON DELETE RESTRICT`。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-08 | Support claim/resolve 增加 fail-closed capability 检查：Admin module 以精确 POST method/path 查询 active `admin_permission`，再读取当前 user role/status/permissions 授权；两条路由在 mutation transaction 内检查 `admin.support.claim` 与 `admin.support.resolve`，未获授权不执行 command。其他 Admin routes 的通用 endpoint registry/permission middleware 仍未完成。 |
| 2026-11-08 | rooms 增加内部恢复 worker 权属 claim primitive：以 caller transaction 按 room→round 锁顺序，限 ACTIVE round，校验旧 room/round token 一致后将 room/round 状态与 fencing_token 通过条件 CAS 同步转为 RECOVERING/newToken；CAS 影响行数不是 1 即 FENCING_CONFLICT。它不执行 handler replay、解密、timeout 或 settlement，worker 调度与运行时恢复验收仍未实现。 |
| 2026-11-06 | 房间开局 stake 端点改为仅接收 waterUnits；建房路由在事务内读取 game_config 档位 stake JSON 并冻结到 room rules snapshot，开局 use-case 服务端派生 wager/max-loss 并固化于 round。真实牌局接线仍受公平发牌/私有手牌及用户端契约阻塞。 |
| 2026-11-05 | CoinMarket hold 生命周期复核：PAYMENT_EXPIRED 与 buyer cancellation 状态推进前均核验卖家 canonical coin account、账户锁及 listing hold 的账户/类型/剩余量，避免库存状态释放但资金 hold 已损坏；增加对应生命周期测试断言。容器内 backend 定向测试 13/13、backend/server typecheck 通过。独立 MySQL fixture 初始化尚未解决，SKIP LOCKED 并发验证缺失，expiry worker 继续保持未注册。 |
| 2026-11-04 | CoinMarket asset_hold lifecycle 续作：钱包账本新增共享 hold 部分/全额释放、消费原语（entry 绑定 asset_hold_id，hold 剩余量/状态与不可变分录同事务），要求 operation claim 与已提交 snapshot；挂单创建使用 canonical asset_account.id、真实 operation 与 COIN_MARKET_HOLD 分录，挂单取消只释放 available 对应 hold；成交取消/48h 付款超时仅将 reserved 退回 available（或 inactive 挂单转 cancelled），不改变整笔挂牌 hold，避免把可再次出售金币解冻。最终买家放币消费 hold 并仅在该结算路径推进 listing reserved→filled；卖家确认收款仅改状态，不结算金币。新增活动事务门禁与 fake 生命周期测试；本轮进一步在成交取消/过期状态推进前验证卖家 canonical 账户、账户行锁与 listing hold 类型/归属/剩余量，状态重放校验已有 operation snapshot，hold 不匹配时事务失败关闭。付款凭证仍须私有加密 Asset 权限服务，seller-response/appeal/裁决资金流及隔离 MySQL rollback/concurrency/SKIP LOCKED 验证未实现，因此 expiry worker 保持 fail closed。Docker 定向测试 13/13；backend/server typecheck 通过。 |
| 2026-11-04 | §6.3 Socket 通知携带持久化 outbox `event_key`（字段 `eventKey`），供客户端对至少一次投递去重；保持 `source: outbox` 标记，明确不代表客户端 ACK。dispatcher 与实际 Socket emit 回归断言通过。outbox 15/15、server typecheck/root lint 通过。 |
| 2026-11-04 | §6.3 Socket adapter 清理断连连接：notifyUser 跳过并从 user connection Set 删除竞态遗留的 `connected=false` socket，空集合时删除 user map 项；离线用户仍按断线补拉语义成功。新增 3 个端口回归测试；outbox tests 15/15、server typecheck/root lint 通过。此举不增加 Socket 客户端 ACK 确认语义。 |
| 2026-11-04 | §6.3 移除未使用财务 task 占位工厂：outbox-task-handlers 不再导出会只记日志却返回成功的 payout / expiry / referral handler；未来需在完整幂等领域事务与账本测试齐备后重新实现，现继续由 dispatcher fail closed。outbox tests 12/12、typecheck/root lint 通过。 |
| 2026-11-04 | §6.3 未知 topic fail-closed：dispatcher 仅接受显式登记的 16 个 Socket 提示 topic 或已注册 task；所有其他 topic 记录 UNKNOWN_TOPIC 并返回失败重试，不再走默认 Socket 路径误标 SENT。核对 backend producer 当前发出的 16 个唯一 topic 均已分类；新增未知 topic 回归测试，outbox tests 12/12。 |
| 2026-11-04 | §6.3 任务 handler 错误日志收敛：异常不再记录原始 message，统一记录 TASK_HANDLER_FAILED 并退避重试；修订 dispatcher 过期注释，明确 task topic 缺 handler fail closed。新增敏感内容不泄露测试，outbox tests 11/11。 |
| 2026-11-04 | §6.3 outbox retry backoff：将指数上限从 attempt exponent 6 修正为 7，使 1s doubling 序列可达 120s cap（此前最高仅 64s）；新增边界测试覆盖负值、attempt 6/7 及超大值。outbox tests 10/10。 |
| 2026-11-04 | §6.3 Socket 通知逐行错误隔离：SocketNotifPort 单条 notifyUser 失败转 false + DELIVERY_FAILED 重试，不再中断本批后续事件；日志只记 SOCKET_DELIVERY_FAILED，避免异常 message 泄漏。新增 dispatcher 回归测试。 |
| 2026-11-04 | §6.3 worker graceful shutdown：stop() 清除 ticker 后等待正在执行的批次完成，确保 Server 关闭 Socket/DB 前已结算当前 outbox 行；新增 fake-timer shutdown 测试。outbox tests 8/8、server typecheck/lint/format/build 通过。 |
| 2026-11-04 | §6.3 worker 单行异常隔离：逐 outbox row 捕获 dispatch/DB settle 异常，固定 errorCode 记录，继续处理同批后续行；失败结算行由 lease reclaim 恢复。新增 first-row settle failure / second-row success 测试，outbox tests 9/9 通过。 |
| 2026-11-04 | §6.3 outbox worker 租约 fencing：markSent/markFailed 结算增加 lockedBy + leaseUntil 精确匹配，迟到的旧 worker 无法修改新租约；失败重试时立即释放旧租约，仅由 available_at 执行退避，不再无谓占用 30s lease；结算返回 affected 布尔值，worker 只统计实际落库结果。新增仓储单测验证 fencing、backoff 和 stale settlement。server typecheck、6 个 outbox tests 通过。 |
| 2026-11-04 | §6.3 payout worker 审查：withdrawal 创建后处于 REQUESTED，出款必须晚于 payout_not_before_at（72 小时），而 PaymentsModule 当前没有 payout_attempt 建立/锁定端口或渠道提交/结果查询用例。继续移除占位处理器并 fail closed；不得无视 72 小时等待、跳过 payout_attempt 或伪造成功状态。真实 worker 需补 attempt 生命周期、渠道 adapter、超时 UNKNOWN 恢复与成功后的账本/结算记录。 |
| 2026-11-04 | §6.3 outbox 安全修正：发现 payout、expiry-scan、referral reward 三个 task handlers 只记日志不执行业务副作用，已从生产注册表移除；dispatcher 将这三个已知金融 topic 在缺 handler 时 fail closed（markFailed 退避而非误标 SENT 或当 Socket 通知），新增 3 个 dispatcher 单测。真实 payout ledger、trade expiry batch 与 referral 入账仍未闭环，后续必须补完整事务和 operation-key 幂等后再注册；CoinMarket listing hold 目前以 userId 冒充 asset_account.id、assetOperationId='0' 建 hold，COIN_MARKET_HOLD=12 分录未落，须先修复账户定位/操作键/账本事务，再开展 trade-expiry worker。server typecheck/root lint/server build/3 tests 通过。 |
| 2026-11-03 | 新建：后端实施 SDD（实体起步）：62 表 model 注册与迁移批次、模块/用例/端口布局、玩家+Admin HTTP 路由与端点清单、Socket.IO 三命名空间与 outbox 投递管线、Admin（Vue3.5+Element Plus）双轨切换映射、Docker 沿用现有 compose、9 步实施顺序与验收红线。 |
| 2026-11-03 | 校准表数口径：数据库设计 SDD §5 逐表实为 63 张（outbox 后补、开头 62 未更新），本 SDD 按 63 张为准并登记该差异；修 §1/§3.2 链到账子域归属矛盾（payments owns，model 文件独立）与 0008/0017 批次归属（asset/asset_release* 归 ai-assets）。 |
| 2026-11-03 | 新增附录 A（模型与表结构规划）：63 表按 11 个 model 文件给出 Model 类名、业务字段类型、状态/类型常量、索引与 CHECK 约束；A.12 注册/关联/常量单一来源/row-mapper/不可变钩子/生成列/保留字装配约定；A.13 写迁移前逐表对照数据库设计 SDD §5 的校验清单。 |
| 2026-11-03 | 校准 A.13 不可变表清单：outbox 移出不可变表（status 有 PENDING/PROCESSING/SENT/DEAD 状态机，updated_at 随投递更新，仅 deleted_at 恒 NULL）；同步 §2 第 3 条。 |
| 2026-11-03 | 实施第一步落地：`packages/backend` 包脚手架（§1 布局）+ 0007~0018 十二批次 57 张表迁移（§3.1 批次划分，逐表对照数据库设计 SDD §5 与附录 A.13 校验）；`apps/server` 的 0001~0006 迁移基础设施按 §1 迁入 backend，server 仅保留 Sequelize 实例、迁移 CLI 薄壳与 MySQL/Redis 探针；server 迁移 CLI 与 `MIGRATION_TEST` 集成测试委托 backend 全链 0001~0018，容器内 63 张表 up→down→up 实测通过。下一步：§3/附录 A 的 11 个 model 文件注册与 §9 第 1 步 identity 模块。 |
| 2026-11-03 | 实体层落地（§3/附录 A）：`packages/backend/src/infrastructure/database/models/` 13 文件注册全部 63 张表（identity/wallet/payments/chain/referral/social/support/admin/game/events/assets + coin-market，65 表含 0016 两表）；A.12 装配约定全部落实：`index.ts` 中央注册器（`addModels(sequelize)` 按批次顺序 `init*` + `associateAll` 跨文件 FK 全部 `belongsTo` + `constraints: false`）、不可变表 append-only hooks、outbox/coin-market 两表 `paranoid: false` 例外、生成列不进 attributes、保留字 `order`/`user` 反引号、BINARY 经 `binaryDataType` 近似映射（hex 化归 row-mapper）。container lint/format/typecheck 全绿。登记已知差异：contracts `CoinMarketTradeStatus` 为 P0 本地 9 值简化状态机（前端 browser-api 在用），DDL 为服务端权威 11 值——双轨切换前须先对齐 contracts 常量并做 contract test。下一步：§9 第 1 步 identity 模块（auth 6 端点 + Redis 会话 + refresh 轮换 + Socket 握手鉴权基座）。 |
| 2026-11-03 | §9 第 1 步 identity 模块落地：`packages/backend/src/infrastructure/redis/`（ioredis 单例 + Redis 会话权威存储 + Lua 原子 refresh 轮换 + 30s 弱网重放窗口 + 限频）、`infrastructure/jwt/`（jose ES256 签发/验签，固定 claims 清单，PEM env 或 dev 内存密钥）、`modules/identity/`（domain 密码/TOTP/联系方式规则 + ports 8 接口 + adapters sequelize/redis/jose + application 11 用例 + assembly 装配工厂 + public 唯一入口）；`apps/server` 新增 `http/auth.routes.ts`（auth 6 端点 + me/identity 3 端点）与 `infrastructure/auth/player-auth-middleware.ts`（Bearer 验签 + Redis session + auth_version 三重门禁），`main.ts` 装配 identityModule（MySQL/Redis 缺失时降级不挂载 auth 路由）。全量门禁（lint/format/typecheck/test/build）容器内全绿。未闭环登记：TOTP 密文 KMS 未接入（占位封装）、outbox worker 未建（8 topic 已登记）、WelcomeGiftPort 归 wallet 模块（TODO）、refresh 路由层依赖 Cookie 双值（sid + refresh token）。下一步：§9 第 2 步——auth 端点 contract test + Socket.IO 握手鉴权基座。 |
| 2026-11-03 | §6.1 Socket 握手鉴权基座落地：`apps/server/src/socket/socket-auth.ts`（/platform 命名空间，握手 auth.accessToken 三重门禁，连接建立 ≠ 永久授权，session.reauthorize 原地更新认证上下文，disconnectUser 按 user 批量断开）；main.ts 挂载 + 优雅关闭（io → redis → sequelize 顺序）；socket.io ^4.8.1 入 lockfile。全量门禁全绿。未闭环：/admin 与 /room/:roomId 命名空间随 §9 第 4/9 步落地；多实例 Redis pub/sub 广播断开指令登记为后续运维项。§9 第 1 步收口（auth 端点 contract test 随 §9 第 2 步一并补）。 |
| 2026-11-03 | §9 第 2 步钱包闭环落地：`packages/backend/src/modules/wallet/`（16 文件）——domain 错误码/记账不变量 + 8 ports + sequelize-wallet-ledger 适配器（SELECT FOR UPDATE 按 asset_account.id 升序锁、operation_key 唯一约束幂等抢占/重放、postEntries 乐观 version、coin_exchange/gift_grant/turnover_state 快照写入、BigInt 全链路）+ 6 应用用例（wallet-summary 双资产汇总、wallet-activity 游标分页 50/页、transfer 转账 3 账户锁 5% 手续费、exchange 兑换 FLOOR_CROUND + coin_exchange 快照、gift-grant 新用户赠币实现 identity WelcomeGiftPort、turnover 流水门槛判定）+ assembly 装配工厂。`apps/server/src/http/wallet.routes.ts` 6 端点（summary/activity/transfers/quote+submit/exchanges/quote+submit），submitInTx 助手把 sequelize.transaction + module.withTx 同事务传入 outbox（§4 所有分录/outbox 同事务），读用例无事务；SYSTEM_USER_ID env 未设置时降级不挂 wallet 路由。contracts/wallet.ts 新增 type-only Static + Value 重导出桥接（与 identity.ts 同款先例，不动 schema/DTO，单一来源纪律保持）。全量门禁（lint/format/typecheck/build）全绿；test 100/101（1 个 P0 基线遗留 AgentDomainListPage flaky 测试，与 wallet 改动无关）。未闭环登记：systemUserId 无 config 键自动发现（首版 env 注入，payments/referral 步补）、submit 未暴露 inserted/replayed 标志（HTTP 层统一 201，幂等重放语义登记为决策点）、outbox 8 topic worker 未建（随 §6.3 管线）、Admin 资产调整双人复核端点（§9 第 9 步）。 |
| 2026-11-03 | §9 第 3 步支付与提现模块落地：`packages/backend/src/modules/payments/`（15 文件）——domain 订单/支付事件/withdrawal 状态机 9 态转换表 + 订单过期/四匹配纯函数 + 错误码映射（contracts FundingErrorCode + WalletErrorCode 子集）；6 用例（order-create：渠道选择+汇率快照+order_key 幂等，201/200；payment-event：U(provider,event_key) 去重+四匹配+ORDER_FULFILLMENT=5 三分录+external_settlement+outbox，重复回调不重复发币；withdrawal：quote 纯函数+create（turnover 门禁+身份三选一+WITHDRAWAL_HOLD=6 占款三分录+REQUESTED=1+payout_not_before_at=+72h+outbox）；withdrawal-cancel：1/2 态取消+WITHDRAWAL_RELEASE=8 幂等释放；payout-accounts：CRUD+lookup_hash sha256 去重，KMS 未闭环登记；chain-deposit：MockChainScanner 空实现，真实 TRON RPC 扫描未闭环登记）；Adapters：Sequelize 仓储（锁/幂等/状态机校验）；assembly 注入 walletModule（ledger/configReader/turnoverGate 复用，不重建）。`apps/server/src/http/payments.routes.ts` 10 端点（channels/orders CRUD/payout-accounts CRUD/withdrawals quote+create+list+cancel）；app.ts+main.ts 装配，payments 路由在 identity+wallet+sequelize 均就绪时挂载，否则降级不挂。`WalletOperationType` 扩展 +ORDER_FULFILLMENT=5/WITHDRAWAL_HOLD=6/SETTLEMENT=7/RELEASE=8；`WalletEntryType` 扩展 +EXTERNAL=2/HOLD=3/COMPENSATION=4。0019 种子迁移：Mock 提供商（MOCK=3）+ 五个 Mock 渠道（ALIPAY/WECHAT/BANK/UNIONPAY_QR/ECNY）+ COIN_10 商品（1 元=10 金币，ON_SALE=2）。全量门禁 lint/format/typecheck/build 全绿；test 2 failed（AgentDomainListPage P0 基线 flaky + PaymentChannelsPage 本机 IndexedDB ElSelect，均与 payments 改动无关）。未闭环登记：0019 种子迁移未跑 MIGRATION_TEST、payment_event CHAIN_DEPOSIT=4 常量未注册（contracts 无）、出款状态机推进（REVIEWING→APPROVED→PAYING→SUCCEEDED）Admin 审核端点归 §9 第 9 步、出款 worker（payout_attempt）随 §6.3 outbox 管线、真实 TRON RPC 链到账扫描未闭环、KMS 加密 payout_account 敏感字段未闭环。 |
| 2026-11-04 | §9 第 8 步 AI 素材台账模块落地：`packages/backend/src/modules/ai-assets/`（19 文件）——domain 6 态 job 状态机转换表（QUEUED=1→CANCELLED=5 玩家侧；RUNNING/SUCCEEDED/FAILED/REVIEW_REQUIRED 推进经外部网关回调登记 KMS 未闭环）+ 4 态 release 状态机（DRAFT=1→PUBLISHED=3 首版直推，REVIEW=2 审核路径归 §9 第 9 步）+ 错误码表；4 个独立 Sequelize Repo 类（AssetRepo/AiAssetJobRepo/AiAssetArtifactRepo/AssetReleaseRepo，每表一类，实体前缀命名）；7 用例（job-create QUEUED=1 + U(job_key) 幂等重放不实际调外部网关；job-cancel QUEUED=1→CANCELLED=5 幂等；job-list 游标分页 50/页经 assetKey 归属近似筛选（登记 created_by_user_id 0018 迁移补列决策点）；job-detail 含 artifact 列表；release-create DRAFT=1 + U(release_key) 幂等；release-publish DRAFT=1→PUBLISHED=3 幂等重放；release-list 游标分页）；assembly `createAiAssetsModule({sequelize, config})` 不依赖 walletModule（无资金操作）。`apps/server/src/http/ai-assets.routes.ts` 7 端点；app.ts+main.ts 装配（identity+sequelize 均就绪时挂载，无需 wallet）。`packages/backend` 新增 `./modules/ai-assets` exports。lint/format/typecheck/build 全绿。未闭环登记：KMS 密钥注入 + 真实 OpenAI/Kling 网关回调推进 job 状态机（随 §6.3 outbox worker + §9 第 9 步 Admin 审核路径闭环）、job created_by_user_id 列 0018 迁移补列决策点、release REVIEW=2 审核路径归 §9 第 9 步。 |
| 2026-11-04 | §9 第 9 步 Admin 登录链路落地：`POST /admin-api/v1/auth/login` 调 `AdminLoginUseCase`（username/password + user.role_type ADMIN=4 校验；Admin audience `aud='admin'` 经 identity `JwtIssuerPort` 签发；`SessionPort` 写 `principalType='ADMIN'` Redis session + refresh token hash； access token 15 分钟）；路由将 refresh token + sid 置于 `admin_refresh_token` / `admin_sid` HttpOnly/SameSite=Lax cookie（path `/admin-api/v1`），响应 envelope 只含 accessToken/sessionKey/adminUserId/expiresAt/expiresInSecs，不泄露 refresh 明文；deps 未装配 fail-closed。`apps/admin/src/platform/admin-auth.ts` 新增 sessionStorage('admin.accessToken') 会话存取 + 清理；AdminLoginPage.vue 登录表单调用 /admin-api/v1/auth/login，成功入 sessionStorage 并进入 overview，显示错误态/已登录态；`admin-auth.test.ts` 2/2 + `admin-login.test.ts` 3/3 + App login integration 1/1 通过。`identity/public.ts` 重导出 `buildNewSession` 供跨模块遵守 public.ts 边界。门禁：server/backend/admin typecheck + lint + format 全绿；全量测试 102/103，唯一失败为既有 P0 flaky `AgentDomainListPage.test.ts`（演练记录未写入 IndexedDB，非本次改动）；全量 lint/typecheck/build/OpenAPI 已分别运行，`lint:apps` 最初 1 error 已修复为 0 errors/99 warnings。容器内嵌套调用 `pnpm docker:check` 因 dev 镜像无 docker CLI 失败，已直接运行各子门禁；视口验收仍未完成。未闭环登记：Admin refresh cookie 轮换端点/登出撤销接口未实现（access token 过期需重新登录；cookie 目前只为后续 Admin refresh 预留）；Admin TOTP 密文验证依赖 KMS + identity challenge，启用 TOTP 的 Admin 当前不能从此界面登录，非空 totpCode 或已启用 TOTP 的 Admin 均 fail closed；security event 登录失败/成功事件暂未写入；sessionStorage accessToken 按用户明确要求实现（JWT SDD 通用浏览器建议为内存存储，差异待决策/需后续改用内存 token）。 |
| 2026-11-04 | CoinMarket contracts `CoinMarketTradeStatus` 与 DDL 对齐：新增 `RESOLVED_RETURN=10`、`CANCELLED=11`，状态 schema 仍由常量派生；contract test 校验 DDL 1–11 全值及拒绝 0/12。contracts typecheck、契约测试 8/8 通过。 |
| 2026-11-04 | §6.3 outbox worker 投递管线落地：`apps/server/src/infrastructure/outbox/`（6 文件）——ports/outbox-worker-repo.ts（OutboxWorkerRepo 消费侧端口：claim 租约领取 / markSent / markFailed 指数退避 / reclaimStale 过期回收 / findByEventKey 幂等重放校验）+ adapters/sequelize-outbox-worker.ts（Sequelize 实现：FOR UPDATE 行锁 + 租约互斥 + 1s~2min 指数退避 + deadAfter=12 置 DEAD）+ outbox-dispatcher.ts（topic 分发：任务注册表 + Socket 提示映射 16 topic；未注册 topic 经 user_id 推 /platform，user_id=null 公开事件跳过广播登记）+ outbox-task-handlers.ts（曾有 3 个仅占位处理器，不能完成资金/状态副作用；现已从生产 registry 移除）+ outbox-worker.ts（消费循环 ticker 1s + 租约 30s + 单批 50 + 失败退避 + inFlight 防堆叠 + 过期租约每 30 tick 回收）+ outbox-worker-bootstrap.ts（Sequelize+SocketAuth 均就绪时启动；财务 task topics 未装配完整 handler 时 fail closed，经 markFailed 退避至 DEAD，不误路由 Socket 或标 SENT）。main.ts 装配：outboxWorker 经 bootstrapOutboxWorker 创建（shuffle + socketAuth 均就绪时），shutdown 钩子先停 outbox worker 再关 Socket.IO。packages/backend 新增 2 条 models exports（models/payments + models/coin-market）。admin 模块 14 文件 Prettier 格式修正（无逻辑变更）。门禁：lint 0 / format 0 / typecheck 0 / build 0；test 26 文件 101 用例，仅 AgentDomainListPage 1 failed（P0 基线 flaky，git stash 基线同样失败）。未闭环登记：多实例 SKIP LOCKED 优化（首版单实例进程内，DB 租约互斥兜底）、公开事件 Socket 广播（user_id=null 经 /platform 全连接 emit，随多实例 pub/sub 扩展登记运维项）、各任务处理器入账单据经 0019 迁移 + payout worker 运维闭环（payout_attempt 表已存在，真实出款渠道推进经 payout worker 批量扫描登记）、0018 补列迁移（created_by_user_id 等）登记决策点。 |
| 2026-11-04 | §9 第 9 步后端 Admin 模块落地：`packages/backend/src/modules/admin/`（17 文件）——domain AD 错误码表 13 项 + 审计 snapshot 脱敏校验（validateAuditSnapshot 黑名单键拒绝落库）+ 状态机转换表（agent_domain 5 态 / withdrawal 9 态 / trade DISPUTE 裁决 / AI job 审核）；7 用例（agent-domain approve/suspend/revoke、coin-market DISPUTE 3/4/5/6→RELEASED=7/RESOLVED_RETURN=10、ai-assets review REVIEW_REQUIRED=6→SUCCEEDED=3/FAILED=4、admin-audit U(request_key) 幂等 + append-only 只 create、admin-user list/detail、withdrawal approve/reject 双人复核 operated_by≠approved_by 服务端强制）+ 7 个独立 Sequelize Repo 类（每表一类）；assembly `createAdminModule({sequelize, config})` 不依赖 walletModule。server 侧：admin-auth-middleware.ts（Admin audience JWT aud='admin' + Redis admin session + auth_version 三重门禁）+ admin.routes.ts 11 端点（/admin-api/v1 前缀；login 不挂鉴权，其余经 Admin 鉴权）+ app.ts+main.ts 装配（identityModule+adminModule+sequelize 均就绪时挂载）。packages/backend 新增 `./modules/admin` exports。门禁：lint 0 / format 0 / typecheck 0 / build 0；admin test 1 failed（P0 基线 flaky AgentDomainListPage，git stash 基线同样失败，非回归）。未闭环登记：Admin 登录 UI 未建（sessionStorage accessToken 注入链路，归后续 Admin 前端任务）、admin-user-detail 四 section 首版空占位（跨模块 ports 依赖登记）、出款 payout worker 未建（payout_attempt 表已存在，真实出款渠道推进登记运维闭环）。 |
| 2026-11-04 | §9 第 9 步前端部分落地：19 个领域工作区 composition.ts 全部接入 Admin API client 双轨切换。新建共享基础设施 `apps/admin/src/platform/admin-api-client.ts`（AdminApiClient：/admin-api/v1 前缀 + 统一 envelope 解析 + Bearer 令牌经 sessionStorage('admin.accessToken') 注入 + 401 自动刷新一次重试 + AdminApiError）；19 个 Remote*Adapter 文件（admin-audit/remote-admin-audit-adapter.ts 等，逐工作区实现既有 RepositoryPort/Repository 接口的 REMOTE 侧，DTO 形状复用 @gameing/admin-contracts + @gameing/contracts 既有 schema，页面/组件/router 零改动）；各 composition.ts 保留既有本地导出名（localDemoAdminUserApplication 等）作为 LOCAL_DEMO 默认入口，新增 create*App({useRemote}) 工厂 + import.meta.env.VITE_ADMIN_API_BASE 有值即切 REMOTE 的 feature flag。browser-development-database.ts 保留不删，文件头登记退役条件（19 工作区全 REMOTE + /admin-api/v1 端点全就绪 + typecheck/视口几何验收通过后随 §9 第 9 步收口删除）。验证：`pnpm --filter @gameing/admin typecheck` 0 错误（未跑全量门禁，Lead 统一验证）。 |
| 2026-11-04 | §9 第 7 步平台事件与金币集市模块落地：`packages/backend/src/modules/platform-events/`（9 文件）——domain 公告投影纯函数 + GameEventInstanceRepo 端口（findActiveAnnouncements 只读）+ ActiveAnnouncementsUseCase（单页全量 100 上限）+ assembly `createPlatformEventsModule({sequelize, config})`（不依赖 walletModule）；`packages/backend/src/modules/coin-market/`（17 文件）——domain 守恒校验 + 11 态 DDL 权威状态机 + priceQuote BigInt 整除 + 7 用例（listing-create 占款 COIN_MARKET_HOLD 经 walletModule.ledger、listing-page 报价、listing-cancel 释放占款、trade-create U(trade_key) 幂等、trade-confirm PAYMENT_PENDING=1→SELLER_CONFIRMATION_PENDING=2、trade-list 读路径超时推进 PAYMENT_EXPIRED=9）+ assembly `createCoinMarketModule({sequelize, walletModule, config})`；`apps/server/src/http/coin-market.routes.ts` 7 端点 + `platform-events.routes.ts` 1 端点（替换公告 stub，双挂登记）；app.ts+main.ts 装配（platform-events 需 sequelize，coin-market 需 walletModule+sequelize）。`packages/backend` 新增 4 条 exports。lint 0 / format 0 / typecheck 0 / build 0；admin test flaky P0 基线。未闭环登记：9-vs-11 双轨差异（contracts CoinMarketTradeStatus 9 值 P0 本地简化，DDL 11 值权威，对齐归 §9 第 9 步 Admin cutover）、占款 assetOperationId='0' 简化（COIN_MARKET_HOLD=12 分录 worker 随 §6.3 管线）、assetAccountId 用 userId 代账户 id（0017 迁移补列决策点）、读路径逐笔推进 PAYMENT_EXPIRED=9（worker 批量扫描未建）、DISPUTE 路径 3/4/5/6 裁决 Admin 端点归 §9 第 9 步。 |
| 2026-11-03 | §9 第 6 步邀请返佣与代理域模块落地：`packages/backend/src/modules/referral/`（16 文件）——domain 五级返点率纯函数（depth 1~4 → 10%/8%/5%/3%，rate_bps 1000/800/500/300）+ 链连续性校验 + 域隔离 + 错误码表；5 个独立 Sequelize Repo 类（ReferralBindingRepo/BindingEventRepo/RewardAllocationRepo/AgentDomainRepo/UserInviteRepo，每表一类，实体前缀命名）；5 用例（invite-link 幂等签发/读取；direct-invitees + rewards 游标分页 50/页；attribution 归因 U(user_id) 幂等不产生第二绑定；agent-domain PENDING_REVIEW=1 申请/查询幂等重放；referral-list 直属下级/返佣明细）；assembly `createReferralModule({sequelize, config})` 不依赖 walletModule（归因无资金操作；reward_allocation REFERRAL_REWARD=11 入账经 walletModule.ledger 扩展点登记，首版未建）；displayNameOf 经 user.publicCode 匿名展示名。`apps/server/src/http/referral.routes.ts` 7 端点（GET/POST /me/invite-link、GET /me/referrals/direct-invitees、GET /me/referrals/rewards、POST /me/agent-domain/apply、GET /me/agent-domain、POST /public/referral-attribution/candidate）；app.ts+main.ts 装配（identity+sequelize 均就绪时挂载，无需 wallet）。`packages/backend` 新增 `./modules/referral` exports。lint/format/typecheck/build 全绿；admin test 首跑 7 failed / 复跑 4 failed（P0 基线 flaky，与 referral 无关）。未闭环登记：reward_allocation REFERRAL_REWARD=11 入账 worker（wallet ledger 扩展点，首版未建，随 §6.3 outbox 管线落地）、Redis 直连 IP 归因暂存（归 §9 第 7 步 configuration 落地）、agent_domain Admin 审批端点（PENDING_REVIEW→ACTIVE/SUSPENDED/REVOKED 推进归 §9 第 9 步）。 |
| 2026-11-03 | §9 第 5 步社交与客服模块落地：`packages/backend/src/modules/social/`（14 文件）——domain 消息游标/幂等纯函数 + 4 个独立 Sequelize Repo 类（每表一类，实体前缀命名）+ 6 用例（post-create PENDING_REVIEW=1 + post_key 幂等；post-reply 一层嵌套；conversation-create U(low,high) 幂等；message-send U(conversation,message_no) + U(sender,client_message_id) 幂等 + outbox(social.message) 同事务；message-list 游标 50/页；friendship PENDING=1→ACCEPTED=2/REJECTED=3/REMOVED=4 状态机）+ assembly（不依赖 walletModule，outboxPortFactory 注入）。`packages/backend/src/modules/support/`（12 文件）——domain 坐席 claim 幂等键 + 回复权限校验纯函数 + 2 个独立 Repo 类 + 5 用例（ticket-create WAITING_SUPPORT=1 + 首条消息 CUSTOMER=1 同事务 + outbox(support.message)；ticket-list 游标；ticket-claim 幂等 assigned_admin_user_id；ticket-reply U(message_key) 幂等 + 双端 outbox 投递 + WAITING_SUPPORT=1→WAITING_USER=2 状态机；ticket-resolve CLOSED=3 + closed_at）+ assembly。`apps/server/src/http/social.routes.ts` 6 端点 + `support.routes.ts` 5 端点；app.ts+main.ts 装配（identity+sequelize 均就绪时挂载，无需 walletModule）。`packages/backend` 新增 social/support exports + `infrastructure/database/models/events` 子路径导出。全量门禁 lint/format/typecheck/build 全绿；test 2 failed（AgentDomainListPage + GameCatalogPage P0 基线 flaky，与本次改动无关）。未闭环登记：outbox worker（social.message/support.message/social.post/social.post_reply topic）未建（§6.3 管线，随 §9 第 9 步落地）、Admin audience 中间件（support claim/resolve 端点首版简化为 player token + role_type 校验，完整 Admin 鉴权归 §9 第 9 步）、social_block/social_report/social_content_interaction 端点（审核/屏蔽/举报/互动，归 §9 第 9 步 Admin 模块）、读水位推进端点（user_low/high_read_through_no 单调递增，首版未建，登记决策点）。 |
| 2026-11-03 | §9 第 4 步房间与牌局模块落地：`packages/backend/src/modules/rooms/`（16 文件）——domain round 状态机 6 态（PREPARING=1/ACTIVE=2/SETTLING=3/SETTLED=4/CANCELLED=5/RECOVERING=6）+ round_player 4 态 + fencing token 校验 + submission_key 幂等键 + settlement input/result sha256 hash + water→BigInt 边界转换；6 用例（room-create：room WAITING=1 + room_code 6 位随机 + game_entry QUEUED=1 同事务；room-join：room 未满员 + membership SEATED=1 幂等 claim + U(user,active_marker) 防重复入座；round-start：逐玩家 asset_hold GAME=1 占款（经 AssetLedger claimOperation+postEntries，WITHDRAWAL_HOLD=6 op type + extra JSON roundId 标记，GAME_HOLD 未注册）+ round PREPARING=1 + round_player ACTIVE=1 + round_event START；round-submit：round ACTIVE 校验 + U(round,submission_key) 幂等 + 全玩家 SUBMITTED 推进 SETTLING=3；round-settle：ShisanshuiAdapter.settle（@gameing/shisanshui-rules settleRound 纯函数，非外部调用）→ 逐玩家 COI ±water 分录 + 系统 COI ∓Σwater 守恒 + settlement PREPARED→COMMITTED + round SETTLED + round_event SETTLED + outbox(game.round.settled)，settlement U(round_id) 幂等重放不重复发币（验收红线"结算一次"）；game-entry：list/create 入局资格 QUEUED→SEATED→FINISHED 推进）；Adapters：5 个独立 Sequelize Repo 类（每表一类，实体前缀命名 createRoom/createRound/settleRound/appendRoundEvent/createEntry/createSettlement，消除同名方法冲突）+ ShisanshuiAdapter（settleRound 一行封装）；assembly 注入 walletModule（ledger/systemIdentity/clock 复用，不重建）。`apps/server/src/http/rooms.routes.ts` 7 端点（GET/POST /me/rooms、POST /rooms/:roomId/join、POST /rooms/:roomId/rounds、POST /rounds/:roundId/submit、GET /rounds/:roundId/settlement、GET /me/game-entries）；app.ts+main.ts 装配，rooms 路由在 identity+wallet+sequelize 均就绪时挂载，否则降级不挂。`packages/backend` 新增 `@gameing/shisanshui-rules` workspace dep + `./modules/rooms` exports。全量门禁 lint/format/typecheck/test/build 全绿（test 26+28 全过）。未闭环登记：GAME_HOLD operation type 未注册（首版复用 WITHDRAWAL_HOLD=6 + extra JSON 标记 roundId）、round_event payload_ciphertext 首版占位（加密层未闭环）、RECOVERING=6 断线恢复重放路径登记（实际 handler 重放逻辑随 §6.3 outbox worker 落地）、/room/:roomId Socket 命名空间随 §6.1 管线落地、房间断线恢复快照端点（GET /rounds/:roundId/snapshot）未建。下一步：§9 第 5 步社交与客服（0014/0015）。 |
