import {
  AdminAuditActionCode,
  AdminAuditResultType,
  AdminAuditSource,
  type AdminAuditDto,
} from '@gameing/admin-contracts/admin-audit';
import type { AgentDomainReviewAuditDto } from '@gameing/admin-contracts/agent-domain-review';
import type { AdminPermissionAuditDto } from '@gameing/admin-contracts/admin-permissions';
import type { AnnouncementTemplateChangeDto } from '@gameing/admin-contracts/announcement-template';
import type { GameCatalogChangeDto } from '@gameing/contracts/game-catalog';
import type { PaymentChannelChangeDto } from '@gameing/contracts/payment-channel';
import type { SocialModerationAuditDto } from '@gameing/contracts/social';
import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase } from '../browser-development-database';
import type { AdminAuditRepositoryPort } from './admin-audit-application';

const LOCAL_DEMO_ADMIN_USER_ID = '90001';
const LOCAL_DEMO_ADMIN_NAME = '本机演练管理员';

function eventBase(input: Omit<AdminAuditDto, 'resultType' | 'adminDisplayName'>): AdminAuditDto {
  return { ...input, adminDisplayName: input.source === AdminAuditSource.LOCAL_DEMO && input.adminUserId === LOCAL_DEMO_ADMIN_USER_ID ? LOCAL_DEMO_ADMIN_NAME : `Admin ${input.adminUserId}`, resultType: AdminAuditResultType.SUCCESS };
}

function summarizeGame(value: GameCatalogChangeDto['next']): string {
  return `${value.name} · ${value.status} · 顺序 ${value.sortOrder}`;
}

function summarizePaymentChannel(value: NonNullable<PaymentChannelChangeDto['previous']> | PaymentChannelChangeDto['next']): string {
  return `${value.providerName} · ${value.providerCode}/${value.paymentMethod} · ${value.status} · 顺序 ${value.sortOrder}`;
}

function toPermissionAuditEvent(audit: AdminPermissionAuditDto): AdminAuditDto {
  return eventBase({
    auditId: `admin-permission:${audit.auditId}`, adminUserId: audit.adminUserId, targetUserId: audit.targetAdminUserId, source: audit.source,
    requestId: audit.requestKey, actionCode: AdminAuditActionCode.PERMISSIONS_UPDATED, resourceType: 'ADMIN_USER', resourceKey: audit.targetAdminUserId,
    reason: audit.reason, beforeSummary: audit.previousPermissions.join(', ') || '无权限', afterSummary: audit.nextPermissions.join(', ') || '无权限', createdAt: audit.createdAt,
  });
}

function toAgentDomainEvent(audit: AgentDomainReviewAuditDto): AdminAuditDto {
  return eventBase({
    auditId: `agent-domain:${audit.auditId}`, adminUserId: LOCAL_DEMO_ADMIN_USER_ID, targetUserId: audit.userId, source: audit.source,
    requestId: audit.requestKey, actionCode: AdminAuditActionCode.AGENT_DOMAIN_ACTION, resourceType: 'AGENT_DOMAIN', resourceKey: audit.userId,
    reason: audit.reason, beforeSummary: `状态 ${audit.previousStatus} · 能力 ${audit.previousCapabilities.join(', ') || '无'}`,
    afterSummary: `状态 ${audit.nextStatus} · 能力 ${audit.nextCapabilities.join(', ') || '无'}`, createdAt: audit.createdAt,
  });
}

function toGameCatalogEvent(audit: GameCatalogChangeDto): AdminAuditDto {
  return eventBase({
    auditId: `game-catalog:${audit.changeId}`, adminUserId: LOCAL_DEMO_ADMIN_USER_ID, targetUserId: null, source: audit.source,
    requestId: audit.requestKey, actionCode: AdminAuditActionCode.GAME_CATALOG_SAVED, resourceType: 'GAME_CATALOG', resourceKey: audit.gameId,
    reason: audit.reason, beforeSummary: audit.previous ? summarizeGame(audit.previous) : '新建游戏目录项', afterSummary: summarizeGame(audit.next), createdAt: audit.createdAt,
  });
}

