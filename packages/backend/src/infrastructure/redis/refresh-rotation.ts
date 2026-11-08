/**
 * refresh token 原子轮换（Lua 脚本）与 30 秒弱网重放窗口。
 *
 * 领域所有者：identity 模块。
 * 对应 SDD 章节：JWT 登录与会话设计 §3 —— "每次刷新通过 Lua/原子操作比较当前摘要、
 * 原子轮换并推进序号；已消费凭证被不同操作再次使用时撤销该 session 并记持久安全事件。
 * RFC 9700 刷新令牌保护。弱网下 30 秒的同凭证+同 operationId 重试记录，只重放同一代，
 * 不生成多条后继；窗口外或不同 operationId 的复用按异常处理。"
 *
 * 状态布局（全部 key 带 TTL）：
 * - `session:{sid}`：SessionRecord JSON（refreshHash = 当前代摘要，rotationSeq）。
 * - `session:replay:{sid}`：Lua 写入的"上一代刷新结果"JSON，含旧凭证摘要、operationId、
 *   新摘要、加密 refresh token 与轮换结果；每次成功轮换覆盖，TTL 固定 30s。
 *   Lua 在本脚本内原子比对凭证与 operationId，并直接返回缓存的密文 replay payload。
 *
 * Lua 契约（`session:rotate` 脚本，由 ioredis `Script` 自动 SHA1 缓存，NOSCRIPT 自动重定义）：
 *   KEYS[1] = session:{sid}（SessionRecord JSON）
 *   KEYS[2] = session:replay:{sid}（上一代结果 JSON）
 *   ARGV[1..6] = presentedHash, newHash, encryptedToken, operationId, nowMs, replayTtlSeconds
 *   ARGV[7..10] = current effective expiry ms, absolute expiry ms, next idle ISO, next effective expiry ISO
 *
 * 返回值（单元素表）：
 *   `OK|{json}`     —— 成功轮换：{ sessionId, userId, authVersion, replayCache }
 *   `REUSE|{json}`  —— 已消费凭证再次使用（复用检测）：{ presentedHash, operationId, atMs }
 *                      脚本原子删除 session 并从 user Set 摘除该 sid。
 */

import type { RedisClient } from './client.js';

/** 弱网重放窗口（§3 的 30 秒；超窗后旧代凭证视为复用）。 */
export const REPLAY_WINDOW_MS = 30 * 1000;

/** 轮换结果：成功。 */
export interface RotationOk {
  kind: 'OK';
  newRefreshHash: string;
  rotationSeq: number;
  idleExpiryEpochMs: number;
}

/** 轮换结果：已消费凭证再次使用（§3 撤销该 session + 持久安全事件）。 */
export interface RotationReuse {
  kind: 'REUSE_DETECTED';
  /** 复用检测不产生附加会话快照。 */
  userId: string;
}

export type RotationResult = RotationOk | RotationReuse;

/** 重放缓存命中：同一代结果原样返回（不生成新代、不推进 seq）。 */
export interface ReplayCacheEntry {
  presentedHash: string;
  operationId: string;
  newRefreshHash: string;
  encryptedRefreshToken: string;
  result: RotationOk;
}

/** 脚本返回解析后的联合类型。 */
export type ScriptOutcome =
  | { kind: 'OK'; record: SessionRecordSnapshot; replayCache: ReplayCacheEntry }
  | { kind: 'REUSE_DETECTED'; record: SessionRecordSnapshot }
  | { kind: 'REPLAY'; record: SessionRecordSnapshot; replayCache: ReplayCacheEntry };

function isReplayCacheEntry(value: unknown): value is ReplayCacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<ReplayCacheEntry>;
  return (
    typeof entry.presentedHash === 'string' &&
    typeof entry.operationId === 'string' &&
    typeof entry.newRefreshHash === 'string' &&
    typeof entry.encryptedRefreshToken === 'string' &&
    typeof entry.result === 'object' &&
    entry.result !== null &&
    typeof entry.result.newRefreshHash === 'string' &&
    typeof entry.result.rotationSeq === 'number' &&
    typeof entry.result.idleExpiryEpochMs === 'number'
  );
}

