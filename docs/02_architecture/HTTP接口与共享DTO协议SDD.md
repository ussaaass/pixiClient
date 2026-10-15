# HTTP 接口与共享 DTO 协议 SDD

阶段：浏览器端与服务端共同施工协议。本文统一 HTTP 状态码、响应 envelope、DTO/schema 唯一来源、序列化与 OpenAPI 生成方式。它覆盖玩家、Admin 和内部服务 HTTP；Socket.IO 使用独立命令/事件 envelope，但复用相同的领域 payload schema（语义相同且确属公开的部分）。

## 1. 目标与约束

- 一份运行时 schema 同时导出 TypeScript 类型、服务端校验依据和 OpenAPI 文档来源；禁止前后端分别手写同一 DTO。
- HTTP status 表达传输/请求结果类别，envelope `code` 表达稳定机器可读的业务结果，`message` 提供安全的人类可读兜底信息，`data` 承载 typed DTO。
- 所有外部输入由服务端运行时校验；浏览器共享类型不构成安全边界。
- 任何公共响应都不直接序列化 Sequelize Model、数据库 row、Redis key、服务端随机状态或未授权字段。
- BIGINT ID、金币、人民币金额等不能安全使用 JS number 的值一律用十进制字符串传输；0 不作为业务状态/常量。
- 一个客户端业务动作因弱网重试时复用业务幂等键；每次 HTTP attempt 的 requestId 可不同，二者不得混淆。

## 2. DTO 的唯一来源与共享包

```text
packages/contracts/src/
  common/
    api-envelope.ts
    api-errors.ts
    pagination.ts
    primitives.ts
  identity/
  wallet/
  payments/
  catalog/
  room/
  social/
  support/
  platform-events/
    announcement.ts

packages/admin-contracts/src/
  common/
  users/
  wallet/
  games/
  events/
  support/
```

- `packages/contracts` 由玩家 Web/App 与服务端 transport 消费，不得依赖 Node built-ins、Koa、Sequelize、数据库 Model、Redis 或密钥配置。
- `packages/admin-contracts` 存放 Admin 专属请求、响应和筛选 DTO；Admin schema 不得被玩家包的 barrel 导出。
- 游戏专属 HTTP payload 由 `games/<gameKey>/contracts` 所有；只有稳定且公开的通用 envelope / ID primitive 放共享 contracts。
- 每个 DTO 定义 TypeBox schema 并通过 `Static<typeof Schema>` 导出静态类型。Schema 是唯一字段/范围来源。OpenAPI 从这些 schema 与 endpoint registry 生成，不维护第二份接口 DTO。
- 如浏览器运行时需要验证响应，可在开发/测试或高风险边界使用相同 schema parse；不能因为客户端校验通过而省略服务端校验。

```ts
// packages/contracts/src/wallet/transfer.ts
import { Static, Type } from '@sinclair/typebox';

export const BigIntIdSchema = Type.String({ pattern: '^[1-9][0-9]*$' });
export const PositiveIntegerStringSchema = Type.String({ pattern: '^[1-9][0-9]*$' });
export const NonNegativeIntegerStringSchema = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });

export const TransferCoinsRequestSchema = Type.Object({
  receiverUserId: BigIntIdSchema,
  amountCoins: PositiveIntegerStringSchema,
  expectedWalletVersion: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export type TransferCoinsRequest = Static<typeof TransferCoinsRequestSchema>;

export const TransferReceiptSchema = Type.Object({
  operationId: BigIntIdSchema,
  senderWalletVersion: Type.Integer({ minimum: 1 }),
  receiverWalletVersion: Type.Integer({ minimum: 1 }),
  debitedCoins: PositiveIntegerStringSchema,
  receivedCoins: PositiveIntegerStringSchema,
  feeCoins: NonNegativeIntegerStringSchema,
}, { additionalProperties: false });

export type TransferReceipt = Static<typeof TransferReceiptSchema>;
```

命名使用 `CreateXRequest`、`XResponse`/明确的 DTO 名；查询参数用 `XQuery`；Socket 命令和事件使用 `XCommand`、`XEvent`。避免同一个 `UserDto` 横跨详情、列表、Admin 和私有身份信息；按最小公开字段拆成 `UserSummaryDto`、`UserProfileDto`、`AdminUserDetailDto` 等。

