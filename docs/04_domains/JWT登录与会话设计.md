# JWT 登录与会话设计

用户已确定登录采用 JWT。本文为实现规划；时长、签名算法和重试窗口为建议值，正式初始化时核实依赖与性能并锁定。

## 1. 账号入口与令牌

设备凭证、用户名密码、已验证邮箱/手机恢复及密码保护二维码恢复都由 identity 验证，成功后统一签发 JWT access token，不因采用 JWT 改变稳定 userId 或把 IP 当登录凭证。

建议 access token 有效期 10 分钟，refresh token 空闲有效期 7 天、会话绝对寿命 30 天，通过配置管理。刷新凭证建议采用随机不透明令牌、服务端存验证摘要和轮换状态；JWT 用于访问认证，刷新不要求同样使用 JWT。若后续要求刷新也采用 JWT，仍须保留服务端轮换记录，不能只验签刷新。

JWT 必须校验固定允许的签名算法、签名、iss/aud/sub、exp/nbf、令牌类型及对应 key；kid 仅索引预配置可信密钥，不能按令牌内地址下载任意密钥。建议采用 ES256 非对称签名，私钥只在发行端；新旧密钥重叠窗口覆盖最大访问寿命。具体算法为技术建议。[RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html)

访问 claims 建议 `{iss,aud,sub,sid,did,jti,iat,nbf,exp,sessionVersion,tokenUse}`。不包含余额、邮箱手机号、登录密码、设备秘密或长期生效的代理权限；签名 JWT 不保证内容保密。游戏角色/返佣模式以当前服务端数据判定，不因旧 JWT 固定为永久有效。[OWASP JWT](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_Cheat_Sheet.html)

## 2. HTTP、浏览器与 Socket.IO

浏览器 access token 保存在内存，通过 Authorization Bearer 提交 HTTP；refresh token 使用同站 Secure/HttpOnly Cookie，刷新接口校验 Origin/CSRF，设置适当 SameSite，HTTP 私有响应 no-store。页面刷新通过刷新接口取得新 access token，不依赖 localStorage 保存登录令牌。App 通过平台安全存储管理刷新凭证，仍使用相同 JWT 验证流程。

Socket.IO 使用握手 auth.accessToken，不放 URL query。连接建立及恢复时验证当前会话；每条受保护命令检查该连接认证的过期时间和会话有效性。连接不能因为已建立而永久授权，也不需要在每条消息重复发送 JWT。

客户端提前 HTTP 刷新，并通过具名 `session.reauthorize` 命令提交新 access token；成功后服务器更新当前连接认证上下文，保留同一 sid/userId，重新授权订阅。过期前刷新失败则停止受保护操作并重连认证；本地可继续理牌，但提交仍须认证且不延长截止时间。登出/封禁主动断开相应 Socket，禁止使用恢复机制跳过验证。鉴权失败可重试原 commandId，不能新建操作造成重复入账。

## 3. 轮换、撤销与弱网

