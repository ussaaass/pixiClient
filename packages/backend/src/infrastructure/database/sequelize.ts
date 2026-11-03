import { Sequelize } from 'sequelize';
import { buildSequelizeOptions, readDatabaseConfig } from './config.js';

/**
 * 进程内唯一的 Sequelize 实例。
 *
 * 延迟创建：服务进程在只读路由阶段不需要数据库，只有真正调用时才解析环境变量并建池，
 * 这样 `pnpm dev` 在未配置 MySQL 时仍能启动探活接口。
 *
 * 严禁在应用启动路径调用 `sync()`——表结构只通过 `migrator.ts` 的迁移变更。
 */
let instance: Sequelize | undefined;

export function getSequelize(): Sequelize {
  instance ??= new Sequelize(buildSequelizeOptions(readDatabaseConfig()));
  return instance;
}

/** 关闭连接池。进程退出与集成测试的收尾必须调用，否则事件循环不会释放。 */
export async function closeSequelize(): Promise<void> {
  if (instance === undefined) return;
  await instance.close();
  instance = undefined;
}
