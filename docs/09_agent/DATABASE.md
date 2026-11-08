# 数据库与迁移速查

规范全文见 `docs/05_data/数据库设计规范与Sequelize方案.md`（权威）与 `docs/05_data/数据库设计SDD.md`（实体字段）。本文只登记现状与操作纪律。

## 1. 技术栈

- MySQL 9.7.2（compose `external` 具名卷 `gameing-hall-pixi_mysql_data`）。
- Sequelize 6.37.8 + mysql2 3.24.6；迁移 Umzug 3.8.3 + 自定义 `migration_history` 存储（UP/DOWN + checksum），不使用 `sync()`、不使用默认 SequelizeMeta。
- 实例与迁移器：迁移链 0001~0022 在 `packages/backend/src/infrastructure/database/`（`migrator.ts` 22 项注册 / `config.ts` / `migration-history-storage.ts` / `mysql-probe.ts`）；`apps/server` 仅保留 `sequelize.ts`（Sequelize 实例）+ `mysql-probe.ts`（进程健康探针），迁移 CLI 为 `@gameing/backend` 迁移器的薄壳（见 `apps/server/src/cli/migrate.ts`）。

## 2. 全表硬约束（写迁移/模型时逐条检查）

- `id BIGINT UNSIGNED` 自增主键；`status` 非零 SMALLINT UNSIGNED；`created_at/updated_at/deleted_at DATETIME(3)`（未删除 deleted_at 为 NULL）；全字段非空有效 COMMENT；表名小写 snake_case 单数。
- 引用字段 `abc_id`；同表多角色 `<role>_<table>_<...>`，如 `parent_1_user_id`、`admin_user_id`。
- 金额/余额为有符号精确整数（BIGINT 有符号），ID 的 UNSIGNED 约束不套用到资产值。
- 不可变流水/审计（asset_operation、asset_entry、admin 审计等）：禁止 destroy/update 路径，`deleted_at` 恒 NULL、`updated_at` 固定等于 `created_at`。
- 常量/枚举（含 status 取值）禁止 0。

## 3. 迁移登记（0001~0022 已在此前/本轮对 compose MySQL 验证；0022 验证时间 2026-11-08）

| 迁移 | 表 | 要点 |
| --- | --- | --- |
| 0001 | `migration_history` | Umzug 自定义存储，记录 UP/DOWN 与 checksum |
| 0002 | `user` | 统一身份（role_type/reward_type/邀请码/TOTP/permissions JSON） |
| 0003 | `asset_account` | COIN/CNY 双账本账户 |
| 0004 | `asset_operation` | 记账幂等根：operation_key + request_hash，RECORDED=1 不可变 |
| 0005 | `asset_hold` | 冻结额度 |
| 0006 | `asset_entry` | 分录（转出/转入），挂同一 operation |
| 0007~0018 | 57 张领域表 | 批次见 `docs/02_architecture/后端实施SDD.md` §3.1（identity 扩展/大厅配置/管理审计/资产支付/链到账/返佣/房间/社交/客服/集市/AI 资产/outbox），逐表字段与约束见 `docs/05_data/数据库设计SDD.md` §5 |
| 0019 | Admin Support permission seeds | 新增 `admin.support.claim` 和 `admin.support.resolve` 对应的 method/path 目录项；已在此前施工完成（本轮未重跑 migration suite）。 |
| 0020 | Admin permissions audit idempotency | 对 `ADMIN_PERMISSIONS_UPDATED` 的 `(action_code, request_key)` 建唯一索引；迁移 fail closed，不改写历史审计；Docker MySQL up/status/down/up/status 已通过。 |
| 0021 | `registration_operation` | 注册操作幂等墓碑：全局唯一 `key` 与 `request_hash`，可选 user/device RESTRICT 外键；仅认证加密响应密文最长 24 小时，重试时惰性清空，墓碑永久保留；Docker MySQL up/status/down/up/status 已通过。 |
| 0022 | `registration_operation.session_id` | 把完成注册的重放密文关联至对应 sid，登出时持久清除密文；新增索引；Docker MySQL up/status/down/up/status 已通过。 |

跨批次外键补建：批次内只建列、目标表所在批次 up 末尾 `ALTER TABLE ADD CONSTRAINT`（down 配对 `DROP CONSTRAINT`），如 0013 补 `game_event_instance.source_round_id→round`、0017 补 `user.asset_id→asset` 等。修改既有迁移会改变 checksum，迁移器拒绝静默覆盖；必须新增迁移。

## 4. 操作纪律

- 迁移命令：`docker compose --profile dev run --rm dev pnpm --filter @gameing/server migrate [up|down|status]`（需 compose 已启动 MySQL；CLI 委托 `@gameing/backend` 的全链 0001~0022 迁移器）。
- 迁移集成测试：`MIGRATION_TEST=1` 才运行（默认跳过），在目标库建表并回滚验证。
- 修改既有迁移会改变 checksum，迁移器拒绝静默覆盖；必须新增迁移。
- DDL 不能以 ORM 事务包裹宣称“整批可回滚”；新增/回填/切换/移除分迁移走。
- 大 ID 经 mysql2 以字符串读取；禁止先转 JS Number。写 repository 前参照 SDD §5 验收清单。
- 事务边界：应用用例定义原子边界；跨域用同一 opaque `TransactionScope`（SDD 全文在 02_architecture 代码分层规范 §9）。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-02 | 新建：登记 0001~0006 迁移现状、全表硬约束速查与迁移操作纪律；口径以 05_data 两份 SDD 为准。 |
| 2026-11-03 | 更新为 0001~0018 全链：迁移基础设施（migrator/迁移文件/history storage）迁入 `packages/backend`，server 保留 Sequelize 实例与探针、迁移 CLI 为薄壳；§3 登记 0007~0018 十二批次 57 张表与跨批次外键补建约定。 |
| 2026-11-08 | 新增 migration 0019 注册 Support claim/resolve 的 Admin permission codes；Docker MySQL migrate up/status/down/up/status 成功，server migration suite 18 passed / 1 skipped（独立 CoinMarket schema opt-in）。 |
| 2026-11-08 | 新增 migration 0020，对 `ADMIN_PERMISSIONS_UPDATED` 使用 `(action_code, request_key)` 唯一索引以防变更命令重放重复；MySQL up/status/down/up/status 已验证。 |
| 2026-11-08 | 新增 migration 0021 `registration_operation` 注册重放账本；永久保留唯一幂等键与请求摘要，仅短期保存加密响应（24 小时后由重试惰性清空）；MySQL up/status/down/up/status 已验证。 |
| 2026-11-08 | 新增 migration 0022，将已签发 sid 持久关联至注册 replay tombstone，以便登出清除加密重放密文；Docker MySQL up/status/down/up/status 通过；logout/replay focused regression 与 backend/server typecheck 通过。 |
