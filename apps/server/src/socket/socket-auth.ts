/**
 * Socket.IO 握手鉴权基座（SDD §6.1）。
 *
 * 依据 `docs/04_domains/JWT登录与会话设计.md` §2 与后端实施 SDD §6.1：
 * - 握手 `auth.accessToken` → 同 §5.2 玩家验证（ES256 验签 + Redis session + auth_version）。
 * - 握手拒绝不建立连接（401 语义）；**连接建立 ≠ 永久授权**：
 *   每条受保护命令重查会话过期与 auth_version。
 * - `session.reauthorize`：客户端提前 refresh 后通过该命令更新当前连接认证
 *   上下文（同 sid/userId），重连走标准握手。
 * - 登出/封禁/停权：撤销 Redis session 后按 user_id 断开相关连接
 *   （user→connection Set，进程内维护；多实例经 Redis pub/sub 广播断开指令，
 *   首版单实例在进程内闭环，多实例扩展登记为后续项）。
 *
 * 命名空间首版只挂 `/platform`（玩家大厅）；`/admin` 与 `/room/:roomId` 随
 * 后续 Admin 切换与房间模块落地。
 */

import { Server, type Socket } from 'socket.io';
import type { IdentityModule } from '@gameing/backend/modules/identity/public';
import type { Logger } from '../infrastructure/logging/logger.js';
import type { Server as NodeHttpServer } from 'node:http';

/** 连接建立后缓存的认证上下文（`session.reauthorize` 可原地更新，不断连）。 */
export interface SocketAuthContext {
  userId: string;
  sid: string;
  deviceId: string | null;
  authVersion: string;
}

/** 握手鉴权选项。 */
export interface CreateSocketAuthOptions {
  module: IdentityModule;
  logger: Logger;
  /** 命名空间路径（首版 `/platform`）。 */
  namespace?: string;
}

export interface SocketAuthHandles {
  /** 挂到 Koa/Node http server 上的 socket.io Server 实例。 */
  io: Server;
  /** 命名空间实例（按命名空间取，后续 /room/:roomId 动态命名空间同模式）。 */
  platform: ReturnType<Server['of']>;
  /** 按 user_id 取当前进程内连接列表（撤销时批量 disconnect）。 */
  connectionsByUser: Map<string, Set<Socket>>;
  /** 主动断开某 user 的全部 /platform 连接（登出/封禁/改密后调用）。 */
  disconnectUser: (userId: string) => void;
}

/**
 * 创建 Socket.IO 握手鉴权基座。
 * 调用方：`main.ts` 装配阶段创建一次，`io` 挂到 http server；
 * `disconnectUser` 在 identity 用例（logout / changePassword / revokeUserSessions）
 * 完成 Redis 撤销后调用。
 */
