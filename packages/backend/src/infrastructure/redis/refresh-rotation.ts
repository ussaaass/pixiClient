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
 * - `session:replay:{sid}`：Lua 写入的"上一代刷新结果"JSON
 *   `{ presentedHash, operationId, newRefreshHash, result, atMs }`，
 *   每次成功轮换覆盖，TTL 固定 30s（REPLAY_WINDOW_MS）。
 *   读侧先 GET 该 key，命中且 presentedHash+operationId 相同即重放原结果（JS 侧，
 *   不进 Lua——重放返回的是上一代结果而非新代，不推进 seq）。
 *
 * Lua 契约（`session:rotate` 脚本，由 ioredis `Script` 自动 SHA1 缓存，NOSCRIPT 自动重定义）：
 *   KEYS[1] = session:{sid}（SessionRecord JSON）
 *   KEYS[2] = session:replay:{sid}（上一代结果 JSON）
 *   ARGV[1] = presentedHash（客户端提交的 refresh token 的 sha256 hex）
 *   ARGV[2] = newHash（新一代 refresh token 的 sha256 hex，JS 侧预先算好）
 *   ARGV[3] = operationId（客户端单飞操作 ID）
 *   ARGV[4] = nowMs（UTC 毫秒，由 JS 注入时钟，脚本内不用 TIME）
 *   ARGV[5] = replayTtlSeconds（30，REPLAY_WINDOW_MS/1000）
 *
 * 返回值（单元素表）：
 *   `OK|{json}`     —— 成功轮换：{ sessionId, refreshHash(new), rotationSeq, replayCache:{...} }
 *   `REUSE|{json}`  —— 已消费凭证再次使用（复用检测）：{ revoked:true, replayCache:{...} }
 *                      撤销整 session + user Set 成员（revoke 的 user Set 摘除由 JS 侧
 *                      依据返回补做，脚本内无法安全地枚举 user Set —— 脚本拿到的是
 *                      session JSON，user Set key 形如 session:user:{userId}，脚本可构造）。
 */

import type { RedisClient } from './client.js';

/** 弱网重放窗口（§3 推荐 30 秒；"刷新响应丢失仅重放一次既有结果"）。 */
export const REPLAY_WINDOW_MS = 30 * 1000;

/** 轮换结果：成功。 */
export interface RotationOk {
  kind: 'OK';
  /** 新一代 refresh token 的 sha256（与 JS 侧传入的 newHash 一致，回显便于对账）。 */
  newRefreshHash: string;
  /** 推进后的轮换序号。 */
  rotationSeq: number;
  /** 新一代空闲到期（ISO 8601 UTC）。 */
  idleExpiry: string;
}

/** 轮换结果：已消费凭证再次使用（§3 撤销该 session + 持久安全事件）。 */
export interface RotationReuse {
  kind: 'REUSE_DETECTED';
  /** 撤销时该 session 所属 user（供 JS 侧写 user_security_event + 摘 user Set）。 */
  userId: string;
}

export type RotationResult = RotationOk | RotationReuse;

/** 重放缓存命中：同一代结果原样返回（不生成新代、不推进 seq）。 */
export interface ReplayCacheEntry {
  presentedHash: string;
  operationId: string;
  newRefreshHash: string;
  result: RotationOk;
  /** 缓存写入时间（UTC 毫秒）。 */
  atMs: number;
}

/** 脚本返回解析后的联合类型。 */
export type ScriptOutcome =
  | { kind: 'OK'; record: SessionRecordSnapshot; replayCache: ReplayCacheEntry }
  | { kind: 'REUSE_DETECTED'; record: SessionRecordSnapshot; replayCache: ReplayCacheEntry }
  | { kind: 'REPLAY'; record: SessionRecordSnapshot; replayCache: ReplayCacheEntry };
/** 脚本视角的 session 快照（只需轮换相关字段）。 */
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
local opId = ARGV[3]
local nowMs = tonumber(ARGV[4])
local replayTtl = tonumber(ARGV[5])

local sessionTtlMs = (session.expiryEpochMs or 0) - nowMs
if sessionTtlMs <= 0 then
  return 'EXPIRED'
end

local replayKey = KEYS[2]
local replayRaw = redis.call('GET', replayKey)

-- 同凭证 + 同 operationId 在 30s 窗口内重放：返回上一代结果（不推进 seq、不写新摘要）。
if replayRaw ~= false then
  local replay = cjson.decode(replayRaw)
  if replay.presentedHash == presented and replay.operationId == opId then
    return 'REPLAY|' .. replayRaw
  end
end

if session.refreshHash ~= presented then
  -- 已消费凭证再次使用（RFC 9700 复用检测）：撤销整 session。
  -- session key TTL 缩短到立即过期效果不彻底（同实例窗口内仍可读），直接 DEL。
  redis.call('DEL', KEYS[1])
  if session.userId and session.userId ~= '' then
    redis.call('SREM', 'session:user:' .. session.userId, session.sessionId)
  end
  local reuse = cjson.new()
  reuse.presentedHash = presented
  reuse.operationId = opId
  reuse.atMs = nowMs
  local reuseJson = cjson.encode(reuse)
  return 'REUSE|' .. reuseJson
end