function toPaymentChannelEvent(audit: PaymentChannelChangeDto): AdminAuditDto {
  return eventBase({
    auditId: `payment-channel:${audit.changeId}`, adminUserId: LOCAL_DEMO_ADMIN_USER_ID, targetUserId: null, source: AdminAuditSource.LOCAL_DEMO,
    requestId: audit.requestKey, actionCode: AdminAuditActionCode.PAYMENT_CHANNEL_SAVED, resourceType: 'PAYMENT_CHANNEL', resourceKey: audit.channelId,
    reason: audit.reason, beforeSummary: audit.previous ? summarizePaymentChannel(audit.previous) : '新增支付方式', afterSummary: summarizePaymentChannel(audit.next), createdAt: audit.createdAt,
  });
}

function toAnnouncementTemplateEvent(audit: AnnouncementTemplateChangeDto): AdminAuditDto {
  return eventBase({
    auditId: `announcement-template:${audit.changeId}`, adminUserId: LOCAL_DEMO_ADMIN_USER_ID, targetUserId: null, source: audit.source,
    requestId: audit.requestKey, actionCode: AdminAuditActionCode.ANNOUNCEMENT_TEMPLATE_SAVED, resourceType: 'ANNOUNCEMENT_TEMPLATE', resourceKey: audit.templateId,
    reason: audit.reason, beforeSummary: audit.previous ? `${audit.previous.eventType} 模板草稿` : '新建模板草稿', afterSummary: `${audit.next.eventType} 模板草稿`, createdAt: audit.createdAt,
  });
}

function toSocialModerationEvent(audit: SocialModerationAuditDto): AdminAuditDto {
  return eventBase({
    auditId: `social-moderation:${audit.auditId}`, adminUserId: audit.reviewerAdminUserId, targetUserId: null, source: AdminAuditSource.LOCAL_DEMO,
    requestId: null, actionCode: AdminAuditActionCode.SOCIAL_MODERATION_DECIDED, resourceType: 'SOCIAL_MODERATION_CASE', resourceKey: audit.caseId,
    reason: audit.reason, beforeSummary: audit.previousStatus, afterSummary: audit.nextStatus, createdAt: audit.createdAt,
  });
}

export class IndexedDbAdminAuditAdapter implements AdminAuditRepositoryPort {
  private databasePromise: ReturnType<typeof openAdminDevelopmentDatabase> | undefined;

  constructor(private readonly databaseName = ADMIN_DEVELOPMENT_DATABASE) {}

  async listEvents(): Promise<AdminAuditDto[]> {
    const database = await this.database();
    const [permissions, domains, games, channels, templates, moderation] = await Promise.all([
      database.getAll('admin_permission_audit'), database.getAll('agent_domain_review_audit_snapshots'),
      database.getAll('game_catalog_change_snapshots'), database.getAll('payment_channel_change_snapshots'),
      database.getAll('announcement_template_change_snapshots'), database.getAll('social_moderation_audit'),
    ]);
    return [
      ...permissions.map(toPermissionAuditEvent), ...domains.map(toAgentDomainEvent), ...games.map(toGameCatalogEvent),
      ...channels.map(toPaymentChannelEvent), ...templates.map(toAnnouncementTemplateEvent), ...moderation.map(toSocialModerationEvent),
    ];
  }

  async close(): Promise<void> {
    const promise = this.databasePromise;
    this.databasePromise = undefined;
    if (promise) (await promise).close();
  }

  private database(): ReturnType<typeof openAdminDevelopmentDatabase> {
    this.databasePromise ??= openAdminDevelopmentDatabase(this.databaseName);
    return this.databasePromise;
  }
}