玩家与 Admin 的短期 session/刷新令牌状态放 Redis，不在 MySQL 建 `session`、`refresh_credential`、`admin_session` 或 `admin_refresh_credential` 表。Redis session 保存统一的 `user_id`（Admin 同样使用该 ID）、`principal_type`、`device_id`（玩家会话）、令牌家族、authVersion、到期/状态和 refresh token 摘要；只保留高熵刷新令牌的 keyed hash，不存明文。所有 Redis key 有 TTL。每次刷新通过 Lua/原子操作比较当前摘要、原子轮换并推进序号；已消费凭证被不同操作再次使用时撤销该 session 并记持久安全事件。[RFC 9700 刷新令牌保护](https://www.rfc-editor.org/rfc/rfc9700.html)

刷新采用客户端单飞：同一页面/多标签协调一个操作 ID，取消重复并发请求。弱网下服务器成功轮换但响应丢失不能直接判为攻击：推荐限定 30 秒的同凭证+同 operationId 重试记录，受保护保存原返回结果，只重放同一代，不生成多条后继。窗口外或不同 operationId 的复用按异常处理；重试记录单独限制权限、保留期限并隐藏日志。该机制是项目设计，不是标准自动提供的功能。

Redis 是活动会话与刷新轮换状态的权威存储；user.auth_version 是 SQL 里的长期账号安全版本。创建 session 时复制版本；改密、账号恢复、全设备退出等操作递增 auth_version、更新 Redis 用户版本并撤销相关 session。凡保护请求验签后均检查 session 仍有效且版本相同；Socket 撤销主动断开。Redis 不可用时受保护请求失败关闭。Redis 完整丢失使所有活动 session 失效、用户重新登录，但账号、设备凭证、资产与安全审计不丢失。登出产生的 security event 写 SQL，session_key 是不透明 Redis 标识而不是 MySQL 外键。

安全变更提交后必须同步完成 Redis 版本更新/撤销才向调用端报告成功；以 SQL outbox 处理进程中断后的幂等重试。该跨存储窗口应在落地时用故障注入核实，不能把 Redis 会话镜像进 SQL 假装两者同事务。

更改密码、二维码恢复、设备撤销分别定义撤销范围；账号通过二维码恢复后撤销旧会话并创建新 sid，但二维码凭证仍可重复使用，直至被新二维码替换、主动撤销或过期。玩家和 Admin 使用不同 audience/令牌类型；TOTP 对所有 user（包括 Admin）均为自愿选项，不设强制启用策略。玩家 role_type 不授予 Admin 访问权。

开发阶段的浏览器内 API 与 IndexedDB 会话不改变上述生产规则。`LOCAL_BROWSER_SERVER` 可签发结构符合共享 Session DTO 的本地 JWT，但使用独立 issuer/audience 和本地 key；生产服务必须拒绝此 token。浏览器 IndexedDB 的 session 仅用于体验客户端路由、刷新和登出状态，不测试 Redis 撤销、HttpOnly cookie 或线上认证安全。细节见[浏览器开发服务器与 IndexedDB 适配器 SDD](../02_architecture/浏览器开发服务器与IndexedDB适配器SDD.md)。

## 4. 接口与验收

规划 `POST /auth/device-register`、`/auth/device-login`、`/auth/password-login`、`/auth/refresh`、`/auth/logout`、`/auth/recovery` 和已授权的设备/会话列表撤销接口。首次访问没有设备凭证时自动注册并建立会话；注册 workflow 按每个账号一次、幂等调用新用户赠币用例，不增加设备/IP 级额外限制，也不承诺识别同一自然人跨账号重复注册。后续启动使用 device-login，不再次发奖。错误码常量化，区分过期、已撤销、刷新复用、无权限和重试结果未知。新密码默认最少 8 位，服务端身份领域负责验证。

验证算法/issuer/audience 错误均拒绝；刷新响应丢失仅重放一次既有结果；多标签不触发随机登出；封禁和登出影响 HTTP 与 Socket；过期 Socket 不能继续提交资产命令；JWT 不进入日志、公开资源或二维码；旧 access token 不绕过资产操作的撤销门禁。时长和缓存窗口通过压测调整，不能以两万人在线为由省略撤销设计。

## 5. 联系方式换绑与可选 TOTP

邮箱或手机号换绑必须先绑定并验证新的邮箱/手机号。同类换绑只替换对应字段并保留另一种联系方式；改用另一种类型时，先验证新值，再于同一事务写入新值并释放旧值。旧值随提交立即可由他人注册/绑定；这不会转移原账号、资产或代理关系。换绑需要当前会话重新认证；账户启用了 TOTP 时还需当前验证码。验证码挑战放 Redis，短时、单次、限速；安全事件记录脱敏新旧值。

可选 TOTP 采用 RFC 6238 兼容认证器。启用流程先在 Redis 短暂保存待确认密钥，展示一次性 otpauth QR；用户输入有效码后才将 secret 加密存入 `user.totp_secret_ciphertext` 并设置启用时间。建议采用标准 30 秒时间步；校验限定很窄的时钟偏差窗口，并原子推进 user 的最后接受时间步，避免重放。密钥不得进入日志、分析事件、普通账号恢复 QR 或客户端持久存储。启用成功后同时生成一组一次性备用恢复码，建议 10 个，每码至少 80 位随机熵；明文只在本次设置完成页展示一次，提示用户离线保存，不通过邮件/短信发送。数据库在 `user.totp_recovery_code_hashes` 保存逐码哈希，不保存明文；验证失败限速，成功后在事务/行锁下原子消费对应码并写 `user_security_event`。关闭 TOTP 或重新生成整组恢复码均须当前密码 + 当前 TOTP；恢复码不能关闭、替换或重置 TOTP。所有角色均可选择启用或不启用。[RFC 6238](https://www.rfc-editor.org/rfc/rfc6238) [NIST SP 800-63B-4：恢复码](https://pages.nist.gov/800-63-4/sp800-63b.html)

登录时，已启用 TOTP 的用户可提交当前 TOTP，或提交一条尚未使用的备用恢复码作为该次登录的二次验证。使用恢复码会消耗该码并向账号已验证联系方式发送安全通知；TOTP 仍保持启用。备用恢复码只用于登录挑战的单次替代验证，不能用于账号恢复二维码、TOTP 关闭/重绑或其他敏感操作。账号恢复二维码仍要求当前 TOTP；无法提供 TOTP 时，按用户既定要求转客服 IM 人工核验，Admin 处置必须关联客服会话并记安全事件/后台审计。具体身份核验步骤由客服运营流程规定。


## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-10-10 | 按项目约束新增变更历史区块；未改动原有正文。 |
| 2026-10-10 | 按文档性质归档并更新相关链接。 |
| 2026-10-14 | 补充浏览器开发服务器 JWT 与生产会话的 issuer/audience 隔离边界。 |
| 2026-10-14 | 按用户决定加入首次访问自动设备注册、注册时幂等调用新用户赠币，并确定新密码默认最少 8 位。 |
| 2026-10-14 | 明确新用户赠币按账号一次，不添加设备/IP 级额外限领或跨账号自然人识别。 |
