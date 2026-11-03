# P1 施工单：用例层下沉（路线文档决策 A/B 落地）

本文登记"把 `apps/web` 的领域用例层下沉到 `packages/domain`、按端点分批双轨切换 browser-api"的施工拆解。路线文档中的 1-2 周重构**不在本次一次性完成**；本文是它的可验收施工单，按 §3 的顺序执行。

## 1. 范围（已核实 2026-11-02）

`apps/web/src` 下 14 个 `-application.ts` / `-use-cases.ts` 文件，共 ~1859 行：

| 文件 | 行数 | 特征 | 下沉策略 |
| --- | --- | --- | --- |
| `platform/wallet/wallet-application.ts` | 106 | `WalletUseCases` 类 + `WalletRepository` 接口，只 import `contracts` + TypeBox `Value` | **纯下沉**到 `packages/domain/src/wallet/wallet-application.ts`，零改动 |
| `platform/support/support-application.ts` | 118 | 同上，纯契约 + `Value.Check` 校验 | 纯下沉 |
| `platform/rooms/room-application.ts` | 144 | 房间查询/动作编排 | 纯下沉 |
| `platform/social/social-application.ts` | 204 | 好友/私信编排 + 访问策略调用 | 纯下沉（依赖已下沉的 `social-domain`/`social-access-policy`） |
| `platform/social/social-friends-use-cases.ts` | 185 | 纯用例工厂 | 纯下沉 |
| `platform/social/friends-application.ts` | 50 | 依赖 `social-message-asset-application`（本地资产加密） | 需先处理资产依赖 |
| `platform/assets/social-message-asset-application.ts` | 80 | 依赖本地 `asset-encryption` | 暂不下沉（浏览器能力，保留在 web） |
| `platform/notifications/notification-summary-application.ts` | 98 | 纯投影，多来源拉取 | 纯下沉 |
| `platform/invite-agent/invite-agent-application.ts` | 25 | 薄 | 纯下沉 |
| `platform/player-entry/player-entry-application.ts` | 195 | 含玩家入口编排 | 纯下沉 |
| `platform/preferences/client-preference-application.ts` | 62 | 偏好读写（localStorage 适配器在别处） | 纯下沉 |
| `referral/referral-attribution-application.ts` | 54 | 邀请归因 | 纯下沉 |
| `wallet-funding/wallet-funding-application.ts` | 43 | 充值订单模拟 | 纯下沉 |
| `platform/browser-api/identity/local-identity-application.ts` | 495 | **强浏览器依赖**：IndexedDB、TOTP、crypto、recovery QR | **不下沉**（LOCAL_BROWSER_SERVER 专属，保留在 web） |

纯下沉文件合计 ~1200 行，是 P1 的第一批；`local-identity-application` 与 `social-message-asset-application` 按路线文档 B 的"按端点分批切换"留作第二批。

## 2. 已完成的低风险项（2026-11-02）

- ✅ `main.ts` 的 `readinessChecks` 已登记 `mysql` / `redis` 两个探针（`apps/server/src/infrastructure/database/mysql-probe.ts`、`apps/server/src/infrastructure/redis/redis-probe.ts`）；`config.ts` 新增 `readDatabaseConfigPermissive` 供探针在凭证缺失时返回安全原因而非抛异常。
- ✅ `apps/server/src/readiness-probes.test.ts`：3 个测试全过（`node --import tsx --test`，2026-11-02 实测 pass 3 / fail 0）。
- ✅ OpenAPI 生成器落地：`packages/contracts/src/openapi/registry.ts`（端点注册表 + ~30 行 `toOpenApiSchema` 拼装器）+ `packages/contracts/openapi.mjs` 生成器 + `package.json` 的 `openapi` / `openapi:check` 脚本 + `.github/workflows/ci.yml` 第七关。`packages/contracts/tsconfig.json` 类型检查 0 error。
  - ⚠️ **未验证**：`pnpm install` 在本机不可用（npm 缓存权限问题 + pnpm 未装），`openapi.mjs` 未实际运行生成 `dist/openapi.json`；`tsx` 已加为 contracts devDependency 但 lockfile 未更新——需在 dev 容器内 `pnpm install` 后跑一次 `pnpm --filter @gameing/contracts openapi` 验证。
- ✅ 强化 `docs/09_agent/PROJECT_STATUS.md` 的"施工后必更"纪律（§4）。

## 3. 待办（按顺序）

