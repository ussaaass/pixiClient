/**
 * TOTP（RFC 6238，node:crypto HMAC-SHA1）纯领域实现。
 *
 * 领域所有者：identity 模块（user.totp_secret_ciphertext / totp_last_accepted_counter /
 * totp_recovery_code_hashes）。
 * 对应 SDD 章节：JWT 登录与会话设计 §5 —— "可选 TOTP 采用 RFC 6238 兼容认证器；
 * 建议标准 30 秒时间步；校验限定很窄的时钟偏差窗口，并原子推进 user 的最后接受时间步，
 * 避免重放。启用成功后同时生成一组一次性备用恢复码，建议 10 个，每码至少 80 位随机熵；
 * 明文只展示一次。数据库在 totp_recovery_code_hashes 保存逐码哈希，不保存明文。"
 *
 * 纯函数，无 IO；时钟经参数注入（用例层持 Clock）。原子推进 `totp_last_accepted_counter`
 * 防重放由用例层同事务完成（本模块只提供校验/判定，counter 推进与 user 行更新在
 * application 用例 + repository 同事务中执行）。
 */

import { createHmac, createHash, randomBytes } from 'node:crypto';
import { toBase32, fromBase32 } from '../../../infrastructure/jwt/jwt.js';

/** TOTP 参数（§5：标准 30s 时间步、HMAC-SHA1、6 位、±1 步容差窗口）。 */
export const TOTP_PARAMS = {
  periodSeconds: 30,
  digestBytes: 20,
  codeLength: 6,
  /** 时钟偏差容差（§5 "很窄的时钟偏差窗口"：±1 个时间步）。 */
  driftSteps: 1,
} as const;

/** 恢复码数量（§5 "建议 10 个"，contracts TotpEnabledResponseSchema minItems/maxItems=10）。 */
export const RECOVERY_CODE_COUNT = 10;

/**
 * 生成 TOTP 共享密钥（20 字节 = 160 位熵，base32 编码）。
 * 明文密钥不进日志/分析/QR 之外的客户端持久存储（§5）；用例层落库前认证加密。
 */
export function generateTotpSecret(): { secretBytes: Uint8Array; secretBase32: string } {
  const secretBytes = randomBytes(20);
  return { secretBytes, secretBase32: toBase32(secretBytes) };
}

/** otpauth:// 格式 URI（Authenticator 扫码用；accountName 通常为 user.username）。 */
export function totpAuthUri(secretBase32: string, accountName: string, issuer = 'GameingHall'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_PARAMS.codeLength}&period=${TOTP_PARAMS.periodSeconds}`;
}

/**
 * 计算某时间步的 TOTP 值（HOTP，RFC 4226 / RFC 6238）。
 * 纯函数：counter = floor(nowMs / 1000 / periodSeconds)。
 */
export function hotp(secretBase32: string, counter: number): string {
  const key = fromBase32(secretBase32);
  let bigIntCounter = BigInt(counter);
  const buf = Buffer.alloc(8);
  // BigInt 高位写入 8 字节大端（JS 端 counter 远小于 2^63，安全）。
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(bigIntCounter & 0xffn);
    bigIntCounter >>= 8n;
  }
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  const value = bin % 10 ** TOTP_PARAMS.codeLength;
  return value.toString().padStart(TOTP_PARAMS.codeLength, '0');
}

/** 当前时间步（floor 到 30s 边界；clock 注入）。 */
export function counterFor(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PARAMS.periodSeconds);
}

/**
 * 校验 TOTP 码（±1 步窗口；纯判定，不推进 counter）。
 * @param secretBase32 共享密钥（base32）。
 * @param code 6 位数字码。
 * @param lastCounter 最近接受时间步（十进制字符串；null 表示从未验证过）。
 * @param nowMs 时钟（UTC 毫秒）。
 * @returns 是否通过；`acceptedCounter` 为应推进到的 counter（成功时 = 当前匹配步）。
 * 防重放：用例层同事务 `UPDATE user SET totp_last_accepted_counter = :acceptedCounter
 * WHERE id = :userId AND (totp_last_accepted_counter IS NULL OR totp_last_accepted_counter < :acceptedCounter)`
 * 影响行数=0 即判重放（TOTP_INVALID）。
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  lastCounter: string | null,
  nowMs: number,
): { valid: boolean; acceptedCounter: string } {
  const current = counterFor(nowMs);
  // 窄窗口 ±1 步（§5）：只接受 [current-1, current+1]。
  const candidates = [current - TOTP_PARAMS.driftSteps, current, current + TOTP_PARAMS.driftSteps].filter((c) => c >= 0);
  for (const counter of candidates) {
    if (hotp(secretBase32, counter) === code) {
      // 单调推进：不接受比 lastCounter 更小的 counter（防回退重放）。
      const last = lastCounter === null ? -1 : Number(lastCounter);
      if (counter < last) {
        return { valid: false, acceptedCounter: String(last) };
      }
      return { valid: true, acceptedCounter: String(counter) };
    }
  }
  return { valid: false, acceptedCounter: lastCounter === null ? '0' : lastCounter };
}

/**
 * 生成一次性备用恢复码（§5 "10 个，每码至少 80 位随机熵"；
 * contracts `TotpEnabledResponseSchema` 要求 16 hex 字符 = 64 位十六进制字符，
 * 即 8 字节 = 64 位随机熵——按 contracts 的 16 hex 口径登记：每码 16 字符十六进制。
 * 明文只展示一次；落库存 sha256 哈希数组 `totp_recovery_code_hashes`。
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(randomBytes(8).toString('hex').toUpperCase()); // 8B=64 位熵 → 16 大写 hex 字符
  }
  const hashes = codes.map((c) => createHash('sha256').update(c).digest('hex'));
  return { codes, hashes };
}

/** 校验恢复码（sha256 hex 摘要匹配判定；纯函数，消费由用例层同事务原子移除）。 */
export function recoveryCodeMatches(code: string, hashes: string[] | null): { valid: boolean; index: number } {
  if (hashes === null || hashes.length === 0) return { valid: false, index: -1 };
  const hash = createHash('sha256').update(code.toUpperCase()).digest('hex');
  const index = hashes.findIndex((h) => h === hash);
  return { valid: index >= 0, index };
}

/** 恢复码脱敏（安全事件 snapshot 只记"已消耗一条恢复码"，不记明文/摘要，§3）。 */
export function maskRecoveryCode(code: string): string {
  if (code.length <= 4) return '****';
  return `${code.slice(0, 2)}****${code.slice(-2)}`;
}
