/**
 * 工作单元（identity 模块事务编排；Sequelize 实现）。
 *
 * 领域所有者：identity 模块（跨用例事务的 SQL 侧；Redis 侧不在此范围内——
 * 会话撤销/版本递增走 SessionPort，§3 "不能把 Redis 会话镜像进 SQL 假装两者同事务"）。
 * 对应 SDD 章节：后端实施 SDD §4（"用例调用 unitOfWork.run(scope)；所有分录/outbox
 * 同事务"）。
 *
 * 约定：
 * - `run(scope)` 开启 Sequelize 事务，scope 内所有 repo 写操作共享该事务（回滚即整事务
 *   回滚）；Redis 操作不受 Sequelize 事务管理（跨存储窗口，§3 "该跨存储窗口应在落地时
 *   用故障注入核实"；outbox 行在 scope 内写，随事务提交后由 worker 幂等重放）。
 * - 提交失败（Redis 撤销未完成）：SQL 已回滚，outbox 行随事务消失 → 不报告成功，
 *   §3 "安全变更提交后必须同步完成 Redis 版本更新/撤销才向调用端报告成功"。
 */

import type { Sequelize, Transaction } from 'sequelize';

/** 事务作用域（用例内传递；`tx.transaction` 为 Sequelize Transaction）。 */
export interface UnitOfWorkScope {
  readonly transaction: Transaction | null;
}

export interface UnitOfWork {
  /** 在单事务内执行 scope（提交/回滚由实现管理）。 */
  run<T>(scope: (scope: UnitOfWorkScope) => Promise<T>): Promise<T>;
}

/** Sequelize 工作单元实现（identity 模块装配注入）。 */
export class SequelizeUnitOfWork implements UnitOfWork {
  constructor(private readonly sequelize: Sequelize) {}

  async run<T>(fn: (scope: UnitOfWorkScope) => Promise<T>): Promise<T> {
    const sequelize = this.sequelize;
    // `sequelize.transaction` 管理回滚（fn 抛错自动回滚，成功自动提交）。
    const tx: Transaction = await sequelize.transaction();
    const scope: UnitOfWorkScope = { transaction: tx };
    try {
      const result = await fn(scope);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }
}
