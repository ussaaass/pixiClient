/**
 * 迁移执行历史的常量。
 *
 * 取值来自 `docs/05_data/数据库设计SDD.md` §3：`MigrationStatus` 与
 * `action_type`（UP/DOWN）。按全表规范，业务常量一律从 1 起，0 不是合法状态。
 *
 * 这里只放迁移基础设施自身用到的常量；身份与资产的领域常量随各自 Model/用例落地时
 * 再按领域建文件，避免先铺一批没人引用的空枚举。
 */
export const MigrationStatus = {
  RUNNING: 1,
  SUCCEEDED: 2,
  FAILED: 3,
} as const;

export const MigrationActionType = {
  UP: 1,
  DOWN: 2,
} as const;
