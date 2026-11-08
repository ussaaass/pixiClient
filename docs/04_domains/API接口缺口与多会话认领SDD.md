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
| API-GAP-002 | P0 / 0 | 生产 Web identity/session composition（注册/登录/刷新/登出/当前用户） | **前端接口组合缺失**；部分 HTTP client 与后端 auth 路由存在 | `apps/web/src/main.ts` 的生产分支只注入 game experience/catalog；`player-entry/composition.ts` 使用 offline adapter；未发现当前用户摘要 API | 先解决注册与 current-user 契约；需生产浏览器验收；测试子切片不代表生产 composition 闭环 | SESSION-GAP-2026-11-07-D / CLAIMED / 25%（仅 API client transport contract tests；生产接线仍阻塞） |
| API-GAP-003 | P0 / 0 | `GET /api/v1/me`（当前用户/玩家摘要） | **已核实 endpoint 与专用 DTO 缺失；字段语义未定义** | 只读审查确认 auth routes/app assembly 无玩家摘要路由；contracts/OpenAPI 无专用 DTO/登记。登录 PlayerUser、identity-settings、wallet summary 职责不同，UserModel 含密码/TOTP/权限/联系方式等敏感字段 | 产品/API 先冻结用途、最小字段来源、授权/缓存要求；在决策前不新增 schema/route，不序列化 UserModel。审查子切片见 API-GAP-017 | SESSION-API-GAP-2026-11-07-H / CLAIMED / 25%（审查记录完成，待产品字段决策） |
| API-GAP-004 | P1 / 1 | 房间 Socket.IO namespace、成员房间加入/广播 | **服务端接口缺失** | `apps/server/src/socket/socket-auth.ts` 当前只挂 `/platform`；room namespace deferred | 房间成员鉴权、事件序号/幂等、仅向授权玩家发私有状态；与权威发牌设计依赖 | — / BLOCKED_DECISION / 0% |
| API-GAP-005 | P1 / 1 | `GET /api/v1/rounds/:roundId/snapshot` 与游标事件恢复 | **已实现并通过当前切片验证** | 初始勘查时 rooms route 无该快照端点；现有 route、contract、use case 与成员授权 | 代码提交 `29944ac` 并推送 `origin/main`；验证记录及跨 session 可见的认领见 §5。事件仅返回元数据，结算前隐藏全部 arrangement | SESSION-GAP-2026-11-07-A / DONE / 100% |
| API-GAP-006 | P1 / 1 | 服务端发牌、私牌密文读写与披露 | **业务服务/存储未闭环** | room-start 主要建局/占款；assembly 中私有 payload ciphertext 标注 placeholder | 随机源、seed commit/reveal、公平性审计、密钥与争议披露决策，暂不认领实现 | — / BLOCKED_DECISION / 0% |
| API-GAP-007 | P1 / 1 | 真实双客户端牌局/断线/重启恢复验收接口链 | **端到端验收缺失** | SDD §6.4 要求两客户端、失败注入、跨设备重放；现有 focused unit tests 不能代替 E2E | 依赖 GAP-004/005/006；无房间恢复/超时政策前不标完成 | — / OPEN / 0% |
| API-GAP-008 | P2 / 2 | 生产 Web wallet composition（summary/activity/transfer/exchange） | **前端接线缺失**；服务端 routes/use cases 存在 | `apps/server/src/http/wallet.routes.ts` 有端点；生产 Web main 尚未注入 wallet app，模块装配还依赖 `SYSTEM_USER_ID` | 真实浏览器/API contract/ledger reconciliation 验收；建议先接只读 summary/activity 子切片；当前生产 identity/session 来源缺失，依赖 GAP-002 与 `SYSTEM_USER_ID` 配置 | SESSION-GAP-2026-11-07-B / CLAIMED / 0%（只读切片审查；实现阻塞于生产 session composition） |
| API-GAP-009 | P2 / 2 | 有效下注 turnover 与提现/转出资格端到端闭环 | **局部用例/adapter 存在，生产验收未证实** | round settlement 有 turnover 消费；需验证全链余额、hold、turnover 聚合与提现规则 | 依赖阶段 1 权威结果和有效 wager 决策；财务集成测试 | — / OPEN / 0% |
| API-GAP-010 | P2 / 2 | 充值订单到支付渠道验签/查询/履约 | **Mock/通道处理缺失** | order-create 使用 mock 标识；支付事件按 mock/verified 路径，未建立真实渠道回调/checkout 全链 | 渠道商户凭证、验签和冲正决策，真实启用 BLOCKED_EXTERNAL | — / BLOCKED_EXTERNAL / 0% |
| API-GAP-011 | P2 / 3 | 提现 outbox：`payout_attempt`、provider submit/query、UNKNOWN recovery、对账 | **关键处理器缺失** | `apps/server/src/infrastructure/outbox/outbox-task-handlers.ts` 明确未实现财务 task handlers；dispatcher fail closed | Provider 契约/凭证、KMS、UNKNOWN 和人工对账政策；BLOCKED_EXTERNAL/DECISION | — / BLOCKED_EXTERNAL / 0% |
| API-GAP-012 | P2 / 3 | 返佣 allocation 冻结释放与账本写入 | **资金事实/worker 未闭环** | referral 读接口存在；奖励写入/释放任务 handler 未实现或不能证明闭环 | 比例舍入、零奖励、chargeback、祖先快照时点需财务裁决 | — / BLOCKED_DECISION / 0% |
| API-GAP-013 | P2 / 4 | 邀请候选采集与注册/login 原子消费 | **候选业务集成缺失/不完整** | referral candidate route 存在；尚无证据证明 auth 注册/login 路径原子消费候选；信任代理/IP 边界未定 | 多账号消费、失败回退、代理信任政策需裁决 | — / BLOCKED_DECISION / 0% |
| API-GAP-014 | P3 / 5 | Admin 生产客户端与财务运营/审计端到端接线 | **部分后端路由已存在，生产 Admin 未证实** | server admin routes 有部分审核；后台当前完整业务/权限/审计集成未按生产验收证明 | 逐工作区验证客户端、Admin audience/capability、审计及双人复核；当前子切片仅核验审计远端适配器，不代表服务端 GET 路由存在或生产审计闭环 | SESSION-GAP-2026-11-07-C / CLAIMED / 25%（新增远端 adapter 单测；server GET 路由及 production 验收仍待确认） |
| API-GAP-015 | P2 / 2（GAP-008 子切片） | Wallet summary/activity Web API client contract 回归 | **已补独立契约测试；生产组合仍缺** | `wallet-api-client.test.ts` 覆盖现有 client 的 GET path/method/Bearer/cursor/envelope/schema；focused Docker Vitest 1 file / 6 tests passed | 不证明生产组合、session 或 wallet module 配置；不得宣称 GAP-008 闭环 | SESSION-API-GAP-2026-11-07-F / DONE / 100%（限此测试子切片） |
| API-GAP-016 | P2 / 2（GAP-009 子切片） | TurnoverGate 用例状态与错误映射单测 | **单测已补；端到端缺口仍在** | `turnover.test.ts` 覆盖无行、ACTIVE 正余额、COMPLETE/0、REVERSED 正值、存储错误映射、既有领域错误透传与 tx 传递；Vitest 1 file / 7 tests passed，scoped ESLint/Prettier passed | 后端 typecheck 因缺少 `jose`、`ioredis` 依赖未通过；资金事务、锁序、MySQL 对账及完整资格闭环仍待验证，不得宣称 GAP-009 完成 | SESSION-API-GAP-2026-11-07-G / DONE / 100%（限 gate 单测子切片） |
| API-GAP-017 | P0 / 0（GAP-003 子切片） | `GET /api/v1/me` DTO 字段与隐私边界审查 | **endpoint/摘要 DTO 缺失且字段未决** | 无 route/专用 schema；登录 `PlayerUser`、identity-settings、wallet summary 职责不可替代；UserModel 含密码/TOTP/权限/联系方式等敏感数据 | 只记录审查/决策请求；需产品冻结用途、最小字段、来源与授权前，不新增 schema/route、不序列化 Model | SESSION-API-GAP-2026-11-07-H / CLAIMED / 25%（完成只读代码与协议审查，未改合同/路由） |

