/**
 * 时钟端口（测试可注入；UTC 时间基准）。
 *
 * 领域所有者：identity 模块（全部用例 + 轮换/限频共用）。
 * 对应 SDD 章节：AGENTS.md "时间 UTC"；后端实施 SDD §4（用例构造注入 ports，
 * 不用全局——Clock 为可注入依赖）。
 */

export interface Clock {
  /** 当前 UTC 时间。 */
  now(): Date;
}

/** 生产实现：包装 `new Date()`（无时区偏移）。 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
