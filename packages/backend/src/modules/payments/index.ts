/**
 * payments 模块入口（供 apps/server 装配层复用；SDD §1 public.ts 跨模块
 * 唯一入口之外，顶层 index 做 re-export 便于装配侧 import，与 wallet /
 * identity 模块 index 同款）。
 *
 * 注：`createPaymentsModule` / `outboxFor` 等已在 public.ts re-export，
 * 本处不重复 export 以避免 Public export declaration conflicts。
 */
export * from './public.js';