## 4. 可并行切片建议

- 不需要改变业务语义、可先做合同/只读能力：API-GAP-003（仅在权威 DTO/隐私字段核定后）、API-GAP-005（只读快照，需确认 recovery port 数据完备）、API-GAP-008（只读 wallet UI/client 接线）。
- 需先由用户/产品/安全/财务决策：API-GAP-001、004、006、010–013 的相关核心路径。
- 可并行但写区隔离：每个 session 认领不同 API-GAP，独立 contracts/module/routes/tests 文档范围；同一接口 contract 与客户端接线须通过子任务依赖顺序，不允许分别定义 DTO。

## 5. 当前施工认领

首次整理会话 `SESSION-GAP-2026-11-07-A` 已完成 API-GAP-005（快照与游标补拉）。新增 contract、use case、route 与 7 个 use-case tests；通过独立 route integration (1/1)、server app suite (14/14)、backend/server/contracts typecheck、contracts tests (29)、scoped ESLint 与 graphify update。端点在结算前隐藏所有 arrangement，仅返回事件元数据。提交 `29944ac` 已推送至 `origin/main`。

并行认领（由 session `SESSION-GAP-2026-11-07-LEAD` 登记）：

- `SESSION-GAP-2026-11-07-B` 认领 API-GAP-008，仅先做生产只读钱包切片可行性审查。当前无可安全接入的 production session/token source，且 Web API client 与 wallet/backend 相关路径已有共享未提交修改；不触碰其实现文件。摘要/活动端到端接线依赖 GAP-002 身份会话完成与 `SYSTEM_USER_ID` 生产配置，未解除前不得宣称实现。
- `SESSION-GAP-2026-11-07-F`（GAP-008）仅新增 `apps/web/src/platform/http/wallet-api-client.test.ts`，覆盖现有 wallet summary/activity HTTP client 的 path/method/Bearer/cursor/envelope；不改 dirty 的 `api-client.ts` 或 GAP-002 的 `api-client.test.ts`，不宣称生产接线。
- `SESSION-GAP-2026-11-07-C` 认领 API-GAP-014 的审计远端适配器测试子切片，范围限定 `apps/admin/src/platform/admin-audit/remote-admin-audit-adapter.test.ts`。测试仅验证当前 adapter 对现有 client 的路径/query/响应及错误传播；server 侧未发现对应 GET 路由，故该测试不是 production endpoint 可用性证明。focused Docker test：1 file / 2 tests passed。
- `SESSION-GAP-2026-11-07-D` 认领 API-GAP-002 的 API client transport contract test 子切片，范围仅 `apps/web/src/platform/http/api-client.test.ts`；覆盖 malformed request、credentials/request ID、endpoint method/path、envelope 与失败处理。focused Docker test：1 file / 7 tests passed。此测试不证明生产登录/session composition；审计发现现有 `refresh()` / `deviceLogin()` 向客户端 schema validation 传入 `{}`，但契约要求 operationId/设备凭证字段，相关流程因此在发请求前失败，需独立协调后修复，不在本测试子切片中改实现。

