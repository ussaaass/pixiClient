---
name: add-database-migration
description: 为本仓库新增 Sequelize/Umzug 数据库迁移时使用：检查全表硬约束、写 00xx 迁移文件、跑 migrate up/down/status 与 MIGRATION_TEST 集成验证。
whenToUse: 任务涉及新建/修改数据库表、加字段、加索引、改约束，或需要验证迁移可升可降时。
---

# 新增数据库迁移

适用：`apps/server/src/infrastructure/database/migrations/`（当前 0001~0006 已落地）。

## 前置

1. 读 `docs/05_data/数据库设计规范与Sequelize方案.md`（权威）与 `docs/09_agent/DATABASE.md`。
2. 读相邻迁移文件（`0002-create-user.ts` 等）保持注释/反引号/DEFAULT 风格一致。
3. 确认新表的领域所有者与真实用例（SDD §6 评审清单）；不能说明用途的候选表不建。

## 全表硬约束检查单（写 DDL 前逐条过）

- [ ] `id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT` + 注释
- [ ] `status SMALLINT UNSIGNED NOT NULL DEFAULT <非零常量>` + 注释列出取值
- [ ] `created_at/updated_at/deleted_at DATETIME(3)`；不可变流水表 `deleted_at` 恒 NULL、`updated_at` 固定等于 `created_at`（见 0004 写法）
- [ ] 表名小写 snake_case 单数；每个字段有有效 COMMENT（无“字段1”式占位）
- [ ] 引用字段 `abc_id`；同表多角色 `<role>_<table>_id`；引用类型 BIGINT UNSIGNED
- [ ] 常量/枚举取值全部 ≥1；金额列用有符号 BIGINT（非 UNSIGNED）
- [ ] 索引只服务已说明的查询；资金/审计引用外键 RESTRICT
- [ ] 不修改既有迁移文件（checksum 拒覆盖），只追加新编号

## 实施

```sh
# 文件：apps/server/src/infrastructure/database/migrations/0007-create-<table>.ts
# 导出 async up({ context }: { context: Sequelize }): Promise<void> 与 down(...)
# down 必须可回滚（DROP TABLE / DROP COLUMN 等），并注释回滚语义
```

迁移器与 CLI：`apps/server/src/infrastructure/database/migrator.ts`、`apps/server/src/cli/migrate.ts`（umzug 自定义 `migration_history` 存储记录 UP/DOWN + checksum）。

## 验证（全部通过才算完成）

```sh
docker compose up -d mysql redis
pnpm --filter @gameing/server migrate up        # 应执行到 0007
pnpm --filter @gameing/server migrate status    # N executed / 0 pending
pnpm --filter @gameing/server migrate down      # 回滚最后一步
docker compose --profile dev run --rm -e MIGRATION_TEST=1 dev pnpm --filter @gameing/server test
```

## 收尾

- 更新 `docs/09_agent/DATABASE.md` 已落地迁移表 + 本文与 SDD 的“变更历史”。
- 改完跑 `graphify update .`。
- 报告：执行过的命令与结果（不得把未跑的说成通过）。
