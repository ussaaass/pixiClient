import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sequelize } from 'sequelize';
import { MigrationActionType, MigrationStatus } from './migration-constants.js';

/** MySQL "表不存在"：首次运行、历史表尚未由 0001 创建。 */
function isMissingTableError(error: unknown): boolean {
  const candidate = error as { code?: unknown; original?: { code?: unknown } } | null;
  const code = candidate?.original?.code ?? candidate?.code;
  return code === 'ER_NO_SUCH_TABLE' || code === '42S02';
}

/**
 * Umzug 的迁移历史存储。
 *
 * 依据 `docs/05_data/数据库设计SDD.md` §5.8 `migration_history`：
 * 不使用 sequelize-cli 默认的 `SequelizeMeta`（它没有 id/状态/三个时间/注释，不满足
 * 全表规范），改为把每次 UP/DOWN 都作为一条不可改写的事实行追加，
 * 用 `execution_no` 表达同一迁移的多次执行，**不靠物理删行表达回滚**。
 *
 * `executed()` 的口径：取每个 name 的最新一条成功记录，只有它是 UP 才算"当前已应用"。
 */
export class MigrationHistoryStorage {
  constructor(
    private readonly sequelize: Sequelize,
    private readonly migrationsDir: string,
    private readonly executorKey: string,
  ) {}

  async executed(): Promise<string[]> {
    try {
      const [rows] = await this.sequelize.query(
        `SELECT h.name AS name
           FROM migration_history h
           JOIN (
             SELECT name, MAX(execution_no) AS max_execution_no
               FROM migration_history
              WHERE status = ?
              GROUP BY name
           ) latest
             ON latest.name = h.name
            AND latest.max_execution_no = h.execution_no
          WHERE h.action_type = ?`,
        { replacements: [MigrationStatus.SUCCEEDED, MigrationActionType.UP] },
      );

      return (rows as Array<{ name: string }>).map((row) => row.name);
    } catch (error) {
      // 首次运行时历史表还不存在（由 0001 迁移自己创建）。
      // 这属于"没有任何迁移被执行过"的正常状态，不是故障。
      if (isMissingTableError(error)) return [];
      throw error;
    }
  }

  async logMigration({ name }: { name: string }): Promise<void> {
    await this.append(name, MigrationActionType.UP);
  }

  async unlogMigration({ name }: { name: string }): Promise<void> {
    await this.append(name, MigrationActionType.DOWN);
  }

  /**
   * 追加一条已成功的执行记录。
   *
   * `execution_no` 用 `MAX+1` 在单条语句内计算，并由
   * `uq_migration_history_name_execution_no` 兜底：并发跑两个迁移任务时，
   * 后到的那个会因唯一键冲突失败，而不是静默产生重复序号。
   *
   * 说明：当前只记录 SUCCEEDED。RUNNING/FAILED 需要 Umzug 的 `migrating` 事件钩子，
   * 留到接入独立迁移任务时补，不在本批次伪造。
   */
  private async append(name: string, actionType: number): Promise<void> {
    const checksum = await this.computeChecksum(name);

    await this.sequelize.query(
      `INSERT INTO migration_history
         (status, name, checksum, action_type, execution_no, started_at, finished_at, executor_key, created_at, updated_at)
       SELECT ?, ?, ?, ?, COALESCE(MAX(execution_no), 0) + 1, NOW(3), NOW(3), ?, NOW(3), NOW(3)
         FROM migration_history
        WHERE name = ?`,
      { replacements: [MigrationStatus.SUCCEEDED, name, checksum, actionType, this.executorKey, name] },
    );
  }

  /**
   * 迁移内容摘要。
   *
   * 规范要求"迁移 checksum 变更拒绝默默覆盖"：摘要落库后，同一 name 的内容被改动
   * 会在历史里留下不同的 checksum，可被后续的 schema-check 发现。
   * 读不到源文件时退化为对 name 取摘要，保证历史行仍可写入。
   */
  private async computeChecksum(name: string): Promise<string> {
    try {
      const content = await readFile(join(this.migrationsDir, name));
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return createHash('sha256').update(name).digest('hex');
    }
  }
}