平台公告共享 schema 位于 `packages/contracts/src/platform-events/announcement.ts`，H5 端 HTTP 访问器位于 `apps/web/src/platform/announcements-api.ts`。`GET /api/v1/platform/announcements/active` 与 `GET /api/v1/platform/announcements/:announcementId` 使用本文件规定的 envelope；请求/响应字段、主体排除和受众过滤见[平台事件与广播系统设计](../03_game_systems/平台事件与广播系统设计.md)。当前 Koa 已实现 active 路径并返回契约有效的空列表，避免客户端启动请求落到 404；公告持久化/受众过滤、详情读取、JWT filter 与 Socket.IO 投递仍未实现，不能把空列表 stub 视为公告业务闭环。开发阶段公告 client 仍可读取 Browser API/mock 数据；真实快照上线前需补 projector 与 Koa contract test。

钱包只读摘要 endpoint 为 `GET /api/v1/me/wallet/summary`，只读明细 endpoint 为 `GET /api/v1/me/wallet/activity`，响应 DTO 均定义于 `packages/contracts/src/wallet.ts`。摘要返回 COIN、CNY 两种资产的有符号总额、冻结额、可用额及余额版本，并附剩余有效下注流水和本账号 welcome gift 摘要；明细返回最多 50 条当前用户资产账户分录并按时间倒序，通过 ISO UTC 时间和 entry ID 复合游标读取更早记录。两个 endpoint 均须 Bearer access token 认证，只能读取本人账户。金额以十进制整数字符串传输，人民币单位为分。共享 schema 不代表生产钱包 API 已实现；当前 Browser API 只作 IndexedDB 离线开发适配器。

金币转账使用 `POST /api/v1/me/wallet/transfers/quote` 生成 `WalletTransferQuoteDto`，再由 `POST /api/v1/me/wallet/transfers` 提交报价快照与 UUID 幂等键。报价记录收款人、本金、当前 feeBps、向上取整手续费、总扣款、报价时间及有效期；提交时服务端重新校验费率和收款人快照。响应为 `WalletTransferResultDto`。失败使用 400 金额校验、404 收款账号、409 自转账/流水未完成/余额不足/报价过期或变化/幂等冲突、503 钱包存储不可用。两个端点仅在当前 Browser API 实现，生产 Koa/账本事务待接。

金币兑换使用 `POST /api/v1/me/wallet/exchanges/quote` 与 `POST /api/v1/me/wallet/exchanges`。请求金额为金币正整数字符串，报价返回兑换比例快照、金币数、人民币分数及有效期；人民币分以配置比例精确计算后向下取整到分，配置变更或过期报价必须重新确认。提交使用 UUID 幂等键，响应为 `WalletExchangeResultDto`。执行需校验流水、可用金币、直属上级模式和系统人民币可用余额，并在单一事务内提交 COIN/CNY 两侧分录；Browser API 复用已有 IndexedDB `asset_operations/asset_entries`，生产端使用 `coin_exchange` 业务实体。错误码涵盖无兑换资格、流水未完成、余额不足、报价过期/变化、金额无效和幂等冲突。生产 Koa handler、MySQL 事务及代理模式权限校验待接。

邀请/代理 DTO 定义于 `packages/contracts/src/invite-agent.ts`：`GET/POST /api/v1/me/invite-link` 读取或签发当前用户两年有效的邀请码链接；`GET /api/v1/me/agent-domain` 读取申请/域状态；`POST /api/v1/me/agent-domain/application` 提交申请；`DELETE /api/v1/me/agent-domain/application` 撤回待审申请。所有 endpoint 均要求 Bearer access token。生产签发写入 user 邀请码字段，真实归因仍由直连 IP/Redis 服务完成；Admin 审批由管理端权限 API 执行，不由玩家 DTO 模拟。

