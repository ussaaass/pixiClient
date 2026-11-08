import type { AdminPermissionRepo, AdminUserRepo, Tx } from '../ports/admin-repository.js';

export const SUPPORT_ADMIN_PERMISSION_CODES = {
  claim: 'admin.support.claim',
  resolve: 'admin.support.resolve',
} as const;

export type SupportAdminAction = keyof typeof SUPPORT_ADMIN_PERMISSION_CODES;

const ADMIN_ROLE_BIT = 4;
const USER_STATUS_ACTIVE = 1;
const PERMISSION_STATUS_ACTIVE = 1;

/** Checks current persisted Admin role, active route permission, and user grant. */
export class SupportAdminCapabilityAuthorizeUseCase {
  constructor(
    private readonly permissionRepo: AdminPermissionRepo,
    private readonly userRepo: AdminUserRepo,
  ) {}

  async run(input: { adminUserId: string; action: SupportAdminAction; tx: Tx }): Promise<boolean> {
    const route = supportAdminRouteOf(input.action);
    const permission = await this.permissionRepo.findPermissionByRoute(route.method, route.path, input.tx);
    if (
      permission === null ||
      permission.status !== PERMISSION_STATUS_ACTIVE ||
      permission.deletedAt != null ||
      permission.permissionCode !== SUPPORT_ADMIN_PERMISSION_CODES[input.action]
    ) {
      return false;
    }

    const user = await this.userRepo.findUserByPk(input.adminUserId, input.tx);
    if (user === null || user.status !== USER_STATUS_ACTIVE || user.deletedAt != null || (user.roleType & ADMIN_ROLE_BIT) === 0) {
      return false;
    }
    return Array.isArray(user.permissions) && user.permissions.includes(permission.permissionCode);
  }
}

export function supportAdminRouteOf(action: SupportAdminAction): { method: 'POST'; path: string } {
  switch (action) {
    case 'claim':
      return { method: 'POST', path: '/api/v1/admin/support/conversations/:id/claim' };
    case 'resolve':
      return { method: 'POST', path: '/api/v1/support/conversations/:id/resolve' };
  }
}