function decodeObject<T>(raw: string, guard: (value: unknown) => value is T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('invalid refresh rotation JSON');
  }
  if (!guard(parsed)) throw new Error('invalid refresh rotation payload');
  return parsed;
}

function isSessionSnapshot(value: unknown): value is SessionRecordSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<SessionRecordSnapshot>;
  return typeof record.sessionId === 'string' && typeof record.userId === 'string' && typeof record.authVersion === 'string';
}

interface RotationOkPayload extends SessionRecordSnapshot {
  replayCache: ReplayCacheEntry;
}
function isRotationOkPayload(value: unknown): value is RotationOkPayload {
  if (!isSessionSnapshot(value)) return false;
  return 'replayCache' in value && isReplayCacheEntry(value.replayCache);
}
function isReusePayload(value: unknown): value is { presentedHash: string; operationId: string; userId: string; authVersion: string } {
  if (typeof value !== 'object' || value === null) return false;
  const reuse = value as { presentedHash?: unknown; operationId?: unknown; userId?: unknown; authVersion?: unknown };
  return (
    typeof reuse.presentedHash === 'string' &&
    typeof reuse.operationId === 'string' &&
    typeof reuse.userId === 'string' &&
    typeof reuse.authVersion === 'string'
  );
}
/** 脚本返回给应用层的最小 session 身份快照。 */
export interface SessionRecordSnapshot {
  sessionId: string;
  userId: string;
  authVersion: string;
}

