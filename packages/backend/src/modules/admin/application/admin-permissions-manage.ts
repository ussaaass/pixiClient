import { AdminDomainError, AD } from '../domain/errors.js';
import { validateAuditSnapshot } from '../domain/audit-rules.js';
import type { AdminAuditEventRepo, AdminPermissionRepo, AdminUserRepo, Tx } from '../ports/admin-repository.js';

export const ADMIN_PERMISSIONS_MANAGE_CODE = 'admin.permissions.manage';
export const ADMIN_PERMISSIONS_MANAGE_ROUTE = { method: 'PATCH', path: '/api/v1/admin/users/:user_id/permissions' } as const;
const ADMIN_ROLE_BIT = 4;
const USER_ACTIVE = 1;
const PERMISSION_ACTIVE = 1;
const MAX_AUTH_VERSION = 18446744073709551615n;

export interface ManagedAdminPermissionDto {
  userId: string;
  username: string;
  roleType: number;
  status: number;
  permissions: string[];
  authVersion: string;
  source: 2;
}

export interface AdminPermissionAuditDto {
  auditId: string;
  adminUserId: string;
  targetAdminUserId: string;
  requestKey: string;
  reason: string;
  previousPermissions: string[];
  nextPermissions: string[];
  previousAuthVersion: string;
  nextAuthVersion: string;
  createdAt: string;
  action: 'PERMISSIONS_UPDATED';
  source: 2;
}

function adminDto(user: {
  id: string;
  username: string | null;
  roleType: number;
  status: number;
  permissions: string[];
  authVersion: string;
}): ManagedAdminPermissionDto {
  if (user.username === null) throw new AdminDomainError(AD.AD_USER_NOT_FOUND, 'Admin 账号未设置用户名。');
  return {
    userId: user.id,
    username: user.username,
    roleType: 4,
    status: user.status,
    permissions: [...user.permissions],
    authVersion: user.authVersion,
    source: 2,
  };
}

export class AdminPermissionsManageUseCase {
  constructor(
    private readonly permissionRepo: AdminPermissionRepo,
    private readonly userRepo: AdminUserRepo,
    private readonly auditRepo: AdminAuditEventRepo,
  ) {}

  async listPaths(input: {
    tx: Tx;
  }): Promise<Array<{ permissionCode: string; name: string; httpMethod: string; pathPattern: string; status: number }>> {
    const rows = await this.permissionRepo.listActivePermissions(input.tx);
    return rows
      .filter((row) => row.status === PERMISSION_ACTIVE && row.deletedAt == null)
      .map((row) => ({
        permissionCode: row.permissionCode,
        name: row.name,
        httpMethod: row.httpMethod,
        pathPattern: row.pathPattern,
        status: row.status,
      }));
  }

  async getUser(input: { userId: string; tx: Tx }): Promise<ManagedAdminPermissionDto> {
    const user = await this.userRepo.findUserByPk(input.userId, input.tx);
    if (user === null || user.deletedAt != null || (user.roleType & ADMIN_ROLE_BIT) === 0) {
      throw new AdminDomainError(AD.AD_USER_NOT_FOUND, `Admin 用户不存在：${input.userId}`);
    }
    return adminDto(user);
  }

  async listUserAuditEvents(input: { targetAdminUserId: string; tx: Tx }): Promise<AdminPermissionAuditDto[]> {
    const target = await this.userRepo.findUserByPk(input.targetAdminUserId, input.tx);
    if (target === null || target.deletedAt != null || (target.roleType & ADMIN_ROLE_BIT) === 0) {
      throw new AdminDomainError(AD.AD_USER_NOT_FOUND, `Admin 用户不存在：${input.targetAdminUserId}`);
    }
    const events = await this.auditRepo.listPermissionAuditsForTarget(input.targetAdminUserId, input.tx);
    return events.map((event) => {
      const snapshot = event.snapshot as Record<string, unknown>;
      return {
        auditId: event.id,
        adminUserId: event.adminUserId,
        targetAdminUserId: input.targetAdminUserId,
        requestKey: event.requestKey,
        reason: event.reason,
        previousPermissions: snapshot.previousPermissions as string[],
        nextPermissions: snapshot.nextPermissions as string[],
        previousAuthVersion: String(snapshot.previousAuthVersion),
        nextAuthVersion: String(snapshot.nextAuthVersion),
        createdAt: typeof event.createdAt === 'string' ? event.createdAt : event.createdAt.toISOString(),
        action: 'PERMISSIONS_UPDATED',
        source: 2,
      };
    });
  }

