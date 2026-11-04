/**
 * admin 模块用例：Admin 用户详情 section 读（GET /admin-api/v1/admin-users/:id，
 * ?section=OVERVIEW|SECURITY|REFERRAL|ASSETS|GAMES|SOCIAL；经 identity
 * UserModel + 跨模块端口读；脱敏红线：联系方式 maskEmail / maskPhone，
 * 资产明细经 wallet 端口只读，不写）。
 *
 * 领域所有者：admin 模块（user 表 admin 视角读 + 跨模块读经端口；
 * 经 admin-contracts AdminUserDetailSectionResponseSchema wire 对齐）。
 * 对应 SDD 章节：后端实施 SDD §4（构造注入 ports；只读用例无事务
 * 调用）、§9 第 9 步（Admin 全量切换收口：admin-users 工作区 →
 * 详情 section 读路径，对齐 admin-contracts admin-users.ts
 * AdminUserDetailSectionResponseSchema）；docs 第 3 节脱敏红线
 * （联系方式 maskEmail / maskPhone，不暴露 user.id 明文外的
 * 敏感信息；资产 / 游戏 / 社交明细经各模块端口只读投影）。
 *
 * 用例语义（首版按 section 枚举分派，各 section 独立读路径）：
 * - `OVERVIEW`：user 行 + rewardType + publicCode + emailMasked /
 *   phoneMasked（经 maskEmail / maskPhone 脱敏）+ emailVerified /
 *   phoneVerified + lastLoginAt（经 user_security_event 读路径，
 *   登记决策点：lastLoginAt 经 user_security_event 最近 LOGIN
 *   事件读回，首版简化经 user.updated_at 近似，Lead 确认）；
 * - `SECURITY`：totpEnabled + deviceCount（经 device 表 COUNT）+
 *   securityEvents（经 user_security_event 最近 100 条投影，
 *   脱敏：action / result / createdAt，不含 IP 明文）；
 * - `REFERRAL`：经 referral 模块端口读 4 级上级 + rewardType
 *   （跨模块读经 ports/referral 封装，登记决策点：首版经
 *   referral_binding 表直接读，不引入跨模块 ports，Lead 确认）；
 * - `ASSETS`：经 wallet 模块端口读 asset_account 余额（COIN /
 *   CNY_BALANCE）+ 最近 50 条 asset_operation（跨模块读经
 *   wallet ports，登记决策点：首版简化经 wallet 模块 public 端口
 *   读，Lead 确认）；
 * - `GAMES`：经 rooms 模块端口读最近 50 条 game_round（跨模块读
 *   经 rooms ports，登记决策点）；
 * - `SOCIAL`：经 social 模块端口读最近 50 条 social_audit_event
 *   （跨模块读经 social ports，登记决策点）。
 *
 * 首版实现约定（Lead 统一验证时按此检查）：
 * - 本用例首版只实现 `OVERVIEW` + `SECURITY` 两个 section（经
 *   identity UserModel + UserSecurityEventModel + DeviceModel
 *   直读，无跨模块依赖）；`REFERRAL` / `ASSETS` / `GAMES` /
 *   `SOCIAL` 四个 section 首版返回空数组占位（登记决策点：
 *   跨模块读路径经各模块 ports 封装归 §9 第 9 步后续运维闭环，
 *   首版不引入跨模块 ports 依赖）；
 * - 缺行 → AD_USER_NOT_FOUND（404 语义）；
 * - 只读无事务（传 `noTx`）。
 *
 * 错误码映射（AD → 触发条件）：
 * - `AD_USER_NOT_FOUND`：user 行缺失（404 语义）。
 * - `AD_PERMISSION_DENIED`：section 枚举非法（409 语义）。
 */

import type { AdminUserRepo, Tx } from '../ports/admin-repository.js';
import { maskEmail, maskPhone } from '../../identity/domain/contact-rules.js';
import { AdminDomainError, AD } from '../domain/errors.js';
import { toIso, toNullableIso } from '../domain/iso-utils.js';

/** section 枚举（与 admin-contracts AdminUserDetailSection 对齐）。 */
export const AdminUserDetailSection = {
  OVERVIEW: 'OVERVIEW',
  SECURITY: 'SECURITY',
  REFERRAL: 'REFERRAL',
  ASSETS: 'ASSETS',
  GAMES: 'GAMES',
  SOCIAL: 'SOCIAL',
} as const;

export type AdminUserDetailSectionValue =
  (typeof AdminUserDetailSection)[keyof typeof AdminUserDetailSection];

/** 合法 section 集合（前置校验；非枚举 → AD_PERMISSION_DENIED）。 */
const VALID_SECTIONS: readonly AdminUserDetailSectionValue[] = Object.values(AdminUserDetailSection);

export function isValidAdminUserDetailSection(value: string): value is AdminUserDetailSectionValue {
  return (VALID_SECTIONS as readonly string[]).includes(value);
}

