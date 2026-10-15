import { AdminPermissionStatus, type AdminPermissionPathDto } from '@gameing/admin-contracts/admin-permissions';

export const ADMIN_PERMISSION_PATHS: readonly AdminPermissionPathDto[] = [
  { permissionCode: 'admin.users.read', name: '查询用户', httpMethod: 'GET', pathPattern: '/api/v1/admin/users', status: AdminPermissionStatus.ACTIVE },
  { permissionCode: 'admin.permissions.manage', name: '管理 Admin 权限', httpMethod: 'PATCH', pathPattern: '/api/v1/admin/users/:user_id/permissions', status: AdminPermissionStatus.ACTIVE },
  { permissionCode: 'admin.audit.read', name: '读取操作审计', httpMethod: 'GET', pathPattern: '/api/v1/admin/audit-events', status: AdminPermissionStatus.ACTIVE },
  { permissionCode: 'admin.system-config.read', name: '读取系统配置', httpMethod: 'GET', pathPattern: '/api/v1/admin/system-config', status: AdminPermissionStatus.ACTIVE },
  { permissionCode: 'admin.system-config.write', name: '提交系统配置', httpMethod: 'PUT', pathPattern: '/api/v1/admin/system-config/:config_key', status: AdminPermissionStatus.ACTIVE },
  { permissionCode: 'admin.game-config.read', name: '读取游戏配置', httpMethod: 'GET', pathPattern: '/api/v1/admin/games/:game_key/difficulties/:difficulty_key/config', status: AdminPermissionStatus.ACTIVE },
  { permissionCode: 'admin.game-config.publish', name: '发布游戏配置', httpMethod: 'POST', pathPattern: '/api/v1/admin/games/:game_key/difficulties/:difficulty_key/config/publish', status: AdminPermissionStatus.ACTIVE },
  { permissionCode: 'admin.social.moderate', name: '处置社区内容', httpMethod: 'POST', pathPattern: '/api/v1/admin/social/moderation/:case_id/decision', status: AdminPermissionStatus.ACTIVE },
  { permissionCode: 'admin.support.read', name: '读取客服队列', httpMethod: 'GET', pathPattern: '/api/v1/admin/support/conversations', status: AdminPermissionStatus.ACTIVE },
  { permissionCode: 'admin.support.reply', name: '回复客服会话', httpMethod: 'POST', pathPattern: '/api/v1/admin/support/conversations/:conversation_id/messages', status: AdminPermissionStatus.ACTIVE },
];