  async listUsers(input: { query?: string; status?: number; permissionCode?: string; tx: Tx }): Promise<ManagedAdminPermissionDto[]> {
    const result = await this.userRepo.listUsers({ cursor: null, limit: 100, roleType: ADMIN_ROLE_BIT, tx: input.tx });
    let users = result.items.filter(
      (user) =>
        user.deletedAt == null && (user.roleType & ADMIN_ROLE_BIT) !== 0 && (input.status === undefined || user.status === input.status),
    );
    if (input.query) {
      const query = input.query.toLocaleLowerCase();
      users = users.filter((user) => user.id.includes(query) || user.username?.toLocaleLowerCase().includes(query));
    }
    if (input.permissionCode) users = users.filter((user) => user.permissions.includes(input.permissionCode!));
    return users.map(adminDto);
  }

  async update(input: {
    actorUserId: string;
    actorSessionKey: string | null;
    targetUserId: string;
    permissionCodes: readonly string[];
    requestKey: string;
    reason: string;
    ipHashHex: string;
    tx: Tx;
  }): Promise<{ user: ManagedAdminPermissionDto; audit: AdminPermissionAuditDto; replayed: boolean }> {
    if (input.requestKey.length < 8 || input.requestKey.length > 128 || input.reason.trim().length < 3 || input.reason.length > 500) {
      throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '权限变更请求格式不合法。');
    }
    if (new Set(input.permissionCodes).size !== input.permissionCodes.length || input.permissionCodes.length > 128) {
      throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '权限码重复或数量超限。');
    }
    const actor = await this.userRepo.findUserByPk(input.actorUserId, input.tx);
    if (actor === null || actor.deletedAt != null || actor.status !== USER_ACTIVE || (actor.roleType & ADMIN_ROLE_BIT) === 0) {
      throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '操作者不再具备 active Admin 身份。');
    }
    const manage = await this.permissionRepo.findPermissionByRoute(
      ADMIN_PERMISSIONS_MANAGE_ROUTE.method,
      ADMIN_PERMISSIONS_MANAGE_ROUTE.path,
      input.tx,
    );
    if (
      !manage ||
      manage.status !== PERMISSION_ACTIVE ||
      manage.deletedAt != null ||
      manage.permissionCode !== ADMIN_PERMISSIONS_MANAGE_CODE ||
      !actor.permissions.includes(ADMIN_PERMISSIONS_MANAGE_CODE)
    ) {
      throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '缺少有效的 admin.permissions.manage 授权。');
    }
    const codes = [...input.permissionCodes].sort();
    const directory = await this.permissionRepo.findPermissionsByCodes(codes, input.tx);
    if (
      directory.length !== codes.length ||
      directory.some((permission) => permission.status !== PERMISSION_ACTIVE || permission.deletedAt != null)
    ) {
      throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '权限列表包含未登记、停用或已删除权限。');
    }
    const existingAudit = await this.auditRepo.findPermissionAuditByRequestKey(input.requestKey, input.tx);
    const target = await this.userRepo.lockPermissionTargetUser(input.targetUserId, input.tx);
    if (existingAudit !== null) {
      const snapshot = existingAudit.snapshot as Record<string, unknown>;
      const requested = [...input.permissionCodes].sort();
      const sameIntent =
        existingAudit.adminUserId === input.actorUserId &&
        existingAudit.targetAdminUserId === input.targetUserId &&
        existingAudit.reason === input.reason.trim() &&
        input.permissionCodes.length === requested.length &&
        Array.isArray(snapshot.nextPermissions) &&
        JSON.stringify(snapshot.nextPermissions) === JSON.stringify(requested);
      if (!sameIntent || target === null || target.deletedAt != null || (target.roleType & ADMIN_ROLE_BIT) === 0) {
        throw new AdminDomainError(AD.AD_PERMISSION_DENIED, 'requestKey 已用于其他权限变更。');
      }
      const user = adminDto(target);
      if (target.status !== USER_ACTIVE) throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '锁定账号不能重放权限变更。');
      if (JSON.stringify(user.permissions.slice().sort()) !== JSON.stringify(requested)) {
        throw new AdminDomainError(AD.AD_PERMISSION_DENIED, 'requestKey 对应授权已被后续变更覆盖，不可重放旧操作。');
      }
      const previousPermissions = snapshot.previousPermissions;
      const previousAuthVersion = snapshot.previousAuthVersion;
      const nextAuthVersion = snapshot.nextAuthVersion;
      const validPermissionSnapshot = (value: unknown): value is string[] =>
        Array.isArray(value) && value.every((code) => typeof code === 'string') && new Set(value).size === value.length;
      if (
        !validPermissionSnapshot(previousPermissions) ||
        !validPermissionSnapshot(snapshot.nextPermissions) ||
        typeof previousAuthVersion !== 'string' ||
        !/^[1-9][0-9]*$/.test(previousAuthVersion) ||
        typeof nextAuthVersion !== 'string' ||
        !/^[1-9][0-9]*$/.test(nextAuthVersion) ||
        !/^[1-9][0-9]*$/.test(target.authVersion) ||
        BigInt(nextAuthVersion) !== BigInt(previousAuthVersion) + 1n ||
        BigInt(target.authVersion) !== BigInt(nextAuthVersion)
      ) {
        throw new AdminDomainError(AD.STORAGE_UNAVAILABLE, '权限审计快照不合法。', { retryable: true });
      }
      return {
        user,
        audit: {
          auditId: existingAudit.id,
          adminUserId: existingAudit.adminUserId,
          targetAdminUserId: input.targetUserId,
          requestKey: input.requestKey,
          reason: existingAudit.reason,
          previousPermissions: Array.isArray(snapshot.previousPermissions) ? (snapshot.previousPermissions as string[]) : [],
          nextPermissions: requested,
          previousAuthVersion: String(snapshot.previousAuthVersion),
          nextAuthVersion: String(snapshot.nextAuthVersion),
          createdAt: typeof existingAudit.createdAt === 'string' ? existingAudit.createdAt : existingAudit.createdAt.toISOString(),
          action: 'PERMISSIONS_UPDATED',
          source: 2,
        },
        replayed: true,
      };
    }
    if (target === null || target.deletedAt != null || (target.roleType & ADMIN_ROLE_BIT) === 0) {
      throw new AdminDomainError(AD.AD_USER_NOT_FOUND, `Admin 用户不存在：${input.targetUserId}`);
    }
    if (target.status !== USER_ACTIVE) throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '锁定账号不能变更权限。');
    const previous = [...target.permissions].sort();
    if (previous.join('\n') === codes.join('\n')) throw new AdminDomainError(AD.AD_PERMISSION_DENIED, '权限没有变化。');
    const previousVersion = BigInt(target.authVersion);
    if (previousVersion < 1n || previousVersion >= MAX_AUTH_VERSION)
      throw new AdminDomainError(AD.STORAGE_UNAVAILABLE, '目标用户 auth_version 无法递增。', { retryable: true });
    const nextVersion = String(previousVersion + 1n);
    const updated = await this.userRepo.updateUserPermissions({
      userId: target.id,
      expectedAuthVersion: target.authVersion,
      permissions: codes,
      tx: input.tx,
    });
    if (updated !== 1) throw new AdminDomainError(AD.STORAGE_UNAVAILABLE, '更新 Admin 权限发生并发冲突。', { retryable: true });
    const snapshot = validateAuditSnapshot({
      previousPermissions: previous,
      nextPermissions: codes,
      previousAuthVersion: target.authVersion,
      nextAuthVersion: nextVersion,
    });
    const auditResult = await this.auditRepo.createAuditEvent({
      adminUserId: input.actorUserId,
      adminSessionKey: input.actorSessionKey,
      userId: null,
      targetAdminUserId: target.id,
      assetOperationId: null,
      withdrawalId: null,
      systemConfigId: null,
      gameConfigId: null,
      agentDomainId: null,
      referralBindingEventId: null,
      supportConversationId: null,
      coinMarketTradeId: null,
      requestKey: input.requestKey,
      actionCode: 'ADMIN_PERMISSIONS_UPDATED',
      resultType: 1,
      reason: input.reason.trim(),
      snapshot,
      ipHashHex: input.ipHashHex,
      tx: input.tx,
    });
    const event = auditResult.event;
    return {
      user: { ...adminDto(target), permissions: codes, authVersion: nextVersion },
      audit: {
        auditId: event.id,
        adminUserId: input.actorUserId,
        targetAdminUserId: target.id,
        requestKey: input.requestKey,
        reason: input.reason.trim(),
        previousPermissions: previous,
        nextPermissions: codes,
        previousAuthVersion: target.authVersion,
        nextAuthVersion: nextVersion,
        createdAt: typeof event.createdAt === 'string' ? event.createdAt : event.createdAt.toISOString(),
        action: 'PERMISSIONS_UPDATED',
        source: 2,
      },
      replayed: !auditResult.inserted,
    };
  }
}