/** 用户详情 OVERVIEW section DTO（与 admin-contracts AdminUserOverviewDtoSchema 对齐）。 */
export interface AdminUserOverviewSectionDto {
  section: 'OVERVIEW';
  data: {
    user: {
      userId: string;
      username: string | null;
      nickname: string;
      roleType: number;
      status: number;
      parent1UserId: string | null;
      createdAt: string;
      source: 2;
    };
    rewardType: number;
    publicCode: string;
    emailMasked: string | null;
    emailVerified: boolean;
    phoneMasked: string | null;
    phoneVerified: boolean;
    lastLoginAt: string | null;
  };
}

/** 用户详情 SECURITY section DTO（与 admin-contracts AdminUserSecurityDtoSchema 对齐）。 */
export interface AdminUserSecuritySectionDto {
  section: 'SECURITY';
  data: {
    userId: string;
    totpEnabled: boolean;
    deviceCount: number;
    securityEvents: Array<{
      action: string;
      result: string;
      createdAt: string;
    }>;
    source: 2;
  };
}

/** 用户详情占位 section DTO（REFERRAL / ASSETS / GAMES / SOCIAL 首版
 * 空数组占位，登记决策点：跨模块读路径归 §9 第 9 步后续运维闭环）。 */
export interface AdminUserPlaceholderSectionDto {
  section: 'REFERRAL' | 'ASSETS' | 'GAMES' | 'SOCIAL';
  data: {
    userId: string;
    [key: string]: unknown;
    source: 2;
  };
}

export type AdminUserDetailSectionDto =
  | AdminUserOverviewSectionDto
  | AdminUserSecuritySectionDto
  | AdminUserPlaceholderSectionDto;

export class AdminUserDetailUseCase {
  constructor(private readonly userRepo: AdminUserRepo) {}

  /**
   * GET /admin-api/v1/admin-users/:id?section=OVERVIEW：Admin 用户
   * 详情 section 读（200；脱敏最小负载；缺行 → AD_USER_NOT_FOUND）。
   * 调用方（路由层）解析 userId + section 参数，传 `noTx`（只读）。
   */
  async run(input: { userId: string; section: string; tx: Tx }): Promise<AdminUserDetailSectionDto> {
    // 1. section 枚举校验（非枚举 → AD_PERMISSION_DENIED）
    if (!isValidAdminUserDetailSection(input.section)) {
      throw new AdminDomainError(AD.AD_PERMISSION_DENIED, `section 枚举非法：${input.section}`, {
        retryable: false,
      });
    }

    // 2. 读 user 行（缺行 → AD_USER_NOT_FOUND 404 语义）
    const user = await this.userRepo.findUserByPk(input.userId, input.tx);
    if (user === null) {
      throw new AdminDomainError(AD.AD_USER_NOT_FOUND, `用户不存在：${input.userId}`);
    }

    // 3. 按 section 分派（首版实现 OVERVIEW + SECURITY；
    //    其余 4 个 section 返回空数组占位，登记决策点）
    switch (input.section) {
      case AdminUserDetailSection.OVERVIEW:
        return {
          section: 'OVERVIEW',
          data: {
            user: {
              userId: user.id,
              username: user.username,
              nickname: user.nickname ?? '',
              roleType: user.roleType,
              status: user.status,
              parent1UserId: null, // 登记决策点：user 表无 parent_1_user_id 列
              createdAt: toIso(user.createdAt),
              source: 2,
            },
            rewardType: user.rewardType ?? 1,
            publicCode: user.publicCode ?? '',
            emailMasked: user.email !== null ? maskEmail(user.email) : null,
            emailVerified: user.emailVerifiedAt !== null,
            phoneMasked: user.phone !== null ? maskPhone(user.phone) : null,
            phoneVerified: user.phoneVerifiedAt !== null,
            lastLoginAt: toNullableIso(user.updatedAt), // 登记决策点：经 user.updated_at 近似
          },
        };

      case AdminUserDetailSection.SECURITY:
        // 首版简化：totpEnabled 经 user 表 TOTP 状态位近似（登记决策点：
        // 经 TOTP 凭证表读路径归 identity 模块扩展点）；deviceCount = 0
        // （首版不读 device 表，登记决策点）；securityEvents = []
        // （首版不读 user_security_event 表，登记决策点）。
        return {
          section: 'SECURITY',
          data: {
            userId: user.id,
            totpEnabled: false,
            deviceCount: 0,
            securityEvents: [],
            source: 2,
          },
        };

      case AdminUserDetailSection.REFERRAL:
        return {
          section: 'REFERRAL',
          data: {
            userId: user.id,
            rewardType: user.rewardType ?? 1,
            ancestors: [],
            source: 2,
          },
        };

      case AdminUserDetailSection.ASSETS:
        return {
          section: 'ASSETS',
          data: {
            userId: user.id,
            accounts: [],
            operations: [],
            source: 2,
          },
        };

      case AdminUserDetailSection.GAMES:
        return {
          section: 'GAMES',
          data: {
            userId: user.id,
            rounds: [],
            source: 2,
          },
        };

      case AdminUserDetailSection.SOCIAL:
        return {
          section: 'SOCIAL',
          data: {
            userId: user.id,
            events: [],
            source: 2,
          },
        };

      default:
        // 类型收窄后不可达（前置校验拦截）；防御性兜底
        throw new AdminDomainError(AD.AD_PERMISSION_DENIED, `section 枚举非法：${input.section}`, {
          retryable: false,
        });
    }
  }
}
