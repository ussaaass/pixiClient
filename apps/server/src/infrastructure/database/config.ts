import type { Options } from 'sequelize';

/**
 * 数据库连接配置。
 *
 * 依据 `docs/05_data/数据库设计规范与Sequelize方案.md` §3：MySQL 方言 + mysql2 驱动，
 * 大整数必须以字符串读取（ID 与金额不得先转 JS number），时区统一 UTC。
 *
 * 环境变量与 `compose.yaml` 对齐：容器内 `MYSQL_HOST=mysql`，宿主机默认落到
 * 本机映射端口 10306。默认值只用于本机开发，生产必须显式注入。
 */
export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

function readRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`缺少数据库环境变量 ${name}`);
  }
  return value;
}

export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const rawPort = env.MYSQL_PORT ?? '10306';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`MYSQL_PORT 非法：${rawPort}`);
  }

  return {
    host: env.MYSQL_HOST ?? '127.0.0.1',
    port,
    database: env.MYSQL_DATABASE ?? 'gameing_hall',
    username: readRequired(env, 'MYSQL_USER'),
    password: readRequired(env, 'MYSQL_PASSWORD'),
  };
}

/**
 * 构造 Sequelize 选项。
 *
 * - `timezone: '+00:00'` 与 compose 里 MySQL 的 `--default-time-zone=+00:00` 一致，
 *   避免 DATETIME(3) 在读写时被本地时区二次偏移。
 * - `bigNumberStrings` + `supportBigNumbers` 让 BIGINT 以精确十进制字符串返回；
 *   仅靠 TS 的 `declare id: string` 不会改变驱动行为。
 * - `logging` 默认关闭：本项目的日志走 `infrastructure/logging/logger.ts` 的结构化
 *   输出，不接受 Sequelize 的自由文本 SQL 日志。
 */
export function buildSequelizeOptions(config: DatabaseConfig, logging: NonNullable<Options['logging']> = false): Options {
  return {
    dialect: 'mysql',
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
    timezone: '+00:00',
    logging,
    // dialectOptions 在 Sequelize v6 的公开类型里没有逐项声明 mysql2 参数，
    // 这里按官方运行时约定传入，仅做类型收窄，不改变实际取值。
    // 收窄目标是 NonNullable：`exactOptionalPropertyTypes` 下 `Options['dialectOptions']`
    // 含 undefined，直接断言会让可选属性被赋成 undefined 而报 TS2375。
    dialectOptions: {
      charset: 'utf8mb4',
      supportBigNumbers: true,
      bigNumberStrings: true,
    } as NonNullable<Options['dialectOptions']>,
    define: {
      charset: 'utf8mb4',
      collate: 'utf8mb4_0900_ai_ci',
      underscored: true,
      freezeTableName: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      deletedAt: 'deleted_at',
    },
    pool: { max: 10, min: 0, idle: 10_000, acquire: 30_000 },
  };
}
