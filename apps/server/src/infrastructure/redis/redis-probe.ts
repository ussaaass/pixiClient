/**
 * Redis 就绪探针。
 *
 * 当前阶段 Redis 尚未接入服务端依赖，探针只做 TCP 可达性检查（不解析 RESP 协议）。
 * 接入 ioredis / 真实命令后，本文件扩展为 `PING` 校验，保持同样的
 * "返回 null 表示就绪；返回字符串表示未就绪的安全原因"契约。
 *
 * 环境变量与 `compose.yaml` 对齐：容器内 `REDIS_HOST=redis`、`REDIS_PORT=6379`，
 * 宿主机默认落到本机映射端口 10371。
 */
import { connect } from 'node:net';

export interface RedisProbeOptions {
  readonly host?: string;
  readonly port?: number;
  readonly timeoutMs?: number;
}

function resolveHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.REDIS_HOST ?? '127.0.0.1';
}

function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REDIS_PORT ?? '10371';
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`REDIS_PORT 非法：${raw}`);
  }
  return port;
}

export function probeRedis(options: RedisProbeOptions = {}): Promise<string | null> {
  const host = options.host ?? resolveHost();
  const port = options.port ?? resolvePort();
  const timeoutMs = options.timeoutMs ?? 1_500;

  return new Promise<string | null>((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('timeout');
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(null);
    });

    socket.once('error', (error) => {
      clearTimeout(timer);
      resolve(error instanceof Error ? error.name : 'UnknownError');
    });
  });
}