export function createSocketAuthServer(httpServer: NodeHttpServer, options: CreateSocketAuthOptions): SocketAuthHandles {
  const { module: identity, logger } = options;
  const namespace = options.namespace ?? '/platform';

  const io = new Server(httpServer as never);
  const platform = io.of(namespace);

  /** user → 该 user 的 /platform socket 连接集合（撤销时遍历断开）。 */
  const connectionsByUser = new Map<string, Set<Socket>>();

  function trackConnection(userId: string, socket: Socket): void {
    let set = connectionsByUser.get(userId);
    if (set === undefined) {
      set = new Set();
      connectionsByUser.set(userId, set);
    }
    set.add(socket);
  }

  function untrackConnection(userId: string, socket: Socket): void {
    const set = connectionsByUser.get(userId);
    if (set === undefined) return;
    set.delete(socket);
    if (set.size === 0) connectionsByUser.delete(userId);
  }

  /** 按 user_id 断开全部 /platform 连接（登出/封禁/停权，§2 "登出/封禁主动断开相应 Socket"）。 */
  function disconnectUser(userId: string): void {
    const set = connectionsByUser.get(userId);
    if (set === undefined) return;
    for (const socket of set) {
      socket.emit('session.revoked', { code: 'SESSION_REVOKED', reason: 'auth revoked or account action' });
      socket.disconnect(true);
    }
    connectionsByUser.delete(userId);
  }

  platform.use(async (socket, next) => {
    const token = socket.handshake.auth?.accessToken as string | undefined;
    if (!token) {
      logger.warn('Socket 握手拒绝：accessToken 缺失', { namespace, socketId: socket.id });
      return next(new Error('UNAUTHORIZED'));
    }

    // 同 §5.2 玩家三重门禁：验签 + session 仍有效 + auth_version 一致。
    let verified;
    try {
      verified = await identity.jwtIssuer.verifyAccessToken(token, { audience: 'player' });
    } catch {
      logger.warn('Socket 握手拒绝：access token 验签失败', { namespace, socketId: socket.id });
      return next(new Error('ACCESS_TOKEN_INVALID'));
    }

    const session = await identity.sessionPort.getSession(verified.sid);
    if (session === null) {
      logger.warn('Socket 握手拒绝：session 已撤销', { namespace, sid: verified.sid, socketId: socket.id });
      return next(new Error('SESSION_REVOKED'));
    }
    if (session.authVersion !== verified.authVersion) {
      logger.warn('Socket 握手拒绝：auth_version 不一致', {
        namespace,
        sid: verified.sid,
        tokenVersion: verified.authVersion,
        redisVersion: session.authVersion,
      });
      return next(new Error('REFRESH_REVOKED'));
    }

    const auth: SocketAuthContext = {
      userId: verified.userId,
      sid: verified.sid,
      deviceId: verified.deviceId,
      authVersion: verified.authVersion,
    };
    socket.data.auth = auth;
    trackConnection(auth.userId, socket);
    logger.info('Socket 连接建立', {
      namespace,
      socketId: socket.id,
      userId: auth.userId,
      sid: auth.sid,
    });
    next();
  });

  platform.on('connection', (socket) => {
    const auth = socket.data.auth as SocketAuthContext;

    socket.on('disconnect', () => {
      untrackConnection(auth.userId, socket);
      logger.info('Socket 连接断开', { namespace, socketId: socket.id, userId: auth.userId });
    });

    /**
     * `session.reauthorize`：客户端提前 HTTP refresh 后提交新 access token。
     * 成功：更新当前连接认证上下文（同 sid/userId），不断连（§2 "保留同一
     * sid/userId，重新授权订阅"）；失败：断开该连接（不能带旧认证继续提交受保护命令）。
     */
    socket.on('session.reauthorize', async (rawToken: unknown, ack?: (result: { ok: boolean; code?: string }) => void) => {
      if (typeof rawToken !== 'string' || rawToken.length === 0) {
        ack?.({ ok: false, code: 'VALIDATION_FAILED' });
        return;
      }
      try {
        const verified = await identity.jwtIssuer.verifyAccessToken(rawToken, { audience: 'player' });
        const session = await identity.sessionPort.getSession(verified.sid);
        if (session === null || session.authVersion !== verified.authVersion) {
          socket.emit('session.revoked', { code: session === null ? 'SESSION_REVOKED' : 'REFRESH_REVOKED' });
          socket.disconnect(true);
          return;
        }
        // 更新连接认证上下文（同 sid/userId 约束：不同 sid 视为新会话，断开重连）。
        if (verified.sid !== auth.sid || verified.userId !== auth.userId) {
          socket.emit('session.revoked', { code: 'SESSION_CHANGED' });
          socket.disconnect(true);
          return;
        }
        auth.authVersion = verified.authVersion;
        socket.data.auth = auth;
        ack?.({ ok: true });
      } catch {
        socket.emit('session.revoked', { code: 'ACCESS_TOKEN_INVALID' });
        socket.disconnect(true);
      }
    });
  });

  return { io, platform, connectionsByUser, disconnectUser };
}