好友与私信的共享 contract 位于 `packages/contracts/src/social.ts`：`GET /api/v1/me/social/access` 返回 `SocialAccessResponseDto`；`GET /profile` 返回本人随机 `friendCode`；`POST /friends/lookup` 仅接受好友码/二维码载荷或完整用户名；`GET /friends`、`POST /friend-requests`、`POST /friend-requests/:userId/accept|reject` 管理申请，`POST /friends/:userId/remove` 删除关系；`POST /conversations` 建立双方好友的一对一会话，`GET/POST /conversations/:conversationId/messages` 拉取/发送文字消息。私信携带 UUID `clientMessageId` 做幂等，响应携带 sender 和服务端时间。Browser API 以 `SocialAccessPolicy` 检查直属上级 `reward_type`：客损模式返回 disabled capability，其他社交私有端点返回 403 `SOCIAL_ACCESS_DISABLED`；H5 登录后读取 DTO 并隐藏导航。生产 SocialAccessPolicy、域授权、Koa handlers、Socket.IO/outbox、完整游标和限流尚未实现。

`packages/contracts/src/notifications.ts` 的 `NotificationSummaryResponseDto` 是玩家“消息与事项”的客户端读模型，不是一个新 HTTP endpoint 或 `user_notification` 持久化表。`NotificationSummaryApplication` 从公告、钱包流水、客服会话、社交好友申请各来源拉取最新摘要并按时间排序；每一项携带 source/action，点击后回到原领域继续操作。Guest 只读公开公告；任何来源失败会标注 source 并允许重试。该投影不提供统一已读状态、不复制消息正文，来源各自仍是权威记录；Browser API/Socket 生产端统一推送与游标补拉仍待实现。

## 3. HTTP 路径和版本

- 玩家 API 前缀 `/api/v1/`；Admin API 前缀 `/admin-api/v1/`，使用独立 audience、认证和权限校验。
- 路径使用小写 kebab-case 和资源名；筛选/分页通过 query schema。跨资源工作流可使用明确 action 子路径，例如 `/withdrawals/{id}/approve`，不能只靠客户端决定动作结果。
- 同一 major contract 内只允许向后兼容增加字段/新 endpoint。删除字段、改变字段单位/意义、改变必填条件或枚举语义属于破坏性变化，提升 `/v2` 或按兼容期迁移；不能只改 TypeScript type。
- 每个 endpoint registry 至少登记 method/path、auth audience、权限 code、request schema、response schema、成功 HTTP status、幂等要求、错误码集合和摘要。OpenAPI 由此生成并纳入 CI diff。

## 4. 统一 HTTP 响应 envelope

除文件流/范围下载等显式 binary endpoint 外，所有 JSON API 成功与失败响应采用同一 envelope；不使用 204，以保证 requestId、业务 code、message 和 server time 始终可读。

```ts
type ApiSuccess<T> = {
  requestId: string;
  code: 'OK';
  message: string;
  data: T;
  serverNow: string; // ISO 8601 UTC
};

type ApiFailure = {
  requestId: string;
  code: ApiErrorCode; // 稳定常量字符串，非 0 数字哨兵
  message: string;   // 安全、人类可读兜底；客户端不能据此分支
  data: null;
  serverNow: string;
  details?: Array<{
    field?: string;  // DTO 的 JSON Pointer/path；不回显敏感原始值
    code: string;    // 可供前端定位字段错误的稳定 code
    message: string; // 安全的字段提示
  }>;
  retryable?: boolean;
};
```

规则：

- HTTP status 和 envelope 必须一致。2xx 且 `code=OK` 表示请求成功；非 2xx 且 `code!=OK` 表示失败。不能用 HTTP 200 包装失败，也不能只看业务 code 忽略 HTTP status。
- `message` 是服务器提供的安全兜底文本，不是协议字段说明，也不能用于 UI 程序分支。前端按 `code` 做本地化文案映射；没找到映射时才显示安全 `message`。
- 查询成功可以使用通用成功提示；命令成功可使用简短提示，详细结果在 `data`。成功消息不是业务事实，不应产生重复 toast。
- 失败时 `data` 固定为 `null`。字段验证错误放 `details`；不返回堆栈、SQL、provider 原文、令牌、联系方式或钱包内部数据。
- `requestId` 由服务端为每个 HTTP attempt 建立/确认，用于日志关联。客户端可用 `X-Request-Id` 提供符合格式的 trace hint，但服务端需防止冲突/伪造并回传最终值。
- `serverNow` 为服务端 UTC 时间，仅用于显示/偏差估计；业务截止时间、倒计时以资源/局状态里的权威字段为准。

