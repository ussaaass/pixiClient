# 客服 IM 与用户工单设计

阶段：用户侧文本会话已完成 LOCAL_BROWSER_SERVER 离线纵向实现；生产客服、附件与后台坐席处理按下文继续施工。数据表字段以[数据库设计 SDD §客服 IM](../05_data/数据库设计SDD.md)为准，本文定义领域行为和前端流程，不重新设计表。

## 1. 范围与边界

客服 IM 属于 `support` domain，与社交私信完全隔离。首个用户侧切片支持账号与安全、充值与支付、提现、游戏和其他问题五类文本工单；每位用户可创建多个会话、查看历史、追加消息并主动关闭。TOTP 遗失用户可通过账号与安全工单申请人工身份核验。客服不能在此流程重置 TOTP 或恢复码。

本地离线流程使用 IndexedDB 模拟正式 HTTP endpoints 和数据库事务，不创建客服回复、不伪造在线坐席，也不改变资产、账号安全或支付状态。客服人员仍使用 `user` Admin 身份和 `support.*` 权限；生产操作、接单策略与审计按数据库 SDD 实现。

## 2. 状态与业务规则

状态常量均从 1 开始：

| 名称 | 值 | 允许动作 |
| --- | ---: | --- |
| `WAITING_SUPPORT` | 1 | 客户可读历史、追加消息或关闭；等待客服处理 |
| `WAITING_USER` | 2 | 客户可读历史、回复或关闭 |
| `CLOSED` | 3 | 只读；不能继续发消息，需新建工单 |

创建会话时，`support_conversation` 和第一条 `support_message` 同事务提交，状态为 `WAITING_SUPPORT`。客服回复后转 `WAITING_USER`；客户回复后转 `WAITING_SUPPORT`。相同 `message_key` 重试返回原消息，不能追加副本。关闭后消息保留，会话只读。列表和详情必须以 JWT subject 重新执行 `user_id` owner check，客户端不得提交 owner、sender type、客服指派人或未读计数。

类别常量与数据库一致：`ACCOUNT=1`、`PAYMENT=2`、`WITHDRAWAL=3`、`GAME=4`、`OTHER=5`。消息首版仅开放 `CUSTOMER=1` 的 `TEXT=1`；共享 DTO 的其它 sender/message type 由客服后台及资产附件切片实现，不能在用户端提前伪装可用。

## 3. 共享 HTTP 契约

DTO 唯一来源是 `packages/contracts/src/support.ts`，本地 dispatcher 和正式 Koa controller 必须共用同一 TypeBox schema 与统一 API envelope：

| HTTP | endpoint | 用途 | 权限与副作用 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/me/support/conversations` | 当前用户会话列表 | Bearer JWT；只返回 subject 所有会话 |
| `POST` | `/api/v1/me/support/conversations` | 创建会话与首条文本消息 | 幂等 messageKey；原子写 conversation/message |
| `GET` | `/api/v1/me/support/conversations/:conversationId/messages` | 按序读取完整历史 | Bearer JWT；越权与不存在统一 404 |
| `POST` | `/api/v1/me/support/conversations/:conversationId/messages` | 发文本消息 | `CLOSED` 返回 409；弱网沿用原 messageKey 重试 |
| `POST` | `/api/v1/me/support/conversations/:conversationId/close` | 用户结束会话 | 幂等关闭；历史保留 |

`SupportConversationDto` 返回 id、类别、主题、状态和创建/更新时间；`SupportMessageDto` 返回 message id/key、会话 id、sender、正文及时间。任何 DTO 不包含真实手机号、邮箱、JWT、密码或 TOTP 信息。服务端仍必须验证 body、会话成员、速率限制和权限；本机通过校验不是线上授权证明。

## 4. DDD 与依赖方向

```text
PlayerSupportWorkspace
  → SupportClientApplication
  → Support API port / shared TypeBox DTO
  → LOCAL_BROWSER_SERVER dispatcher
  → SupportUseCases
  → SupportRepository port
  → IndexedDbSupportRepository
