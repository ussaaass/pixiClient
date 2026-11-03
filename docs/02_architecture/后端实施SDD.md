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
3. **不可变表**（asset_operation/asset_entry、*_event、*_audit_event、outbox）：model 关闭 `updated_at` 自动更新与软删钩子；用例层提供 append-only API，不提供 update/destroy。
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
- Admin：同 JWT 流程但 `aud=admin`，`user.role_type & 4`；每个路由在 registry 声明 `permission_code`，中间件按 `admin_permission(http_method, path_pattern)` 目录 + `user.permissions` 双重校验。
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

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-03 | 新建：后端实施 SDD（实体起步）：62 表 model 注册与迁移批次、模块/用例/端口布局、玩家+Admin HTTP 路由与端点清单、Socket.IO 三命名空间与 outbox 投递管线、Admin（Vue3.5+Element Plus）双轨切换映射、Docker 沿用现有 compose、9 步实施顺序与验收红线。 |
| 2026-11-03 | 校准表数口径：数据库设计 SDD §5 逐表实为 63 张（outbox 后补、开头 62 未更新），本 SDD 按 63 张为准并登记该差异；修 §1/§3.2 链到账子域归属矛盾（payments owns，model 文件独立）与 0008/0017 批次归属（asset/asset_release* 归 ai-assets）。 |