## 5. HTTP status code 映射

| HTTP | 使用场景 | 业务示例 |
| --- | --- | --- |
| `200 OK` | 读取、更新及已完成命令且返回 envelope | 资产详情、配置读取、幂等重放得到原操作结果 |
| `201 Created` | 同步创建资源并返回其 DTO | 创建房间、建立客服会话、创建订单 |
| `202 Accepted` | 已受理异步任务，尚未完成 | 长模拟任务、需要后台处理的导出/审核工作流；`data` 返回 operation/task ID 与状态查询入口 |
| `400 Bad Request` | JSON/路径/query 格式错误、TypeBox schema 不通过、缺失必需字段 | 非法 UUID、amount 不是整数字符串 |
| `401 Unauthorized` | JWT 缺失、无效、过期或已撤销 | 客户端按认证策略刷新/重新登录 |
| `403 Forbidden` | 已认证但没有该功能权限，或账号状态禁止执行 | Admin capability 不足、封禁账号不能启动游戏 |
| `404 Not Found` | 资源不存在；对不应泄露存在性的对象也可统一返回此码 | 不存在或调用者不可见的私有资源 |
| `405 Method Not Allowed` | 路径存在但 HTTP method 不支持 | 返回允许的方法信息，不执行命令 |
| `409 Conflict` | 资源当前状态、并发版本或幂等键冲突 | 钱包余额不足、过期 stateVersion、房间已满/阶段结束、相同幂等键内容不一致 |
| `422 Unprocessable Content` | DTO 结构有效，但业务规则拒绝且不是并发状态冲突 | 提现金额不满足门槛倍数、档位不支持当前玩法组合 |
| `429 Too Many Requests` | 按用户/IP/功能的限频拒绝 | 登录验证码尝试过频；可带 `Retry-After` |
| `413 Content Too Large` | JSON/upload body 超出 endpoint 声明限制 | 上传经独立 asset endpoint 限额；不解析超大 body |
| `415 Unsupported Media Type` | Content-Type 与 endpoint 不匹配 | JSON endpoint 拒绝表单或二进制 body |
| `500 Internal Server Error` | 未分类内部错误 | 只返回通用错误 code 与 requestId |
| `502 Bad Gateway` | 外部 provider 返回无效响应或网关上游错误 | 支付/汇率供应商响应无法解析 |
| `503 Service Unavailable` | 服务临时不可用或维护 | DB/Redis 短暂不可用、系统维护；仅明确安全时标记 `retryable=true` |
| `504 Gateway Timeout` | 上游等待超时 | 结果可能未知时必须用原幂等键查询，不能盲目创建第二个操作 |

同一失败语义必须由 error registry 固定映射，不能让每个 controller 自选 status。支付渠道状态未知、数据库提交 ACK 不确定等需保留领域细分 code，并提供按 `operationId/idempotencyKey` 查询结果的 endpoint；客户端对资金命令超时不得生成新幂等键自动重试。

## 6. HTTP request 与幂等

- JSON request body 直接是对应 `Request` DTO，不再额外套一层 `{ data: ... }`；响应统一套 envelope。
- 每次 attempt 用 `requestId` 做追踪；会产生副作用的客户端命令带稳定 `Idempotency-Key` header；重新发送同一业务意图必须复用同一 key 与相同 payload。Endpoint registry 声明该 header 的 schema/必需性，它不是重复塞在 JSON DTO 中的字段。
- 服务端将相同 key + 相同规范化 payload 返回原结果；同 key + 不同 payload 返回 `409 IDEMPOTENCY_KEY_REUSED`；过期 key 的保留期由领域 SDD 按资金/业务风险配置并写明。
- 请求不得包含客户端指定操作者 `userId/adminUserId` 来决定权限；由认证上下文确定 actor。目标用户等业务主体参数仍须逐次授权。
- GET/HEAD 只读；具有资金/审核/发布副作用的操作不得通过 GET。

