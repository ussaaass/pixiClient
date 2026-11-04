/**
 * referral 模块用例：邀请链接生成 / 读取（GET /me/invite-link +
 * POST /me/invite-link，幂等：有效期内重复签发返回同一链接）。
 *
 * 领域所有者：referral 模块（user.invite_code 读写；models/identity.ts
 * UserModel 为身份表，经本用例读 / 写邀请码，不直接查 identity 表）。
 * 对应 SDD 章节：后端实施 SDD §9 第 6 步（邀请归因返佣）、
 * docs/04_domains/邀请归因返佣与数据规范.md 第 5 节（已登录用户读取或
 * 签发自己的邀请链接；邀请码映射 user.invite_code，有效期映射
 * user.invite_code_expires_at，默认 2 年；有效期内重复签发返回同一
 * 链接，过期后才重新签发）。
 *
 * 用例语义：
 * - GET /me/invite-link：读 user.invite_code；非空且未过期 → 返回既有链接
 *   （幂等）；过期 / 空 → null（客户端调 POST 签发）；
 * - POST /me/invite-link：同 GET 语义 + 签发（缺失 / 过期才写新码，
 *   201 新签发 / 200 幂等重放）；
 * - 邀请码格式 `[A-Z0-9]{8,16}`（contracts InviteLinkDtoSchema 校验）。
 *
 * 错误码映射（REF → 触发条件）：
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / user 行缺失（可重试）。
 *
 * 邀请码生成：8 位随机 `[A-Z0-9]`（经 crypto randomBytes 取模，首版固定
 * 8 位；有效期 2 年 = 63072000 秒）。登记决策点：邀请码长度 / 有效期
 * 可经 configuration 模块注入（§9 第 7 步），首版硬编码常量。
 */

import { randomBytes } from 'node:crypto';
import type { Tx, UserInviteRepo } from '../ports/referral-repository.js';
import { ReferralDomainError, REF } from '../domain/errors.js';

/** 邀请链接 DTO（wire；ID 十进制字符串 + UTC 时间戳，对齐 contracts InviteLinkDtoSchema）。 */
export interface InviteLinkDto {
  inviteCode: string;
  url: string;
  expiresAt: string;
}

/** 邀请链接签发配置（首版硬编码常量；§9 第 7 步 configuration 落地后改经注入）。 */
export const INVITE_CODE_LENGTH = 8;
export const INVITE_CODE_TTL_SECONDS = 63072000; // 2 年（docs 第 5 节默认有效期）
const INVITE_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** 生成随机邀请码（[A-Z0-9]{8}；经 crypto.randomBytes，非可预测随机源）。 */
export function generateInviteCode(length: number = INVITE_CODE_LENGTH): string {
  const buf = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const byte = buf[i];
    if (byte === undefined) continue;
    out += INVITE_CODE_ALPHABET[(byte % INVITE_CODE_ALPHABET.length) as number];
  }
  return out;
}

/**
 * 邀请链接用例（读写 user.invite_code / invite_code_expires_at，幂等）。
 * 路由层负责认证（player token），本用例只读 user 行 + 幂等写码。
 */
export class InviteLinkUseCase {
  constructor(private readonly userInviteRepo: UserInviteRepo) {}

  /**
   * GET /me/invite-link：读既有邀请链接（非空且未过期 → 返回；否则 null）。
   * 路由层按 null 返回 200 + 空数据，引导客户端 POST 签发。
   */
  async get(userId: string, tx: Tx): Promise<InviteLinkDto | null> {
    const user = await this.userInviteRepo.findUserInvite(userId, tx);
    if (user === null) {
      throw new ReferralDomainError(REF.STORAGE_UNAVAILABLE, `用户不存在：${userId}`, { retryable: true });
    }
    if (user.inviteCode === null) return null;
    const expiresAt = user.inviteCodeExpiresAt;
    if (expiresAt !== null) {
      const exp = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
      if (exp.getTime() <= Date.now()) {
        // 已过期 → 视为无有效链接（客户端调 POST 重新签发）
        return null;
      }
    }
    return {
      inviteCode: user.inviteCode,
      url: `https://hall.gameing.example/?inviteCode=${user.inviteCode}`,
      expiresAt: toIso(expiresAt ?? new Date()),
    };
  }

  /**
   * POST /me/invite-link：签发 / 重放邀请链接（幂等：
   * 非空且未过期 → 返回既有链接 `inserted: false`；缺失 / 过期 → 写新码
   * `inserted: true`）。路由层按 `inserted` 决定 201 vs 200。
   */
  async issue(userId: string, tx: Tx): Promise<{ link: InviteLinkDto; inserted: boolean }> {
    const user = await this.userInviteRepo.findUserInvite(userId, tx);
    if (user === null) {
      throw new ReferralDomainError(REF.STORAGE_UNAVAILABLE, `用户不存在：${userId}`, { retryable: true });
    }
    if (user.inviteCode !== null) {
      const expiresAt = user.inviteCodeExpiresAt;
      const exp = expiresAt !== null ? (typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt) : null;
      if (exp !== null && exp.getTime() > Date.now()) {
        // 未过期 → 幂等重放既有链接
        return {
          link: {
            inviteCode: user.inviteCode,
            url: `https://hall.gameing.example/?inviteCode=${user.inviteCode}`,
            expiresAt: toIso(exp),
          },
          inserted: false,
        };
      }
    }
    // 缺失 / 过期 → 签发新码（有效期 2 年）
    const inviteCode = generateInviteCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITE_CODE_TTL_SECONDS * 1000);
    await this.userInviteRepo.updateUserInvite(userId, inviteCode, expiresAt, tx);
    return {
      link: {
        inviteCode,
        url: `https://hall.gameing.example/?inviteCode=${inviteCode}`,
        expiresAt: toIso(expiresAt),
      },
      inserted: true,
    };
  }
}

function toIso(d: Date | string | null): string {
  if (d === null) return new Date(0).toISOString();
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString();
}
