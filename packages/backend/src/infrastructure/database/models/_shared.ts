/**
 * model 公共支撑：选项工厂、append-only 钩子与模型类型工具。
 *
 * 依据 `docs/02_architecture/后端实施SDD.md` §2 / 附录 A.12 的硬性约定：
 *
 * 1. 全表公共 5 字段（id/status/created_at/updated_at/deleted_at）：
 *    - `id` 与各 `BIGINT UNSIGNED` 引用列在 Model 属性接口中以**十进制字符串（wire 格式）**承载，
 *      数据库列仍为 BIGINT，由 Sequelize `DataTypes.BIGINT` 读写；禁止 JS number 跨越
 *      Number.MAX_SAFE_INTEGER（跨层十进制字符串化在 row-mapper，不在 model getter）。
 *    - `created_at`/`updated_at`/`deleted_at` 为 `DATETIME(3)`，UTC；公共选项统一声明
 *      `timestamps: true` + 列名映射 + `paranoid: true`（不可变表除外，见 3）。
 *
 * 2. 字段类型映射（对照 0002~0018 迁移 DDL）：
 *    BIGINT UNSIGNED → DataTypes.BIGINT（接口声明 string）；SMALLINT UNSIGNED → DataTypes.SMALLINT
 *    （接口数值）；VARCHAR(n) → STRING(n)；CHAR(36) → CHAR(36)；DECIMAL → DECIMAL(p,s)（字符串 wire）；
 *    JSON → DataTypes.JSON；BINARY(n)/VARBINARY(n) → `binaryDataType(n)`（模型保持二进制原样，
 *    hex 化归 row-mapper，A.12 第 4/6 条）；MEDIUMBLOB → BLOB；MEDIUMTEXT/TEXT → TEXT；
 *    DATETIME(3) → DATE（接口 UTC 时间）；INT → INTEGER。
 *
 * 3. 不可变表（asset_operation / asset_entry / round_event / referral_binding_event /
 *    admin_audit_event / agent_audit_event / user_security_event / payment_event /
 *    coin_exchange / gift_grant / ai_asset_reference）：
 *    - `appendOnlyModelOptions`：保留 `timestamps: true` + `createdAt:'created_at'` +
 *      `updatedAt:'updated_at'`（公共字段由迁移建列、注释已固定，updated_at 固定等于 created_at），
 *      `paranoid: false`（deleted_at 恒 NULL 由迁移 CHECK 保证，不建软删路径）；
 *    - `appendOnlyHooks`：`afterUpdate`/`afterDestroy` 抛错，任何 update/destroy 在 Model 层即失败；
 *      用例层只提供 append-only API（A.12 第 5 条，与 0004 迁移 DDL 的"不可更新删除"注释一致）。
 *
 * 4. `outbox` 例外（A.10 登记口径）：行 append-only 但 status 有 OutboxStatus 1~4 状态机，
 *    updated_at 随投递正常更新，故走 `standardTableOptions` 但 `paranoid: false`。
 *
 * 5. 生成列（system_marker / active_marker）：原生 STORED 生成列（迁移 DDL），
 *    不声明进 model attributes；在属性接口中以注释说明"生成列，数据库层只读"
 *    （不用 TS `readonly` 修饰符——那是 TS 层语义，此处是数据库层只读；A.12 第 6 条）。
 *
 * 6. 外键列：模型侧 `belongsTo/hasMany` 一律 `foreignKey: 'xxx_id'` + `constraints: false`
 *    （FK 约束全部由迁移 DDL 管理，防止 sync 补列/补索引，A.12 第 2 条）。
 *
 * 7. 保留字表 `order` / `user`：Sequelize 对 `tableName` 自动加反引号；raw SQL 处自行加
 *    （A.12 第 7 条）。各相关 Model options 里保留 `tableName` 说明注释。
 *
 * 8. Sequelize 6 + TS strict（exactOptionalPropertyTypes）已验证的最小可编译模式：
 *    - 子类**不得覆盖 `static init`**（与基类 `Model.init(attributes, options)` 签名冲突，
 *      触发 TS2417/TS2554/TS2684）；各文件以模块级 `registerXxx(sequelize)` 函数
 *      显式调用 `XxxModel.init(attrs, opts)`。
 *    - 调用处统一写法（各 registerXxx 内）：
 *      `(XxxModel.init as unknown as ModelInitFn)(attrs, opts as unknown as ModelInitOptions<XxxModel>)`
 *      `ModelInitFn = (attrs: unknown, opts: unknown) => void` 宽松签名绕过
 *      `exactOptionalPropertyTypes` 下 `InitOptions<M>` 的可选属性约束；
 *      `ModelInitOptions<M> = ModelOptions<M> & Partial<InitOptions<M>>` 保留
 *      options 字面量的结构检查。
 *    - `DataTypes.BINARY(n)` / `DataTypes.VARBINARY(n)`：Sequelize 6 的
 *      `data-types.d.ts` 未声明独立构造器（仅 MySQL 方言运行时常量），
 *      统一经 `binaryDataType(n)` 桥接为 `DataTypes.STRING(n, true)`
 *      （A.12 第 4 条：模型保持二进制原样，hex 化归 row-mapper）。
 */

