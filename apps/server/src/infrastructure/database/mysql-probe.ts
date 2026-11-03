import { closeSequelize, getSequelize } from '../database/sequelize.js';
import { readDatabaseConfigPermissive } from '../database/config.js';

/**
 * MySQL 就绪探针。
 *
 * 返回 null 表示就绪；返回字符串表示未就绪的安全原因（不含密码等敏感信息）。
 *
 * 设计要点：
 * - 使用 `readDatabaseConfigPermissive` 解析连接信息，凭证缺失时不抛异常，
 *   直接返回 "credentials missing"，避免探针把配置问题伪装成连接失败。
 * - 复用进程内唯一 Sequelize 实例（`getSequelize`），不另开第二条连接池。
 * - `authenticate` 成功后不主动 `close`，避免探针频繁开关连接池；
 *   连接池的关闭由进程退出钩子负责（`closeSequelize` 已存在）。
 */
export async function probeMysql(): Promise<string | null> {
  const config = readDatabaseConfigPermissive();
  if (config.username === '' || config.password === '') {
    return 'credentials missing';
  }
  const sequelize = getSequelize();
  try {
    await sequelize.authenticate();
    return null;
  } catch (error) {
    // 只暴露异常名，不回显原始 message（可能包含 SQL 片段或连接串）。
    return error instanceof Error ? error.name : 'UnknownError';
  }
}

export { closeSequelize };
