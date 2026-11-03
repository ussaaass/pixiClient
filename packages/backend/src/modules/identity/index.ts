/**
 * identity 模块入口（供 apps/server 装配层复用；SDD §1 public.ts 跨模块唯一入口
 * 之外，顶层 index 做 re-export 便于装配侧 import）。
 */
export * from './public.js';
export { createIdentityModule, outboxFor, type IdentityModule, type IdentityModuleDeps } from './assembly.js';
