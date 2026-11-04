/**
 * rooms 模块入口（供 apps/server 装配层复用；SDD §1 public.ts 跨模块唯一入口
 * 之外，顶层 index 做 re-export 便于装配侧 import，与 wallet 模块 index 同款）。
 */
export * from './public.js';
