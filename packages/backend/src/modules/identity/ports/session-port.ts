/**
 * 会话端口（抽象 RedisSessionStore，用例不直接依赖 ioredis，SDD §4 端口约定）。
 *
 * 领域所有者：identity 模块（adapters/redis-session-port.ts 委托
 * infrastructure/redis/session-store.ts 实现）。
 * 对应 SDD 章节：JWT 登录与会话设计 §3（Redis 是活动会话与刷新轮换状态的权威存储；
 * user.auth_version 是 SQL 里的长期账号安全版本）。
 */

import type { PrincipalType, SessionRecord } from '../../../infrastructure/redis/session-store.js';

/** 构造会话记录（用例层组装后传 createSession）。 */
export interface NewSessionRecordInput {
  sessionId: string;
  userId: string;
  principalType: PrincipalType;
  deviceId: string | null;
  tokenFamily: string;
  authVersion: string;
  refreshHash: string;
  /** 创建时钟（UTC 毫秒）；绝对寿命 = createdAt + 30d，空闲 = createdAt + 7d 起算。 */
  nowMs: number;
}

/** SessionPort 入参的会话记录（重导出，避免用例层再引 infrastructure 类型）。 */
export type { SessionRecord };

/** 会话端口：8 个方法（抽象 session-store，用例只依赖本接口）。 */
export interface SessionPort {
  /** 创建会话（session:{sid} + session:user:{userId} Set，TTL = 剩余寿命）。 */
  createSession(record: SessionRecord, nowMs: number): Promise<void>;
  /** 读取会话；过期/撤销/未知返回 null（§3 "Redis 完整丢失使所有活动 session 失效"）。 */
  getSession(sid: string): Promise<SessionRecord | null>;
  /** 列出用户全部活动 sid（批量撤销用）。 */
  getSessionsByUser(userId: string): Promise<string[]>;
  /** 撤销单个 sid（删 session key + 摘 user Set 成员）。 */
  revokeSession(sid: string, userId: string | null): Promise<void>;
  /** 撤销用户全部会话（改密/全设备退出，§3）。 */
  revokeUserSessions(userId: string): Promise<void>;
  /** 读用户维度 Redis 安全版本镜像（无 TTL，长期镜像；缺省 '1'）。 */
  getRedisAuthVersion(userId: string): Promise<string>;
  /** 用户维度安全版本 +1（改密/恢复/全设备退出后调用，§3）。 */
  bumpRedisAuthVersion(userId: string): Promise<string>;
  /** 续期会话空闲寿命（刷新成功后调用；重算 TTL + 重设 user Set TTL）。 */
  touchSessionIdle(sid: string, userId: string, idleExpiryMs: number, nowMs: number): Promise<void>;
}

/** 构造会话记录（用例层组装后传 createSession）。 */
export interface NewSessionRecordInput {
  sessionId: string;
  userId: string;
  principalType: PrincipalType;
  deviceId: string | null;
  tokenFamily: string;
  authVersion: string;
  refreshHash: string;
  /** 创建时钟（UTC 毫秒）；绝对寿命 = createdAt + 30d，空闲 = createdAt + 7d 起算。 */
  nowMs: number;
}