/** `session:rotate` Lua 脚本（ioredis `Script` 载入；sha1 自动缓存）。 */
const ROTATE_SCRIPT = `
local sessionRaw = redis.call('GET', KEYS[1])
if sessionRaw == false then
  return 'MISS'
end
local session = cjson.decode(sessionRaw)

local presented = ARGV[1]
local newHash = ARGV[2]
local encryptedToken = ARGV[3]
local opId = ARGV[4]
local nowMs = tonumber(ARGV[5])
local replayTtl = tonumber(ARGV[6])
local currentExpiryMs = tonumber(ARGV[7])
local absoluteExpiryMs = tonumber(ARGV[8])
local nextIdleIso = ARGV[9]
local nextExpiryIso = ARGV[10]

-- SessionRecord keeps canonical ISO timestamps; JS converts both current effective and
-- absolute expiry. Lua validates key TTL against the current effective expiry in milliseconds.
if not currentExpiryMs or not absoluteExpiryMs or type(nextIdleIso) ~= 'string' or type(nextExpiryIso) ~= 'string' then return 'INVALID_SESSION' end
if currentExpiryMs <= nowMs or absoluteExpiryMs <= nowMs then return 'EXPIRED' end
local sessionTtlMs = redis.call('PTTL', KEYS[1])
if sessionTtlMs <= 0 or sessionTtlMs > currentExpiryMs - nowMs + 1000 then return 'EXPIRED' end

local replayKey = KEYS[2]
local replayRaw = redis.call('GET', replayKey)

-- 同凭证 + 同 operationId 在 30s 窗口内重放：返回上一代结果（不推进 seq、不写新摘要）。
if replayRaw ~= false then
  local replay = cjson.decode(replayRaw)
  if replay.presentedHash == presented and replay.operationId == opId and session.refreshHash == replay.newRefreshHash then
    local remainingSec = math.max(1, math.ceil(redis.call('PTTL', KEYS[1]) / 1000))
    local userKey = 'session:user:' .. session.userId
    local userTtl = redis.call('TTL', userKey)
    if userTtl == -2 or (userTtl >= 0 and userTtl < remainingSec) then redis.call('EXPIRE', userKey, remainingSec) end
    return 'REPLAY|' .. replayRaw
  end
end


if session.refreshHash ~= presented then
  -- 已消费凭证再次使用（RFC 9700 复用检测）：先持久化 sid tombstone，再撤销。
  -- Tombstone survives session deletion for at least the remaining session lifetime.
  local remainingSec = math.max(1, math.ceil(sessionTtlMs / 1000))
  redis.call('SET', 'session:revoked:' .. session.sessionId, '1', 'EX', remainingSec)
  redis.call('DEL', KEYS[1])
  if session.userId and session.userId ~= '' then
    redis.call('SREM', 'session:user:' .. session.userId, session.sessionId)
  end
  local reuse = cjson.new()
  reuse.presentedHash = presented
  reuse.operationId = opId
  reuse.userId = session.userId
  reuse.authVersion = session.authVersion
  reuse.atMs = nowMs
  local reuseJson = cjson.encode({ presentedHash = reuse.presentedHash, operationId = reuse.operationId, userId = reuse.userId, authVersion = reuse.authVersion })
  return 'REUSE|' .. reuseJson
end

-- 正常轮换：摘要推进、序号 +1、空闲窗口续期。
session.rotationSeq = (session.rotationSeq or 0) + 1
session.refreshHash = newHash
local nextExpiryMs = math.min(absoluteExpiryMs, nowMs + 7 * 24 * 3600 * 1000)
session.idleExpiry = nextIdleIso
session.expiresAt = nextExpiryIso
local remainingSec = math.ceil((nextExpiryMs - nowMs) / 1000)
if remainingSec < 1 then remainingSec = 1 end
redis.call('SET', KEYS[1], cjson.encode(session), 'EX', remainingSec)

local okCache = cjson.new()
okCache.presentedHash = presented
okCache.operationId = opId
okCache.newRefreshHash = newHash
okCache.encryptedRefreshToken = encryptedToken
okCache.result = cjson.new()
okCache.result.newRefreshHash = newHash
okCache.result.rotationSeq = session.rotationSeq
okCache.result.idleExpiryEpochMs = nextExpiryMs
local okJson = cjson.encode({ presentedHash = okCache.presentedHash, operationId = okCache.operationId, newRefreshHash = okCache.newRefreshHash, encryptedRefreshToken = okCache.encryptedRefreshToken, result = { newRefreshHash = okCache.result.newRefreshHash, rotationSeq = okCache.result.rotationSeq, idleExpiryEpochMs = okCache.result.idleExpiryEpochMs } })
redis.call('SET', replayKey, okJson, 'EX', replayTtl)

local userKey = 'session:user:' .. session.userId
local userTtl = redis.call('TTL', userKey)
if userTtl == -2 or (userTtl >= 0 and userTtl < remainingSec) then redis.call('EXPIRE', userKey, remainingSec) end

local out = cjson.new()
out.sessionId = session.sessionId
out.userId = session.userId
out.authVersion = session.authVersion
out.replayCache = okCache
return 'OK|' .. cjson.encode({ sessionId = out.sessionId, userId = out.userId, authVersion = out.authVersion, replayCache = { presentedHash = okCache.presentedHash, operationId = okCache.operationId, newRefreshHash = okCache.newRefreshHash, encryptedRefreshToken = okCache.encryptedRefreshToken, result = { newRefreshHash = okCache.result.newRefreshHash, rotationSeq = okCache.result.rotationSeq, idleExpiryEpochMs = okCache.result.idleExpiryEpochMs } } })
`;

/**
 * refresh 轮换器。Lua 脚本经 ioredis `Script` 载入（内部 sha1 缓存，
 * 脚本对象随 Redis 重启 NOSCRIPT 时 ioredis 自动重定义）。
 */