```

页面只处理表单和视图状态。`SupportUseCases` 校验输入/输出、映射领域错误；repository port 定义按用户列表、会话读取、创建、发送、关闭。IndexedDB adapter 单事务保证建单首消息一致和幂等；transport dispatcher 处理 body/schema、JWT 与 status/envelope，不承载页面逻辑。生产 Koa adapter 实现相同 repository/use case 语义，不能复用浏览器数据库。

本地 IndexedDB 只增加两个适配器 stores，对应既有规范表 `support_conversation` 与 `support_message`，不引入新的产品实体表：`support_conversations` 按 user+更新时间读取，`support_messages` 按 conversation+时间读取并以全局唯一 messageKey 去重。v1/v2 用户数据升级至 v3 时保留原 store 内容。

## 5. 页面与失败闭环

客服面板状态如下：

1. 未登录：说明需先登录，按钮打开现有账号入口。
2. 已登录会话列表：显示主题、分类、更新时间和状态；空态可直接新建；列表读取失败有重试。
3. 新建：分类、主题、描述；取消保留编辑内容；提交后创建会话并进入详情。
4. 详情：读取消息、展示等待状态、发送文本、关闭。详情加载失败保留回列表入口；写入超时保留内容和原 messageKey，重试不会重复；服务端拒绝显示可处理结果。
5. 已关闭：保留历史但隐藏发送控件；提示新建工单继续。

面板提示用户不要发送密码、验证码或 TOTP secret，并说明客服不会重置 TOTP。客服文字、附件和人工核验凭证都不写入普通日志。UI 的“等待客服回复”是持久化会话状态，并不表示已经有坐席接单或承诺 SLA。

## 6. 附件、后台及实时消息后续闭环

用户已要求客服支持图片/附件并复用统一 `asset` 管理。Web 已增加可背压的 `ReadableStream` 分块加密/解密原语：每个文件独立随机 AES-128 与 HMAC-SHA-256 密钥，容器头记录版本/块长/块数/明文长度；每块计数器按最大块长预留不重叠 AES block 范围，HMAC 覆盖域分隔符、asset id、格式/分块元数据、计数器和密文。解密先验 HMAC、后输出明文；格式和密钥必须按 asset 单独管理，不可跨文件复用同一密钥组。该原语及篡改/截断/错误 asset id 测试已实现，但还没有资产密钥封装、Asset API、对象存储、消息附件引用、媒体渲染或客服授权解密；因此客服面板仍不显示无效上传控件。生产加密格式必须与数据库 SDD 的容器规范保持一致，并在客户端与后端契约锁定后才可发布。

Admin 坐席工作区已增加 LOCAL_DEMO 离线流程：用共享 `SupportConversationDto`/`SupportMessageDto` 投影队列，按状态/主题/脱敏用户摘要过滤、游标分页、读取文本历史、领取未分派会话、发送客服文本、结束与重新打开。客服回复沿用全局唯一 `messageKey`；相同 key 和内容重试返回现有会话快照，key 被不同消息复用则拒绝。领取/结束/重开动作使用 command requestKey 去重，复用 key 对应不同动作或会话会被拒绝。领取后才能回复或结束；其他客服已领取的会话在本机演练中只读。关闭保留历史，关闭记录可筛选后重新打开。会话/消息写入 Admin 专用 IndexedDB 的 `support_desk_conversations` / `support_desk_messages` adapter stores，操作幂等回执写入 `support_desk_command_receipts` adapter store，模拟现有会话、消息及 Admin 审计幂等边界；不读取或修改玩家端 Browser DB，也不代表真实用户工单。

客服坐席本地 application 通过共享 `SupportDeskEndpoint` DTO 清单预留 list/detail/claim/reply/resolve/reopen HTTP 契约；Admin UI 不直接操作 IndexedDB。当前 actor `90001`、三条样例会话及客服队列均为 LOCAL_DEMO fixtures。生产必须以 JWT 的 `user` 与 `support.*` capability 校验会话权限和当前指派人，Admin command 与 `admin_audit_event` 同事务提交；客服不能重置 TOTP、不能跨私聊域读取，也不能把客户端筛选作为授权依据。账号安全工单只提供转人工核验与关联入口，不执行凭证重置。

生产消息先持久化 MySQL 并写 outbox，再 ACK/Socket.IO 投递；断线用 HTTP 按 message id 补拉。LOCAL_BROWSER_SERVER 与 Admin LOCAL_DEMO 均使用 HTTP 顺序请求，不伪造 Socket 事件、真实坐席在线状态或玩家端实时收到客服回复。现阶段附件、Asset 密钥交付、授权解密、审计回执与上传失败续传仍未闭环，界面不展示无效附件按钮；生产坐席消息命令和实时送达仍待服务端实现。

## 7. 验收 checklist

- ✅ TypeBox DTO、HTTP endpoint registry 与统一 envelope。
- ✅ 本地 DDD：新建/列表/详情/发送/重试/关闭，状态和跨用户拒绝。
- ✅ IndexedDB v3 持久化，不伪造客服回复；已有身份与钱包数据保留。
- ✅ 用户客服面板无登录/空态/加载/失败/已关闭死路。
- ✅ Web AES-128-CTR/HMAC 分块 ReadableStream 原语及完整性失败测试（尚未接入 Asset 生命周期）。
- ⬜ PC 和窄屏移动设备的客服面板完整几何验收；Chrome MCP 当前只有桌面 viewport。
- ⬜ 客服附件的加密 Asset 上传、下载、客服授权解密及审计。
- ✅ Admin 本机演练队列、状态/关键字筛选、会话详情、领取、文本回复、幂等重试、关闭与重开；与玩家本机工单数据库隔离。
- ✅ Admin 共享 DTO runtime validation、IndexedDB 命令回执/消息去重；63 项 Admin 测试、类型检查和生产构建通过。Chrome 实测桌面 1200×2029：队列根 `1200/1200×2029/2029`、表容器 `831/831×186/186`；会话根 `1200/1200×2029/2029`、内容布局 `867/867×500/500`、消息列表 `548/548×263/263`，无根/内容溢出。
- ⬜ Admin 手机窄屏实际 viewport、客服详情内滚动和屏幕阅读器几何/键盘验收；当前 Chrome MCP 只提供桌面 viewport。
- ⬜ Admin/客服 JWT capability 与会话指派授权、管理审计事务、人工安全核验工单关联及真实服务端队列。
- ⬜ Koa + MySQL/Sequelize + outbox + Socket.IO 生产联调及断线补拉。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-10-15 | 新增客服文本工单领域 SDD，校准共享契约、状态、DDD 边界、用户交互闭环与附件/坐席/实时投递待办。 |
| 2026-10-15 | 记录客户端分块加密原语的实现边界与测试状态；Asset 上传、密钥托管、客服授权查看仍未闭环。 |
| 2026-10-15 | 增加 Admin 坐席本机 DDD 演练流程与共享队列 DTO；标记生产 capability、事务审计、附件解密及 Socket 投递待服务端实现。 |
| 2026-10-15 | 补齐坐席流程的状态筛选、动作幂等回执、实际浏览器桌面队列/会话几何与 62 项测试验收；移动实机与服务端授权仍待完成。 |
| 2026-10-15 | 补充坐席游标分页、未领取回复的明确下一步提示，并让失败后的动作重试保留原 requestKey。 |
| 2026-10-15 | Admin 测试增至 63 项，覆盖工单游标分页的无重复读取。 |
