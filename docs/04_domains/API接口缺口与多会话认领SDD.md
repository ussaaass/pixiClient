# API 接口缺口与多会话认领 SDD

## 1. 目的与口径

本文件是《玩家核心旅程与业务闭环 SDD》的施工台账：区分**真正缺失的服务端接口/处理器**、**服务端已有但 Web/Admin 未接入**、**存在但只是假数据/Mock**、**受决策或外部凭证阻塞**。路由文件存在不代表生产流程可用。核心优先级沿用核心旅程 SDD §10；不能把需审批的业务语义伪装成纯技术任务。

勘查基线：2026-11-07（America/Los_Angeles）；只读审查与提交 `8dc8f1b`。只读审查未运行额外测试。接口状态需随着新代码和运行验收复核。

## 2. 跨会话认领协议

- 每个可施工项使用稳定 ID `API-GAP-NNN`。本文件的 `认领 session` 是人工填写的唯一会话标记（建议由用户给每个并行 session 指定短 ID，如 `S-A`、`S-B`）；未分配前状态为 `OPEN`。
- 认领前必须拉取/同步最新 `main`，检查本表状态及 Git 工作树；在该任务行更新 `session=<ID>; status=CLAIMED; progress=0%` 并先提交认领记录，才可改代码。用户在多个 session 间复制该表时，提交哈希是认领先后依据；遇到同项已有有效认领，必须选别项或先协调释放。
- 每次阶段提交更新进度为 0/25/50/75/100%，并记录代码/契约/测试文件、最近提交哈希和阻塞。进度表示可复核交付，不是工时估算。
- 任务完成条件：实现、相关契约/单测/集成测试、运行验证、SDD/状态更新均完成；之后标 `DONE`、100%、commit。需要产品/法务/财务/安全批准或外部密钥的任务标 `BLOCKED_DECISION` / `BLOCKED_EXTERNAL`，不得先造默认值。
- 同一 session 可以认领多个文件互不重叠的任务；不同 session 不得同时编辑同一行/文件范围。任务拆分后新增子 ID，不能通过改标题绕过冲突。
- 当前认领记录只对本仓库 Git 可见；未 push 的认领不能作为其他工作站/session 已知信息。跨机器并发时先 push 认领提交，其他 session fetch 后再选任务。

## 3. 缺口盘点（当前证据，不等于全部代码审计）