示例：

```http
POST /api/v1/wallet/transfers
Authorization: Bearer <access-token>
Idempotency-Key: 5d585db2-14fe-4e18-9e66-1597d65c3a56
Content-Type: application/json

{
  "receiverUserId": "918273645012345678",
  "amountCoins": "1000",
  "expectedWalletVersion": 12
}
```

```json
{
  "requestId": "0c6dca6b-c1b9-4c9d-b9d3-1b39d3d302e4",
  "code": "OK",
  "message": "转账已完成",
  "data": {
    "operationId": "918273645012345700",
    "senderWalletVersion": 13,
    "receiverWalletVersion": 8,
    "debitedCoins": "1050",
    "receivedCoins": "1000",
    "feeCoins": "50"
  },
  "serverNow": "2026-10-10T08:30:00.000Z"
}
```

## 7. DTO 字段与序列化规范

| 概念 | wire 格式 | 规则 |
| --- | --- | --- |
| 数据库 `BIGINT UNSIGNED` ID | 十进制字符串 | 防止超过 `Number.MAX_SAFE_INTEGER`；不得在客户端转 number |
| 金币/CNY/USDT 最小单位金额 | 十进制整数字符串 | 字段名写单位，如 `amountCoins`、`amountFen`；不得用浮点金额 |
| 普通小范围计数/版本 | JSON integer number | schema 明确正数/非负范围；状态常量从 1 起 |
| 时间戳 | RFC 3339 / ISO 8601 UTC 字符串 | 例如 `createdAt`、`serverNow`；不传无时区本地时间 |
| 业务状态 | 领域常量字符串或非零常量 | 仅在现有项目领域已约定数字 enum 时用非零 code；0 仅可作为明确的筛选哨兵并在 server adapter 边界消解 |
| 可选值 | 字段省略或显式 `null`，由 schema 固定 | 一个字段不能在不同 endpoint 混用两种“无值”语义 |
| 字段命名 | camelCase | DB snake_case 由 mapper 转换，不暴露列名 |
| 二进制文件 | 独立 HTTPS asset/download endpoint | 不 base64 塞进普通 JSON DTO；asset 权限/加密按素材与客服 SDD |

DTO 只包含该调用者能看到并完成该 UI 所需的数据。列表与详情使用不同 DTO；私人牌局状态、TOTP/recovery secret、支付签名、代理隐私数据和管理审计内部 snapshot 不能顺手拼入通用 profile。

## 8. 列表、筛选、校验和错误细节

列表统一使用 `PageDto<T> = { items: T[]; nextCursor: string | null; hasMore: boolean }`；仅在确需显示总数且查询成本可控时定义 `totalCount`。游标不透明、签名或服务器可校验；客户端不能构造任意 SQL sort/filter。筛选字段由 endpoint schema 白名单列出；缺省 filter 用字段省略，数值 0 不作为业务状态或任意查询开关。

验证失败示例：

```json
{
  "requestId": "0c6dca6b-c1b9-4c9d-b9d3-1b39d3d302e4",
  "code": "REQUEST_VALIDATION_FAILED",
  "message": "请求信息有误，请检查后重试",
  "data": null,
  "serverNow": "2026-10-10T08:30:00.000Z",
  "details": [
    { "field": "/amountCoins", "code": "POSITIVE_INTEGER_STRING_REQUIRED", "message": "请输入有效的金币数量" }
  ]
}
```

`details.field` 是公开 DTO 的字段路径，不是 DB column。details 不回显密码、邮箱/手机验证码、token、全量账户/支付 provider 数据。授权失败不泄露隐藏资源是否存在；错误 message 不能替代客服/安全审计日志。

## 9. Socket.IO 与 HTTP DTO 的共用边界

HTTP 和 Socket.IO 可共用**相同业务 payload schema**，例如 `RoundSnapshotDto` 或 `WalletSummaryDto`；不能共用传输 envelope：

