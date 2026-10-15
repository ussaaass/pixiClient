import { Value } from '@sinclair/typebox/value';
import {
  AdminManagedUserDtoSchema,
  AdminManagedUserRoleType,
  AdminManagedUserStatus,
  AdminPermissionAction,
  AdminPermissionAuditDtoSchema,
  AdminPermissionChangeRequestSchema,
  AdminPermissionChangeResponseSchema,
  AdminPermissionListQuerySchema,
  AdminPermissionPathDtoSchema,
  AdminPermissionSource,
  AdminPermissionStatus,
  type AdminManagedUserDto,
  type AdminPermissionAuditDto,
  type AdminPermissionChangeRequestDto,
  type AdminPermissionChangeResponseDto,
  type AdminPermissionListQueryDto,
  type AdminPermissionPathDto,
} from '@gameing/admin-contracts/admin-permissions';
import { ADMIN_PERMISSION_PATHS } from './admin-permission-registry';

export type AdminPermissionFailure = 'INVALID_REQUEST' | 'USER_NOT_FOUND' | 'USER_LOCKED' | 'UNKNOWN_PERMISSION' | 'NO_CHANGE' | 'REQUEST_KEY_REUSED' | 'READ_FAILED' | 'WRITE_FAILED';
export type AdminPermissionResult<T> = { ok: true; value: T } | { ok: false; code: AdminPermissionFailure };

export interface AdminPermissionRepositoryPort {
  listUsers(): Promise<AdminManagedUserDto[]>;
  findUser(userId: string): Promise<AdminManagedUserDto | null>;
  listAudits(targetAdminUserId?: string): Promise<AdminPermissionAuditDto[]>;
  findAuditByRequestKey(requestKey: string): Promise<AdminPermissionAuditDto | null>;
  commit(user: AdminManagedUserDto, audit: AdminPermissionAuditDto): Promise<void>;
  createId(): string;
  now(): string;
}

export interface AdminPermissionApplication {
  listPaths(): AdminPermissionResult<AdminPermissionPathDto[]>;
  listUsers(query: unknown): Promise<AdminPermissionResult<AdminManagedUserDto[]>>;
  listAudits(targetAdminUserId?: unknown): Promise<AdminPermissionResult<AdminPermissionAuditDto[]>>;
  updatePermissions(request: unknown): Promise<AdminPermissionResult<AdminPermissionChangeResponseDto>>;
}

const LOCAL_OPERATOR_ADMIN_USER_ID = '90001';
const ID_PATTERN = /^[1-9][0-9]{0,19}$/;

function sameCommand(request: AdminPermissionChangeRequestDto, audit: AdminPermissionAuditDto): boolean {
  return request.targetAdminUserId === audit.targetAdminUserId
    && [...request.permissionCodes].sort().join('\n') === [...audit.nextPermissions].sort().join('\n')
    && request.reason.trim() === audit.reason;
}

function matchesAuditRequest(request: AdminPermissionChangeRequestDto, audit: AdminPermissionAuditDto, previous: AdminManagedUserDto | null): boolean {
  return sameCommand(request, audit) && (previous?.permissions ?? []).slice().sort().join('\n') === [...audit.previousPermissions].sort().join('\n');
}

