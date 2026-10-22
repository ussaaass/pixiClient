import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from './infrastructure/logging/logger.js';
import { createMigrator } from './infrastructure/database/migrator.js';
import { closeSequelize, getSequelize } from './infrastructure/database/sequelize.js';

/**
 * 迁移的真实 MySQL 集成测试。
 *
 * 门禁口径（`docs/05_data/数据库设计规范与Sequelize方案.md` §5）：
 * 迁移必须可升可降，且全表具备公共字段与非空注释。这些结论只能对真实 MySQL 验证，
 * 不能用模型校验或 mock 代替。
 *
 * **默认跳过**：测试会 DROP 目标库里的业务表。只有显式设置 `MIGRATION_TEST=1`
 * 时才运行，避免 `pnpm test` 在共享开发库上误删数据。
 *
 * 运行方式（dev 容器内）：
 *   MIGRATION_TEST=1 pnpm --filter @gameing/server test
 */

const TABLES = ['user', 'asset_account', 'asset_operation', 'asset_hold', 'asset_entry'] as const;
const PUBLIC_COLUMNS = ['id', 'status', 'created_at', 'updated_at', 'deleted_at'] as const;

const enabled = process.env.MIGRATION_TEST === '1';

interface ColumnRow {
  table_name: string;
  column_name: string;
  column_type: string;
  column_comment: string;
  extra: string;
}

const sqlTableList = TABLES.map((table) => `'${table}'`).join(', ');

async function readColumns(): Promise<ColumnRow[]> {
  const sequelize = getSequelize();
  const [rows] = await sequelize.query(
    `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type,
            COLUMN_COMMENT AS column_comment, EXTRA AS extra
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (${sqlTableList})`,
  );
  return rows as ColumnRow[];
}

test(
  '迁移可升可降，且每张表都有公共字段与非空注释',
  { skip: enabled ? false : '未设置 MIGRATION_TEST=1，跳过真实 MySQL 迁移测试' },
  async () => {
    const sequelize = getSequelize();
    const migrator = createMigrator(sequelize, {
      executorKey: 'migration-test',
      logger: createLogger({ sink: () => {} }),
    });

    try {
      // 从干净状态开始，避免上一轮残留影响断言。
      await migrator.down({ to: 0 });
      await migrator.up();

      const [tableRows] = await sequelize.query(
        `SELECT TABLE_NAME AS table_name, TABLE_COMMENT AS table_comment
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME IN (${sqlTableList})`,
      );
      const tables = tableRows as Array<{ table_name: string; table_comment: string }>;
      assert.equal(tables.length, TABLES.length, '首批表未全部创建');

      for (const table of tables) {
        assert.ok(table.table_comment.trim().length > 0, `${table.table_name} 缺少表注释`);
      }

      const columns = await readColumns();
      for (const table of TABLES) {
        const own = columns.filter((column) => column.table_name === table);
        assert.ok(own.length > 0, `${table} 没有任何字段`);
        for (const column of own) {
          assert.ok(column.column_comment.trim().length > 0, `${table}.${column.column_name} 缺少字段注释`);
        }
        for (const required of PUBLIC_COLUMNS) {
          assert.ok(
            own.some((column) => column.column_name === required),
            `${table} 缺少公共字段 ${required}`,
          );
        }
      }

      const userId = columns.find((column) => column.table_name === 'user' && column.column_name === 'id');
      assert.equal(userId?.column_type, 'bigint unsigned', 'user.id 必须是 BIGINT UNSIGNED');
      assert.match(userId?.extra ?? '', /auto_increment/i, 'user.id 必须自增');

      // 回滚必须真的把表删掉，而不是只改历史行。
      await migrator.down({ to: 0 });
      const [remainingRows] = await sequelize.query(
        `SELECT TABLE_NAME AS table_name
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME IN (${sqlTableList})`,
      );
      assert.equal((remainingRows as unknown[]).length, 0, '回滚后仍有业务表残留');

      // 恢复到已迁移状态，方便继续开发。
      await migrator.up();
    } finally {
      await closeSequelize();
    }
  },
);