1. **容器内安装与验证 OpenAPI 生成器**（半天）：`docker compose --profile dev run --rm dev pnpm install`，然后 `pnpm --filter @gameing/contracts openapi` 生成产物并确认可被 Swagger Editor 解析；`openapi:check` 在 CI 上通过。
2. **纯下沉第一批（✅ 2026-11-02 完成 + 容器验证）**：12 个 application 文件已移入 `packages/domain`，`apps/web` 改为 `@gameing/domain/*` import；`packages/domain` 新增 `@sinclair/typebox` 依赖 + 12 个 subpath 导出。
   - **容器内全量验证（2026-11-02，`pnpm install` 后逐门跑）**：
     - `pnpm install`：lockfile 已更新（`tsx@4.23.15` 进 contracts，`@sinclair/typebox@0.34.52` 进 domain，+ pnpm 自动 bump 的 `supports-color` 可选依赖链）。
     - `pnpm lint`（packages/games/server）：✅ 0 errors。
     - `pnpm lint:apps`（web/admin）：✅ 81 warnings / 0 errors（均为存量 warning，非本次引入）。
     - `pnpm format:check`：✅ 全部 Prettier 合规。
     - `pnpm typecheck`（逐包顺序跑）：✅ 8 包全绿。注：`pnpm recursive run typecheck` 并行跑会触发容器 OOM SIGKILL（预存问题，P0 基线同样存在），CI 用 `pnpm typecheck` 即根脚本递归，需关注容器内存上限。
     - `pnpm test`：✅ 全绿（web 149/149、admin 101/101、domain 11/11、contracts 10/10、server 19/19、rules 8/8、client 10/10）。
     - `pnpm build`（逐包顺序跑）：✅ server 产物 9702.9 KiB；web 471.27 kB；admin 通过。注：根 `pnpm -r build` 并行跑会 OOM，同 typecheck。
     - `pnpm --filter @gameing/contracts openapi`：✅ 生成 `dist/openapi.json`（7 路径）。
     - `pnpm --filter @gameing/contracts openapi:check`：✅ in sync。
   - **修复项**：`apps/server/scripts/build.mjs` 加 `external: ['pg','pg-hstore','oracledb','snowflake-sdk','sqlite3','mariadb','ibm_db']`——Sequelize 内置多 dialect，P0 基线有意从 lockfile 移除非 MySQL peer，esbuild 必须标记 external 否则 bundle 阶段解析 postgres dialect 报错。
   - **`pnpm-lock.yaml` 已更新（保留 `tools/ui-audit` importer section）**：`tools/*` 在 `pnpm-workspace.yaml` 中，`tools/ui-audit/` 有 `package.json`，pnpm 将其识别为合法 workspace 成员，`importers["tools/ui-audit"]` section 是 `pnpm install` 的自然产物。CI 检出 git 仓库时无该目录，pnpm 对缺失的 importer 条目容忍（仅忽略），frozen install 不受影响；本机目录存在则 frozen install 也通过。
3. **第二批双轨切换（暂缓，见 §5）**：`local-identity-application`、`social-message-asset-application` 与 LOCAL_DEMO/REMOTE 端点分批切换，最后删 `browser-api/`。启动条件为后台代码开写；在此之前本地腿保持现状，不另开施工单。
4. **更新路线文档 P1 状态表**：把"用例层未下沉"改成分批进度。

## 4. 红线

- 下沉只移动代码与 import，**不改任何业务规则**（5% 手续费、10/8/5/3 返点、流水门槛等保持不变）。
- 每个下沉文件必须保留原有单测（`apps/web` 里的 `*-application.test.ts` 同步迁移，改为 fake repository 测试）。
- 不新建 `common/utils`；TypeBox `Value.Check` 校验保留在用例入口（与"外部输入必须运行时校验"一致）。
- `packages/domain` 仍不得 import DOM/Node 全局；`localStorage` 等保持可注入模式。

## 5. 双轨现状与启动条件（2026-11-03 用户确认）

双轨是**设计需要**：前后端目前**不同步开发**，本地腿（`browser-api/`）在后台业务代码开写前是唯一可验收的执行路径，**不得提前退役**。因此：

- 第二批（`local-identity-application` 495 行 + `social-message-asset-application` 80 行）**暂缓**，**不另开施工单**；
- 启动条件：后台（`apps/server`）开始写 identity / 资产 / 消息端点（即后台代码开写）后，按端点分批双轨切换，最后一次性删 `browser-api/`；
- 在此之前，LOCAL_DEMO / LOCAL_BROWSER_SERVER 模式保持现状，web 侧只继续吃第一批下沉的 `@gameing/domain/*` 导入。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-02 | 新建：登记用例层下沉的逐文件核实结果（14 文件/~1859 行）、已完成低风险项（readiness 探针 + OpenAPI 生成器）、待办顺序与红线。 |
| 2026-11-02 | 第一批纯下沉完成：12 文件移入 `packages/domain`，加 `@sinclair/typebox` 依赖与 12 个 subpath 导出，`apps/web` 改为 `@gameing/domain/*` import；domain 11/11、web 149/149 测试与三包 typecheck 全绿；标注需 `pnpm install` 以建立新链接。 |
| 2026-11-02 | 容器内全量验证：`pnpm install` 更新 lockfile（tsx/typebox），8 门逐包顺序跑全绿；修 `apps/server/scripts/build.mjs` 加 Sequelize dialect external（预存问题）；OpenAPI 生成器 + check 实测通过。 |
| 2026-11-03 | 用户确认双轨为设计需要（前后端不同步开发），第二批切换暂缓至后台代码开写后启动；§5 登记启动条件，不另开施工单。 |