- HTTP response 用本文件 `ApiSuccess/ApiFailure`，HTTP status 是传输语义。
- Socket.IO command 用 `{ commandId, schemaVersion, payload }`，event 用 `{ eventId, schemaVersion, stateVersion?, payload }`；ACK 明确 accepted/rejected 与错误 code。
- Socket ACK 不复制 HTTP 的 `requestId/serverNow/data` envelope；如确需同一错误细节类型，可复用 `ApiErrorCode` 和 validation issue DTO。
- 共享 schema 要表达业务数据，传输特有的 auth header、ACK、HTTP status、Socket event name 留在 transport-specific contracts。
- Socket 重连快照若也由 HTTP 查询，返回的 `data` 可与 Socket snapshot payload 共用同一个 DTO schema；wrapper 仍各自独立。

## 10. OpenAPI 与客户端服务

endpoint registry 与 TypeBox schema 生成 OpenAPI 3.x 文档；CI 检查生成产物差异并阻止破坏性变更未经版本化。OpenAPI 既用于内部联调/后台 API 浏览，也可供客户端 SDK/type-safe service 生成；不手抄第三份 client interface。

前端 `platform-client` 只提供基础 `httpClient`（base URL、JWT 注入/刷新、requestId、超时、envelope parse）和按领域拆分的 API functions，例如 `walletApi.transferCoins()`。Vue 页面/Pinia feature 调用 typed API function；页面不直接拼 URL、不重复 DTO、不自行构造 server response。成功时 API function 返回 `Promise<TResponse>`；失败时抛出 `ApiClientError`，含 HTTP status、稳定 business code、requestId、safe message 和 validation details。业务页面按 code 映射本地化提示，不能解析数据库 error 或依赖 message 文本判断业务。后端 application use case 的预期业务拒绝使用[代码分层规范](./代码分层与接口实现规范.md)定义的 `Result`；HTTP adapter 统一将它映射到 status/envelope。

管理端使用单独 base URL/audience 和 `admin-contracts`；权限隐藏只优化 UI，服务端仍按 admin user permission/capability 校验每个 endpoint。

## 11. 安全和观测

- 请求/响应 schema 设置最大字符串长度、数组数量、分页上限和嵌套深度；拒绝未声明字段，避免 mass assignment。
- 日志记录 requestId、route template、HTTP status、business code、耗时和脱敏 actor ID；不记录 Bearer token、密码、TOTP、完整支付凭证/地址、客服附件密钥或完整私人 DTO。
- 面向客户端的 `message` 不依赖异常原文；完整 stack/cause 仅进入受控服务端日志并关联 requestId。
- 认证失败/权限失败仍维持统一 envelope；错误详情不暗示敏感资源是否存在。
- request body bytes/上传内容大小在 Koa middleware 与资产上传流程分别限额；媒体 binary endpoint 不绕过 asset ownership、CTR 加解密和授权下载规则。

## 12. 施工 Checklist

初始纵向切片已建立 `packages/contracts` 的 TypeBox health response schema，Koa `/api/v1/health/live` 与 H5 调用共享并运行时检查该 schema；这只验证 workspace→contracts→HTTP→H5 的边界，不代表以下完整协议清单已完成。

- ✅ 明确统一 HTTP status + `{requestId, code, message, data, serverNow}` 协议及错误/成功形状。
- ✅ 明确玩家与 Admin contracts 隔离、TypeBox 单一来源、DTO 静态推导、OpenAPI 生成方向。
- ✅ 明确 BIGINT ID/金额/时间/状态、分页、validation details、幂等重试和 Socket 共用 payload/独立 envelope。
- ⬜ 建立 `packages/contracts`、`packages/admin-contracts` 公共 schema 与 `Result`/错误 registry。
- ⬜ 选择并验证 TypeBox 到 OpenAPI 3.x 的生成器，生成 endpoint registry 与版本 diff 检查。
- ⬜ 创建 `httpClient` 与 Koa envelope/error middleware；覆盖 2xx/400/401/403/404/409/422/429/5xx 和结果未知重查。
- ⬜ 选转账、创建订单、round snapshot、Admin config publish 四条 endpoint 做 contract/e2e 测试，确认 body/schema/状态码/幂等行为端到端一致。
- 🟡 Identity settings、用户名/密码、邮箱/手机 challenge 与 TOTP setup/confirm/disable endpoint 已进入共享 TypeBox registry；登录响应使用 `SessionResponse | LoginChallengeResponse`，TOTP 登录接受 6 位动态码或 16 位备用码，备用码仅摘要存储且原子单次消费。Browser API 走统一 envelope 与 Bearer JWT；Koa handlers、生产速率限制和 OpenAPI 生成仍待补。
- 🟡 好友码/精确用户名查找、好友申请/通过、一对一文字私信的共享 Social DTO 与本地 JWT Browser API 已实现并通过双账号幂等恢复测试；生产 gate/域权限/Socket.IO 和游标仍待补。
- 🟡 邀请链接读取/签发与代理申请/撤回已登记共享 TypeBox DTO 和 JWT endpoint；Browser API 的 IP/Redis 归因及 Admin 审批仍由生产服务实现。