| ID | 优先级 / 阶段 | API / 业务切片 | 现状分类 | 证据与缺口 | 阻塞 / 验收范围 | 认领 session / 状态 / 进度 |
|---|---|---|---|---|---|---|
| API-GAP-001 | P0 / 0 | `POST /api/v1/auth/device-register`：首次匿名设备注册 | **存在路由但硬拒绝**；返回 503 | `apps/server/src/http/auth.routes.ts` 返回 503；device-login 要求既有 userId/device digest/credential key | 安全设备秘密签发、幂等 SQL/Redis 跨存储补偿协议须经安全批准；暂不认领 | — / BLOCKED_DECISION / 0% |
| API-GAP-002 | P0 / 0 | 生产 Web identity/session composition（注册/登录/刷新/登出/当前用户） | **前端接口组合缺失**；部分 HTTP client 与后端 auth 路由存在 | `apps/web/src/main.ts` 的生产分支只注入 game experience/catalog；`player-entry/composition.ts` 使用 offline adapter；未发现当前用户摘要 API | 先解决注册与 current-user 契约；需生产浏览器验收；允许拆出已批准子项 | — / OPEN / 0% |
| API-GAP-003 | P0 / 0 | `GET /api/v1/me`（当前用户/玩家摘要） | **契约/API 缺口待核实** | auth routes 有 identity-settings 但未发现玩家当前用户/大厅摘要 endpoint；需检查后端实施 SDD 与 contracts 的权威 DTO 定义后再实现 | 先冻结必要字段及授权规则；不可随意新增泄露个人/代理字段 | — / OPEN / 0% |
| API-GAP-004 | P1 / 1 | 房间 Socket.IO namespace、成员房间加入/广播 | **服务端接口缺失** | `apps/server/src/socket/socket-auth.ts` 当前只挂 `/platform`；room namespace deferred | 房间成员鉴权、事件序号/幂等、仅向授权玩家发私有状态；与权威发牌设计依赖 | — / BLOCKED_DECISION / 0% |
| API-GAP-005 | P1 / 1 | `GET /api/v1/rounds/:roundId/snapshot` 与游标事件恢复 | **已实现并通过当前切片验证** | 初始勘查时 rooms route 无该快照端点；现有 route、contract、use case 与成员授权 | 代码提交 `29944ac` 并推送 `origin/main`；验证记录及跨 session 可见的认领见 §5。事件仅返回元数据，结算前隐藏全部 arrangement | SESSION-GAP-2026-11-07-A / DONE / 100% |
| API-GAP-006 | P1 / 1 | 服务端发牌、私牌密文读写与披露 | **业务服务/存储未闭环** | room-start 主要建局/占款；assembly 中私有 payload ciphertext 标注 placeholder | 随机源、seed commit/reveal、公平性审计、密钥与争议披露决策，暂不认领实现 | — / BLOCKED_DECISION / 0% |
| API-GAP-007 | P1 / 1 | 真实双客户端牌局/断线/重启恢复验收接口链 | **端到端验收缺失** | SDD §6.4 要求两客户端、失败注入、跨设备重放；现有 focused unit tests 不能代替 E2E | 依赖 GAP-004/005/006；无房间恢复/超时政策前不标完成 | — / OPEN / 0% |
| API-GAP-008 | P2 / 2 | 生产 Web wallet composition（summary/activity/transfer/exchange） | **前端接线缺失**；服务端 routes/use cases 存在 | `apps/server/src/http/wallet.routes.ts` 有端点；生产 Web main 尚未注入 wallet app，模块装配还依赖 `SYSTEM_USER_ID` | 真实浏览器/API contract/ledger reconciliation 验收；建议先接只读 summary/activity 子切片 | — / OPEN / 0% |
| API-GAP-009 | P2 / 2 | 有效下注 turnover 与提现/转出资格端到端闭环 | **局部用例/adapter 存在，生产验收未证实** | round settlement 有 turnover 消费；需验证全链余额、hold、turnover 聚合与提现规则 | 依赖阶段 1 权威结果和有效 wager 决策；财务集成测试 | — / OPEN / 0% |
| API-GAP-010 | P2 / 2 | 充值订单到支付渠道验签/查询/履约 | **Mock/通道处理缺失** | order-create 使用 mock 标识；支付事件按 mock/verified 路径，未建立真实渠道回调/checkout 全链 | 渠道商户凭证、验签和冲正决策，真实启用 BLOCKED_EXTERNAL | — / BLOCKED_EXTERNAL / 0% |
| API-GAP-011 | P2 / 3 | 提现 outbox：`payout_attempt`、provider submit/query、UNKNOWN recovery、对账 | **关键处理器缺失** | `apps/server/src/infrastructure/outbox/outbox-task-handlers.ts` 明确未实现财务 task handlers；dispatcher fail closed | Provider 契约/凭证、KMS、UNKNOWN 和人工对账政策；BLOCKED_EXTERNAL/DECISION | — / BLOCKED_EXTERNAL / 0% |
| API-GAP-012 | P2 / 3 | 返佣 allocation 冻结释放与账本写入 | **资金事实/worker 未闭环** | referral 读接口存在；奖励写入/释放任务 handler 未实现或不能证明闭环 | 比例舍入、零奖励、chargeback、祖先快照时点需财务裁决 | — / BLOCKED_DECISION / 0% |
| API-GAP-013 | P2 / 4 | 邀请候选采集与注册/login 原子消费 | **候选业务集成缺失/不完整** | referral candidate route 存在；尚无证据证明 auth 注册/login 路径原子消费候选；信任代理/IP 边界未定 | 多账号消费、失败回退、代理信任政策需裁决 | — / BLOCKED_DECISION / 0% |
| API-GAP-014 | P3 / 5 | Admin 生产客户端与财务运营/审计端到端接线 | **部分后端路由已存在，生产 Admin 未证实** | server admin routes 有部分审核；后台当前完整业务/权限/审计集成未按生产验收证明 | 逐工作区验证客户端、Admin audience/capability、审计及双人复核 | — / OPEN / 0% |

## 4. 可并行切片建议

- 不需要改变业务语义、可先做合同/只读能力：API-GAP-003（仅在权威 DTO/隐私字段核定后）、API-GAP-005（只读快照，需确认 recovery port 数据完备）、API-GAP-008（只读 wallet UI/client 接线）。
- 需先由用户/产品/安全/财务决策：API-GAP-001、004、006、010–013 的相关核心路径。
- 可并行但写区隔离：每个 session 认领不同 API-GAP，独立 contracts/module/routes/tests 文档范围；同一接口 contract 与客户端接线须通过子任务依赖顺序，不允许分别定义 DTO。

## 5. 当前施工认领

首次整理会话 `SESSION-GAP-2026-11-07-A` 已完成 API-GAP-005（快照与游标补拉）。新增 contract、use case、route 与 7 个 use-case tests；通过独立 route integration (1/1)、server app suite (14/14)、backend/server/contracts typecheck、contracts tests (29)、scoped ESLint 与 graphify update。端点在结算前隐藏所有 arrangement，仅返回事件元数据。提交 `29944ac` 已推送至 `origin/main`。

## 6. 变更历史

| 日期 | 变更 |
|---|---|
| 2026-11-07 | 新建接口缺口总账，拆分缺失路由、未接生产客户端、Mock/占位与决策/外部凭证阻塞；建立跨 session 唯一认领、进度、冲突与完成协议。 |
| 2026-11-07 | API-GAP-005 完成快照查询端点、成员授权与游标分页；contract/use-case/route tests 通过，并提交 `29944ac` 推送至 origin/main，认领标记 DONE。 |