export class RefreshRotationStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  /** 载入 Lua 脚本（幂等；ioredis 内部以 sha1 缓存，重复调用无副作用）。 */
  async load(): Promise<void> {
    this.redis.defineCommand('sessionRotate', {
      lua: ROTATE_SCRIPT,
      numberOfKeys: 2,
    });
    await this.redis.script('LOAD', ROTATE_SCRIPT);
  }

  /**
   * 原子轮换（Lua）：比较当前摘要 → 推进序号 → 写新摘要 → 缓存重放结果。
   * @param presentedHash 客户端提交的 refresh token 的 sha256 hex。
   * @param newHash 新一代 refresh token 的 sha256 hex（JS 侧用随机 token 预先算好）。
   * @param operationId 客户端单飞操作 ID（§2 "同一页面/多标签协调一个操作 ID"）。
   * @param nowMs 注入时钟（UTC 毫秒）。
   * @returns 脚本判定结果；`MISS`=session 不存在（REVOKED/未知），`EXPIRED`=已过期。
   */
  async rotateRefresh(
    sid: string,
    presentedHash: string,
    newHash: string,
    encryptedRefreshToken: string,
    operationId: string,
    nowMs: number,
  ): Promise<ScriptOutcome | { kind: 'MISS' } | { kind: 'EXPIRED' }> {
    const rawSession = await this.redis.get(`session:${sid}`);
    if (rawSession === null) return { kind: 'MISS' };
    let session: { absoluteExpiry?: unknown; expiresAt?: unknown; sessionId?: unknown; userId?: unknown };
    try {
      session = JSON.parse(rawSession) as typeof session;
    } catch {
      throw new Error('invalid session JSON');
    }
    const absoluteExpiryMs = typeof session.absoluteExpiry === 'string' ? Date.parse(session.absoluteExpiry) : Number.NaN;
    const currentExpiryMs = typeof session.expiresAt === 'string' ? Date.parse(session.expiresAt) : Number.NaN;
    if (!Number.isFinite(absoluteExpiryMs) || !Number.isFinite(currentExpiryMs)) throw new Error('invalid session expiry fields');
    if (
      typeof session.sessionId !== 'string' ||
      session.sessionId !== sid ||
      typeof session.userId !== 'string' ||
      !/^\d+$/.test(session.userId)
    ) {
      throw new Error('invalid session identity fields');
    }
    const nextIdleMs = nowMs + 7 * 24 * 3600 * 1000;
    const nextExpiryMs = Math.min(absoluteExpiryMs, nextIdleMs);
    const nextIdleIso = new Date(nextIdleMs).toISOString();
    const nextExpiryIso = new Date(nextExpiryMs).toISOString();
    const sessionRotate = (this.redis as RedisClient & { sessionRotate: (...args: string[]) => Promise<unknown> }).sessionRotate;
    const result = await sessionRotate.call(
      this.redis,
      `session:${sid}`,
      `session:replay:${sid}`,
      presentedHash,
      newHash,
      encryptedRefreshToken,
      operationId,
      String(nowMs),
      String(Math.ceil(REPLAY_WINDOW_MS / 1000)),
      String(currentExpiryMs),
      String(absoluteExpiryMs),
      nextIdleIso,
      nextExpiryIso,
    );
    if (typeof result !== 'string') throw new Error('invalid refresh rotation script result type');
    if (result.startsWith('OK|')) {
      const out = decodeObject(result.slice(3), isRotationOkPayload);
      return { kind: 'OK', record: out, replayCache: out.replayCache };
    }
    if (result.startsWith('REUSE|')) {
      const reuse = decodeObject(result.slice(6), isReusePayload);
      return { kind: 'REUSE_DETECTED', record: this.minimalSnapshot(sid, reuse.userId, reuse.authVersion) };
    }
    if (result.startsWith('REPLAY|')) {
      const cache = decodeObject(result.slice(7), isReplayCacheEntry);
      return { kind: 'REPLAY', record: this.minimalSnapshot(sid, undefined, undefined), replayCache: cache };
    }
    if (result === 'MISS') return { kind: 'MISS' };
    if (result === 'EXPIRED') return { kind: 'EXPIRED' };
    if (result === 'INVALID_SESSION') throw new Error('invalid session expiry fields in Redis');
    throw new Error('unknown refresh rotation script result');
  }

  /** 复用时 Lua 一并返回撤销 session 的身份快照，供安全事件主体落库。 */
  private minimalSnapshot(sid: string, userId: string | undefined, authVersion: string | undefined): SessionRecordSnapshot {
    return { sessionId: sid, userId: userId ?? '', authVersion: authVersion ?? '' };
  }
}