## 5.1 附加契约验证任务

- `SESSION-API-CONTRACT-2026-11-07-E`：对 GAP-002 中记录的 `deviceLogin` / `refresh` 请求体与契约 mismatch 增加独立回归测试；范围仅 `apps/web/src/platform/http/identity-request-contract.test.ts`，验证现有客户端调用与 `IdentityEndpoint` 请求 schema 的符合性。测试只揭示当前调用不符合契约，不修改 client/schema，不代表生产身份闭环完成；修复需另行协调设备凭证来源与 refresh operationId 生命周期。focused Docker test 通过：1 file / 1 test。
- `SESSION-API-GAP-2026-11-07-G`（API-GAP-009）已完成：仅新增 `packages/backend/src/modules/wallet/application/turnover.test.ts`，覆盖统一 turnover gate 状态/错误/事务透传；不改 gate/ledger/settlement 生产代码，不宣称端到端资金/并发/回滚闭环。focused Docker Vitest 1 file / 7 tests passed；backend typecheck 受 `jose`、`ioredis` 缺少依赖阻塞。
- `SESSION-API-GAP-2026-11-07-H`（API-GAP-003）：仅在本 SDD 增补只读契约审查结论，确认当前无 `/api/v1/me` DTO/route，列出字段冻结前的隐私边界与待决字段需求；不改 contracts/routes，不推断产品字段。

## 6. 变更历史

| 日期 | 变更 |
|---|---|
| 2026-11-07 | 新建接口缺口总账，拆分缺失路由、未接生产客户端、Mock/占位与决策/外部凭证阻塞；建立跨 session 唯一认领、进度、冲突与完成协议。 |
| 2026-11-07 | API-GAP-005 完成快照查询端点、成员授权与游标分页；contract/use-case/route tests 通过，并提交 `29944ac` 推送至 origin/main，认领标记 DONE。 |
| 2026-11-07 | 新增 GAP-008、GAP-014、GAP-002 测试子切片 session 认领；明确生产 wallet 依赖身份会话、Admin 审计适配器测试不等于服务端生产路由验证，并记录现有 deviceLogin/refresh client 与请求 schema 不匹配的阻塞。 |
| 2026-11-07 | 登记 GAP-002 identity request/schema mismatch 的附加回归测试子任务；限定为新文件且不修改 API client/contracts，明确设备凭证与 operationId lifecycle 仍需协调；focused Docker Vitest 1/1 通过。 |
| 2026-11-07 | 多会话推进：复核并完成 GAP-008 wallet API client contract tests（6 tests）与 GAP-009 TurnoverGate unit tests（7 tests；typecheck 因 jose/ioredis 缺依赖未通过）；记录 GAP-003 摘要 DTO 隐私/契约审查及字段决策阻塞。两个测试子切片均不代表生产钱包接线或资金端到端闭环，并将 GAP-003 从“待核实”更新为已证实缺失/字段待决。 |