export function createAdminPermissionApplication(repository: AdminPermissionRepositoryPort): AdminPermissionApplication {
  return {
    listPaths() {
      return ADMIN_PERMISSION_PATHS.every((path) => Value.Check(AdminPermissionPathDtoSchema, path))
        ? { ok: true, value: ADMIN_PERMISSION_PATHS.map((path) => ({ ...path })) }
        : { ok: false, code: 'INVALID_REQUEST' };
    },
    async listUsers(query) {
      if (!Value.Check(AdminPermissionListQuerySchema, query)) return { ok: false, code: 'INVALID_REQUEST' };
      try {
        const users = await repository.listUsers();
        if (!users.every((user) => Value.Check(AdminManagedUserDtoSchema, user))) return { ok: false, code: 'INVALID_REQUEST' };
        const typed = query as AdminPermissionListQueryDto;
        const keyword = typed.keyword?.trim().toLocaleLowerCase();
        return { ok: true, value: users.filter((user) => {
          const matchesKeyword = !keyword || user.userId.includes(keyword) || user.username.toLocaleLowerCase().includes(keyword);
          const matchesStatus = typed.status === undefined || user.status === typed.status;
          const matchesPermission = !typed.permissionCode || user.permissions.includes(typed.permissionCode);
          return matchesKeyword && matchesStatus && matchesPermission;
        }).sort((left, right) => left.username.localeCompare(right.username)) };
      } catch { return { ok: false, code: 'READ_FAILED' }; }
    },
    async listAudits(targetAdminUserId) {
      if (targetAdminUserId !== undefined && (typeof targetAdminUserId !== 'string' || !ID_PATTERN.test(targetAdminUserId))) return { ok: false, code: 'INVALID_REQUEST' };
      try {
        const audits = await repository.listAudits(targetAdminUserId as string | undefined);
        return audits.every((audit) => Value.Check(AdminPermissionAuditDtoSchema, audit))
          ? { ok: true, value: audits.sort((left, right) => right.createdAt.localeCompare(left.createdAt)) }
          : { ok: false, code: 'INVALID_REQUEST' };
      } catch { return { ok: false, code: 'READ_FAILED' }; }
    },
    async updatePermissions(request) {
      if (!Value.Check(AdminPermissionChangeRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
      const typed = request as AdminPermissionChangeRequestDto;
      const normalized = { ...typed, permissionCodes: [...new Set(typed.permissionCodes)].sort(), reason: typed.reason.trim() };
      if (!Value.Check(AdminPermissionChangeRequestSchema, normalized)) return { ok: false, code: 'INVALID_REQUEST' };
      const registry = ADMIN_PERMISSION_PATHS.filter((path) => path.status !== AdminPermissionStatus.DISABLED).map((path) => path.permissionCode);
      if (normalized.permissionCodes.some((code) => !registry.includes(code))) return { ok: false, code: 'UNKNOWN_PERMISSION' };
      try {
        const existingAudit = await repository.findAuditByRequestKey(normalized.requestKey);
        if (existingAudit) {
          const previous = await repository.findUser(normalized.targetAdminUserId);
          const same = sameCommand(normalized, existingAudit)
            && (await repository.listAudits(normalized.targetAdminUserId)).some((audit) => audit.auditId === existingAudit.auditId);
          const response: AdminPermissionChangeResponseDto = { user: previous ?? { userId: normalized.targetAdminUserId, username: '本机 Admin', roleType: AdminManagedUserRoleType.ADMIN, status: AdminManagedUserStatus.ACTIVE, permissions: existingAudit.nextPermissions, authVersion: existingAudit.nextAuthVersion, source: AdminPermissionSource.LOCAL_DEMO }, audit: existingAudit, replayed: true };
          if (!same || !Value.Check(AdminPermissionChangeResponseSchema, response)) return { ok: false, code: 'REQUEST_KEY_REUSED' };
          return { ok: true, value: response };
        }
        const current = await repository.findUser(normalized.targetAdminUserId);
        if (!current) return { ok: false, code: 'USER_NOT_FOUND' };
        if (current.status !== AdminManagedUserStatus.ACTIVE) return { ok: false, code: 'USER_LOCKED' };
        const previousPermissions = [...current.permissions].sort();
        if (previousPermissions.join('\n') === normalized.permissionCodes.join('\n')) return { ok: false, code: 'NO_CHANGE' };
        const changedAt = repository.now();
        const next: AdminManagedUserDto = { ...current, permissions: normalized.permissionCodes, authVersion: current.authVersion + 1 };
        const audit: AdminPermissionAuditDto = {
          auditId: repository.createId(), requestKey: normalized.requestKey, adminUserId: LOCAL_OPERATOR_ADMIN_USER_ID,
          targetAdminUserId: current.userId, action: AdminPermissionAction.PERMISSIONS_UPDATED,
          previousPermissions, nextPermissions: [...normalized.permissionCodes], previousAuthVersion: current.authVersion,
          nextAuthVersion: next.authVersion, reason: normalized.reason, source: AdminPermissionSource.LOCAL_DEMO, createdAt: changedAt,
        };
        if (!Value.Check(AdminManagedUserDtoSchema, next) || !Value.Check(AdminPermissionAuditDtoSchema, audit)) return { ok: false, code: 'INVALID_REQUEST' };
        try {
          await repository.commit(next, audit);
        } catch {
          const committed = await repository.findAuditByRequestKey(normalized.requestKey);
          if (!committed) return { ok: false, code: 'WRITE_FAILED' };
          if (!matchesAuditRequest(normalized, committed, current)) return { ok: false, code: 'REQUEST_KEY_REUSED' };
          const replayedUser = await repository.findUser(normalized.targetAdminUserId);
          if (!replayedUser) return { ok: false, code: 'WRITE_FAILED' };
          return { ok: true, value: { user: replayedUser, audit: committed, replayed: true } };
        }
        return { ok: true, value: { user: next, audit, replayed: false } };
      } catch { return { ok: false, code: 'WRITE_FAILED' }; }
    },
  };
}
