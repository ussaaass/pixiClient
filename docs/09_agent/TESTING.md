# 测试体系速查

## 1. 框架与位置

| 包 | 框架 | 位置 | 命令 |
| --- | --- | --- | --- |
| `apps/web`、`apps/admin`、`packages/*`、`games/shisanshui/rules` | Vitest 5 + Happy DOM（web/admin） | 就近 `*.test.ts`（`vitest.config.ts` 固定 4 worker） | `pnpm --filter <pkg> test`；`test:related <file>` 文件级 |
| `apps/server` | `node --test` + tsx | `apps/server/src/app.test.ts`（HTTP 契约）、`migrations.test.ts`（`MIGRATION_TEST=1` 才跑真实 MySQL 建表/回滚） | `pnpm --filter @gameing/server test` |
| `tools/asset-generation` | `node --experimental-strip-types --test` | `src/*.test.ts` | `pnpm --filter @gameing/asset-generation test` |
| `games/shisanshui/rules` | Vitest（纯函数，低内存） | `src/index.test.ts`、`src/simulation.test.ts` | 随包 test |

全仓：`pnpm test`（顶层串行）；全量门禁 `pnpm docker:check`。

## 2. 约定（来源：`docs/02_architecture/代码分层与接口实现规范.md` §13）

- Domain 纯函数/策略：测边界、不变量、非零状态、精确整数金额；不启动 DB/Redis。
- Application 用例：fake/stub ports 测成功/业务拒绝/幂等/回滚。
- Sequelize adapter：MySQL 集成测试（锁、唯一约束、migration），不可只 mock ORM。
- HTTP/Socket 契约：schema、鉴权拒绝、错误映射、重试保持 command ID。
- 浏览器 feature：测公开 DTO 消费与会话过期 UI；离线 adapter 测试不得计作服务端联调证据。
- 资产不变量：每新增一种流水类型必须补账本平衡断言与对账口径。

## 3. 已知缺口（截至 2026-11-02）

- 无 E2E/负载/弱网测试目录（规划在 `tests/`，未建）。
- 迁移集成测试默认跳过，需 `MIGRATION_TEST=1` + 真实 MySQL。
- 服务端业务用例尚无可测代码（P0 只有 health/目录路由），P1 用例层需按上表补测试。
- CI 耗时受机器负载影响，4-worker 改动未在健康机器验证（见 `docs/02_architecture/从原型到产品级的实施路线.md` P0 执行状态表）。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-02 | 新建：登记各包测试框架/位置/命令与测试-层对应约定，列出已知覆盖缺口。 |
