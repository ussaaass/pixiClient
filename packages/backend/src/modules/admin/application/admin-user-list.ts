/**
 * admin 模块用例：Admin 用户列表（GET /admin-api/v1/admin-users，
 * 游标分页 50/页；admin 视角读 user 表，经 identity UserModel，
 * 不写；筛选 userId / username / roleType / status；
 * 脱敏红线：列表只返回用户名 / 昵称 / 角色 / 状态 / 上级引用，
 * 不含联系方式 / 设备 / 资产明细，docs 第 3 节红线）。
 *
 * 领域所有者：admin 模块（user 表 admin 视角只读；经 identity
 * UserModel，不写 user 表；admin-audit 工作区读路径）。
 * 对应 SDD 章节：后端实施 SDD §4（构造注入 ports，只读用例
 * 无事务调用）、§9 第 9 步（Admin 全量切换收口：admin-users
 * 工作区 → user 列表 / 详情读路径）；数据库设计 SDD §5.1（user
 * 表 role_type 位标记 PLAYER=1/AGENT=2/ADMIN=4/SYSTEM=8，
 * 合法组合 1、3、4、8）。
 *
 * 用例语义：
 * - 游标分页 `{createdAt ISO}~{id}` 稳定游标（50/页；noUnchecked
 *   IndexedAccess 防护：`last !== undefined` 判定，items.length ===
 *   limit 时 nextCursor 非 null）；
 * - 筛选条件经 `Op.and` 桥接（unique symbol，TS2538 经
 *   `as unknown as string` 写法）；
 * - 脱敏：列表项只含 userId / username / nickname / roleType /
 *   status / parent1UserId / createdAt / source，不含 email / phone
 *   / 资产明细（docs 第 3 节"Admin 列表脱敏"红线）；
 * - `source` 字段首版恒 2（SERVER，经 AdminUserSource 常量），
 *   与 admin-contracts AdminUserSource 对齐。
 *
 * 错误码映射：
 * - 无领域错误（只读；Sequelize 故障经路由层统一 5xx 映射）。
 */

import type { AdminUserRepo, Tx } from '../ports/admin-repository.js';
import { toIso } from '../domain/iso-utils.js';

/** 用户列表筛选条件（路由层经 query 解析；缺省 = 全量游标翻页）。 */
export interface AdminUserListFilters {
  userId?: string | undefined;
  username?: string | undefined;
  roleType?: number | undefined;
  status?: number | undefined;
}

/** 用户列表项（wire DTO；脱敏最小负载，docs 第 3 节红线）。 */
export interface AdminUserItemDto {
  userId: string;
  username: string | null;
  nickname: string;
  roleType: number;
  status: number;
  parent1UserId: string | null;
  createdAt: string;
  source: 2; // AdminUserSource.SERVER
}

export interface AdminUserPageDto {
  items: AdminUserItemDto[];
  nextCursor: string | null;
}

export const ADMIN_USER_PAGE_LIMIT = 50;

export class AdminUserListUseCase {
  constructor(private readonly userRepo: AdminUserRepo) {}

  /**
   * GET /admin-api/v1/admin-users：Admin 用户列表（200；游标分页
   * 50/页；筛选经 query；脱敏最小负载）。
   * 调用方（路由层）解析 cursor + 筛选参数，传 `noTx`（只读无事务）。
   */
  async list(input: {
    cursor: string | null;
    filters: AdminUserListFilters;
    tx: Tx;
  }): Promise<AdminUserPageDto> {
    const limit = ADMIN_USER_PAGE_LIMIT;
    const result = await this.userRepo.listUsers({
      cursor: input.cursor,
      limit,
      userId: input.filters.userId,
      username: input.filters.username,
      roleType: input.filters.roleType,
      status: input.filters.status,
      tx: input.tx,
    });

    const items: AdminUserItemDto[] = result.items.map((user) => ({
      userId: user.id,
      username: user.username,
      nickname: user.nickname ?? '',
      roleType: user.roleType,
      status: user.status,
      parent1UserId: null, // 登记决策点：user 表无 parent_1_user_id 列，经 referral_binding 表反查归 §9 第 6 步 referral 模块
      createdAt: toIso(user.createdAt),
      source: 2,
    }));

    return {
      items,
      nextCursor: result.nextCursor,
    };
  }
}
