# 数据库与迁移速查

规范全文见 `docs/05_data/数据库设计规范与Sequelize方案.md`（权威）与 `docs/05_data/数据库设计SDD.md`（实体字段）。本文只登记现状与操作纪律。

## 1. 技术栈

- MySQL 9.7.2（compose `external` 具名卷 `gameing-hall-pixi_mysql_data`）。
- Sequelize 6.37.8 + mysql2 3.24.6；迁移 Umzug 3.8.3 + 自定义 `migration_history` 存储（UP/DOWN + checksum），不使用 `sync()`、不使用默认 SequelizeMeta。
- 实例与迁移器：`apps/server/src/infrastructure/database/`（`sequelize.ts` / `migrator.ts` / `config.ts` / `migration-history-storage.ts`）。

## 2. 全表硬约束（写迁移/模型时逐条检查）

- `id BIGINT UNSIGNED` 自增主键；`status` 非零 SMALLINT UNSIGNED；`created_at/updated_at/deleted_at DATETIME(3)`（未删除 deleted_at 为 NULL）；全字段非空有效 COMMENT；表名小写 snake_case 单数。
- 引用字段 `abc_id`；同表多角色 `<role>_<table>_<...>`，如 `parent_1_user_id`、`admin_user_id`。
- 金额/余额为有符号精确整数（BIGINT 有符号），ID 的 UNSIGNED 约束不套用到资产值。
- 不可变流水/审计（asset_operation、asset_entry、admin 审计等）：禁止 destroy/update 路径，`deleted_at` 恒 NULL、`updated_at` 固定等于 `created_at`。
- 常量/枚举（含 status 取值）禁止 0。

## 3. 已落地迁移（0001~0006，已对 compose MySQL 真跑并回滚验证）

| 迁移 | 表 | 要点 |
| --- | --- | --- |
| 0001 | `migration_history` | Umzug 自定义存储，记录 UP/DOWN 与 checksum |
| 0002 | `user` | 统一身份（role_type/reward_type/邀请码/TOTP/permissions JSON） |
| 0003 | `asset_account` | COIN/CNY 双账本账户 |
| 0004 | `asset_operation` | 记账幂等根：operation_key + request_hash，RECORDED=1 不可变 |
| 0005 | `asset_hold` | 冻结额度 |
| 0006 | `asset_entry` | 分录（转出/转入），挂同一 operation |

后续规划表（身份 device/recovery、支付、代理、流水/客损、管理配置、大厅准入、outbox）见 `docs/05_data/数据库设计SDD.md`，未建之前不得先铺空表。

## 4. 操作纪律

- 迁移命令：`docker compose --profile dev run --rm dev pnpm --filter @gameing/server migrate [up|down|status]`（需 compose 已启动 MySQL）。
- 迁移集成测试：`MIGRATION_TEST=1` 才运行（默认跳过），在目标库建表并回滚验证。
- 修改既有迁移会改变 checksum，迁移器拒绝静默覆盖；必须新增迁移。
- DDL 不能以 ORM 事务包裹宣称“整批可回滚”；新增/回填/切换/移除分迁移走。
- 大 ID 经 mysql2 以字符串读取；禁止先转 JS Number。写 repository 前参照 SDD §5 验收清单。
- 事务边界：应用用例定义原子边界；跨域用同一 opaque `TransactionScope`（SDD 全文在 02_architecture 代码分层规范 §9）。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-02 | 新建：登记 0001~0006 迁移现状、全表硬约束速查与迁移操作纪律；口径以 05_data 两份 SDD 为准。 |