-- 正常轮换：摘要推进、序号 +1、空闲窗口续期。
session.rotationSeq = (session.rotationSeq or 0) + 1
session.refreshHash = newHash
session.idleExpiryEpochMs = nowMs + 7 * 24 * 3600 * 1000
local absolute = session.absoluteExpiryEpochMs or 0
session.expiryEpochMs = math.min(absolute, session.idleExpiryEpochMs)
local remainingSec = math.ceil((session.expiryEpochMs - nowMs) / 1000)
if remainingSec < 1 then remainingSec = 1 end
redis.call('SET', KEYS[1], cjson.encode(session), 'EX', remainingSec)

local okCache = cjson.new()
okCache.presentedHash = presented
okCache.operationId = opId
okCache.newRefreshHash = newHash
okCache.result = cjson.new()
okCache.result.newRefreshHash = newHash
okCache.result.rotationSeq = session.rotationSeq
okCache.result.idleExpiryEpochMs = session.idleExpiryEpochMs
local okJson = cjson.encode(okCache)
redis.call('SET', replayKey, okJson, 'EX', replayTtl)

local userKey = 'session:user:' .. session.userId
redis.call('EXPIRE', userKey, remainingSec)

local out = cjson.new()
out.sessionId = session.sessionId
out.userId = session.userId
out.authVersion = session.authVersion
return 'OK|' .. cjson.encode(out)
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
    operationId: string,
    nowMs: number,
  ): Promise<ScriptOutcome | { kind: 'MISS' } | { kind: 'EXPIRED' }> {
    const result = await this.redis.call(
      'sessionRotate',
      `session:${sid}`,
      `session:replay:${sid}`,
      presentedHash,
      newHash,
      operationId,
      String(nowMs),
      String(Math.ceil(REPLAY_WINDOW_MS / 1000)),
    );
    if (typeof result !== 'string') return { kind: 'MISS' };
    if (result.startsWith('OK|')) {
      const out = JSON.parse(result.slice(3)) as SessionRecordSnapshot;
      const cache = await this.getReplayCache(sid);
      return {
        kind: 'OK',
        record: out,
        replayCache: cache ?? {
          presentedHash,
          operationId,
          newRefreshHash: newHash,
          result: {
            kind: 'OK',
            newRefreshHash: newHash,
            rotationSeq: 0,
            idleExpiry: new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString(),
          },
          atMs: nowMs,
        },
      };
    }
    if (result.startsWith('REUSE|')) {
      const reuse = JSON.parse(result.slice(6)) as Partial<ReplayCacheEntry> & { userId?: string; authVersion?: string };
      const record = this.minimalSnapshot(sid, reuse.userId, reuse.authVersion);
      return {
        kind: 'REUSE_DETECTED',
        record,
        replayCache: {
          presentedHash: reuse.presentedHash ?? presentedHash,
          operationId: reuse.operationId ?? operationId,
          newRefreshHash: reuse.newRefreshHash ?? '',
          result: {
            kind: 'OK',
            newRefreshHash: reuse.newRefreshHash ?? '',
            rotationSeq: 0,
            idleExpiry: new Date(nowMs).toISOString(),
          },
          atMs: reuse.atMs ?? nowMs,
        },
      };
    }
    if (result.startsWith('REPLAY|')) {
      const cache = JSON.parse(result.slice(7)) as ReplayCacheEntry;
      return { kind: 'REPLAY', record: this.minimalSnapshot(sid, undefined, undefined), replayCache: cache };
    }
    if (result === 'MISS') return { kind: 'MISS' };
    return { kind: 'EXPIRED' };
  }

  /** 复用/重放时 session 已被撤销，构造最小快照供安全事件落库（userId 可能未知）。 */
  private minimalSnapshot(sid: string, userId: string | undefined, authVersion: string | undefined): SessionRecordSnapshot {
    return { sessionId: sid, userId: userId ?? '', authVersion: authVersion ?? '' };
  }

  /**
   * 弱网重放窗口读取（JS 侧，不进 Lua）：命中同凭证+同 operationId 返回上一代结果。
   * 用例层在调用 `rotateRefresh` 前先查本方法：
   * - 命中 → 直接重放 `replayCache.result`（同一代，不生成新代）；
   * - 未命中/窗口外/不同 operationId → 走 `rotateRefresh` 的 Lua 路径，
   *   Lua 内已消费凭证 + 不同 opId/窗口外 判 `REUSE_DETECTED`（§3 复用检测）。
   *
   * 复用检测补查：session 被 Lua DEL 后无法再取 userId，调用前用 `getSession` 预判并透传，
   * 兜底时 record.userId 为空串，安全事件以 presentedHash 作为关联键（不阻断撤销本身）。
   */
  async getReplayCache(sid: string): Promise<ReplayCacheEntry | null> {
    const raw = await this.redis.get(`session:replay:${sid}`);
    return raw === null ? null : (JSON.parse(raw) as ReplayCacheEntry);
  }

  /** 重放命中判定：同凭证 + 同 operationId + 窗口未过（30s）。 */
  async isReplayHit(sid: string, presentedHash: string, operationId: string, nowMs: number): Promise<ReplayCacheEntry | null> {
    const cache = await this.getReplayCache(sid);
    if (cache === null) return null;
    if (cache.presentedHash !== presentedHash || cache.operationId !== operationId) return null;
    if (nowMs - cache.atMs > REPLAY_WINDOW_MS) return null;
    return cache;
  }
}