import { DataTypes } from 'sequelize';
import type { InitOptions, Model, ModelOptions } from 'sequelize';

/**
 * 工厂函数返回的 options 基础类型（`ModelOptions<Model>` 交集 `comment`）。
 * 使用处（`XxxModel.init` 第二参数）统一经 `as unknown as ModelInitOptions<M>` 桥接。
 */
export type TableOptionsBase = ModelOptions<Model> & { comment?: string };

/**
 * `Model.init` 调用的宽松函数签名桥接：`exactOptionalPropertyTypes: true` 下
 * `ModelOptions<M>` 不可直接赋给 `InitOptions<M>`（可选属性不允许 `undefined`），
 * 统一经 `(XxxModel.init as unknown as ModelInitFn)(attrs, opts)` 一次桥接。
 */
export type ModelInitFn = (attrs: unknown, opts: unknown) => void;

/**
 * `Model.init` 第二参数桥接类型：`ModelOptions<M> & Partial<InitOptions<M>>`。
 * `Partial` 交集放宽 `exactOptionalPropertyTypes` 约束，保留 options 字面量结构检查。
 */
export type ModelInitOptions<M extends Model> = ModelOptions<M> & Partial<InitOptions<M>>;

/**
 * 二进制列（BINARY(n)/VARBINARY(n)）类型构造：`DataTypes.STRING(n, true)` 近似映射。
 * Sequelize 6 的 `data-types.d.ts` 未声明 `BINARY`/`VARBINARY` 构造器，
 * 运行时 MySQL 方言支持这两类 DDL 类型（迁移 DDL 为准），模型侧以 binary 字符串近似。
 */
export function binaryDataType(length: number): typeof DataTypes.STRING {
  return DataTypes.STRING(length, true) as unknown as typeof DataTypes.STRING;
}

/** 公共 5 字段 options 基座（普通表）：蛇形 + 冻结表名 + timestamps 列映射 + 软删。 */
function standardOptionsBase(): TableOptionsBase {
  return {
    underscored: true,
    freezeTableName: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    paranoid: true,
    deletedAt: 'deleted_at',
  } as unknown as TableOptionsBase;
}

/** 普通表 options：公共 5 字段 + 指定表名 + 表注释（使用处 `as unknown as ModelInitOptions<M>` 桥接）。 */
export function standardTableOptions(tableName: string, comment?: string): TableOptionsBase {
  const base = { ...standardOptionsBase(), tableName };
  return comment !== undefined ? { ...base, comment } : base;
}

/**
 * 不可变表 options：公共字段映射保留（updated_at 由数据库固定等于 created_at），
 * 关闭软删（deleted_at 恒 NULL 由迁移 CHECK 保证）；写入拦截另靠 `appendOnlyHooks`。
 */
export function appendOnlyModelOptions(tableName: string, comment?: string): TableOptionsBase {
  const base = {
    ...standardOptionsBase(),
    tableName,
    paranoid: false,
  };
  return comment !== undefined ? { ...base, comment } : base;
}

/**
 * outbox options（A.10 例外）：正常表 timestamps（updated_at 随投递状态机更新），
 * 仅 `paranoid: false`——行 append-only，`deleted_at` 恒 NULL 由迁移 CHECK 保证。
 */
export function outboxTableOptions(tableName: string, comment?: string): TableOptionsBase {
  const base = {
    ...standardTableOptions(tableName),
    paranoid: false,
  };
  return comment !== undefined ? { ...base, comment } : base;
}

/**
 * 不可变表 append-only 钩子（A.12 第 5 条）：
 * 任何 UPDATE / DELETE 在 Model 层抛错；与 0004/0006 等迁移 DDL 的"不可更新删除"注释一致。
 * 使用处经 options 整体 `as unknown as ModelInitOptions<M>` 一并桥接。
 */
export function appendOnlyHooks(tableName: string): {
  afterUpdate: (instance: Model, options: Record<string, unknown>) => void;
  afterDestroy: (instance: Model, options: Record<string, unknown>) => void;
} {
  return {
    afterUpdate() {
      throw new Error(`不可变表禁止 update：${tableName}`);
    },
    afterDestroy() {
      throw new Error(`不可变表禁止 delete：${tableName}`);
    },
  };
}

/**
 * 统一 Model 泛型：把 `id` 与各可空公共时间列从创建入参中剔除。
 * 用法：`class XModel extends Model<XModelAttributes, OmitPublicFields<XModelAttributes>>
 *          implements XModelAttributes { ... }`
 * attributes 接口里 `id: string` 与公共时间列可省略（由 Model 基类提供）。
 */
export type OmitPublicFields<T extends { id: string }> = Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>;
