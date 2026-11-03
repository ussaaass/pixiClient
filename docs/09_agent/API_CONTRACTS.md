# API 契约速查

完整协议见 `docs/02_architecture/HTTP接口与共享DTO协议SDD.md`（本文不复制全文，登记现状与落点）。

## 1. 组织

- 玩家前缀 `/api/v1/`；Admin 前缀 `/admin-api/v1/`（独立 audience/权限，未实现）。
- DTO/schema 唯一来源：`packages/contracts`（玩家）与 `packages/admin-contracts`（后台），TypeBox `Type.*` + `Static<>`，按 subpath 导出（各包 `package.json` 的 `exports` 即端点清单）。
- 统一 envelope（`packages/contracts/src/common/api-envelope.ts`）：

```ts
ApiSuccess<T> = { requestId, code: 'OK', message, data: T, serverNow }
ApiFailure    = { requestId, code: ApiErrorCode, message, data: null, serverNow }
```

不使用 204；404 兜底也走失败 envelope。错误码注册表：`packages/contracts/src/common/api-errors.ts`。

## 2. 约定（实施时逐条遵守）

- 金额与 BIGINT ID 一律十进制字符串；日期 ISO 8601 UTC；业务幂等键（UUID）与每次 HTTP attempt 的 requestId 分离。
- 外部输入必须经 schema 运行时校验后才进领域用例；客户端校验不替代服务端校验。
- 响应禁止泄露 ORM 实例、DB row、Redis key、未授权字段。
- 兼容规则：同 major 内只允许向后兼容变更；改单位/必填/枚举语义须升 `/v2`。
- 分页：游标式（如 wallet activity 用 entry ID + ISO 时间复合游标，单次 ≤50 条）。

## 3. 已登记端点（Koa 现状 vs 契约）

| 端点 | 契约位置 | Koa 实现 | 说明 |
| --- | --- | --- | --- |
| `GET /health/live`、`GET /health/ready` | `contracts/health.ts` | ✅ `apps/server/src/app.ts` | ready 503 时暴露 checks |
| `GET /platform/announcements/active` | `contracts/platform-events/announcement.ts` | ✅ 返回空列表 stub | 持久化/受众过滤/详情未实现，不得视为公告闭环 |
| `GET /games`、`/games/experience`、`/games/:gameKey/experience`、`/games/:gameKey/difficulties/:difficultyKey/preflight` | `contracts/game-catalog.ts`、`game-experience.ts` | ✅ 代码内 LOCAL_DEMO 快照 | preflight 只对 `LOCAL_PRACTICE` 且可玩游戏返回 READY |
| wallet 摘要/明细/转账/兑换/提现 | `contracts/wallet.ts` | ❌ 仅浏览器 LOCAL 适配器 | 生产 Koa/事务待接 |
| identity（登录/设备/TOTP/恢复凭证） | `contracts/identity.ts` | ❌ 仅 LOCAL_BROWSER_SERVER | 服务端 JWT 签发待接 |
| social / support / invite-agent / coin-market / notifications | 各 subpath | ❌ 仅浏览器 LOCAL | 服务端 handler、Socket.IO、限流待接 |

## 4. 新增 DTO 的规则

1. 放进 `packages/contracts`（玩家）或 `packages/admin-contracts`（后台），在 `package.json` `exports` 注册 subpath。
2. `additionalProperties: false`；ID/金额字符串 schema 用 `common/primitives.ts` 现成模式。
3. 非零状态常量集中定义在该领域文件，不跨域复用数字含义。
4. 同步写 schema 契约测试（参照 `packages/contracts/src/contracts.test.ts`）；破坏性变更升级 schema 版本字段。
5. 浏览器消费方经 `apps/web/src/platform/http/api-client.ts` 的端口注入模式调用，不直接 fetch。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-02 | 新建：登记 envelope/幂等/分页/兼容约定、Koa 已实现端点与契约差距、新增 DTO 流程；全文口径以 HTTP SDD 为准。 |