## 13. 关联文档

- [代码分层、接口与公共契约实施规范](./代码分层与接口实现规范.md)
- [技术架构决策说明](./技术架构决策说明.md)
- [架构评估与落地方案](./架构评估与落地方案.md)
- [后台与前台页面交互目录](../06_ux/后台与前台页面交互目录.md)
- [数据库设计规范与 Sequelize 方案](../05_data/数据库设计规范与Sequelize方案.md)

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-10-10 | 新增 HTTP 状态码、统一响应体、共享 DTO/schema、OpenAPI、幂等、序列化和 Socket payload 共用边界规范。 |
| 2026-10-10 | 记录 H5/API 探活纵向切片对共享 TypeBox schema 的初始验证，完整协议实现项继续保持未完成。 |
| 2026-10-13 | 登记平台公告共享 TypeBox schema、浏览器 API 访问器与 HTTP 路径；服务端与 Socket.IO 联调继续标为未实现。 |
| 2026-10-14 | 补充 Browser API Server 复用 endpoint registry/envelope 与 Koa contract comparison 的校验要求。 |
| 2026-10-15 | 登记 JWT 保护的钱包只读摘要 DTO 与金额单位，明确 Browser API 的离线适配范围及生产端尚未实现。 |
| 2026-10-15 | 补充 JWT 保护的本人钱包账本明细 endpoint、50 条上限、倒序和共享 DTO 定义；生产端保持待实现。 |
| 2026-10-15 | 补充账本明细的 ISO UTC+entry ID 复合游标及继续读取契约。 |
| 2026-10-15 | 登记共享 InviteLinkDto/AgentDomainDto 与登录保护的签发、查询、申请、撤回端点。 |
| 2026-10-15 | 补充钱包转账报价/提交共享 DTO 与状态码契约，明确 Bearer JWT、配置快照校验及生产端待接范围。 |
| 2026-10-15 | 增加金币兑换报价/提交 DTO 与 endpoint 契约，固定人民币分向下取整、流水/资金门禁、幂等提交及 Browser API/生产端边界。 |
| 2026-10-15 | 明确 Koa active announcements 当前只返回共享契约验证过的空列表，修复固定 404 的启动请求；持久公告、详情授权和 Socket 推送继续标记为未实现。 |
| 2026-10-14 | 登记 identity settings 的共享 TypeBox response DTO 与 Browser API endpoint 校验状态。 |
| 2026-10-14 | 补记 username/password identity commands 的共享请求 DTO、响应 DTO 和离线 API 验证范围。 |
| 2026-10-14 | 补记 contact challenge create/confirm 的 TypeBox DTO、动态 route 参数及 Browser API 离线闭环。 |
| 2026-10-14 | 登记 TOTP 设置/确认/关闭 endpoint、登录 challenge union DTO 与一次性备用码格式，记录 Browser API 本地 contract 测试范围。 |
| 2026-10-15 | 登记好友码/用户名查找、好友申请/通过/拒绝/删除与文字私信的共享 DTO、Bearer JWT endpoint 和 Browser API 离线实现边界。 |
| 2026-10-15 | 增加无持久化通知摘要读模型 DTO，明确多领域来源聚合、来源跳转与不提供跨领域统一已读。 |
| 2026-10-15 | 增加 SocialAccessResponseDto 与 `/me/social/access` contract，记录直属上级 reward_type 策略和离线 Browser API 的 403 门禁。 |
