import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AgentDomainDto } from '@gameing/contracts/invite-agent';
import type { AgentDomainReviewAuditDto } from '@gameing/admin-contracts/agent-domain-review';
import type { SystemConfigDraftDto } from '@gameing/admin-contracts/system-config';
import type { GameCatalogChangeDto, GameCatalogDto } from '@gameing/contracts/game-catalog';
import type { PaymentChannelChangeDto, PaymentChannelDto } from '@gameing/contracts/payment-channel';
import type { AgentAuditEventDto } from '@gameing/contracts/agent-audit';
import type { AgentGameConfigWorkspaceDto } from '@gameing/contracts/agent-game-config';
import type { AgentAnnouncementDto } from '@gameing/contracts/agent-announcements';
import type { SupportDeskConversationDto, SupportMessageDto } from '@gameing/contracts/support';
import type { SocialModerationAuditDto, SocialModerationCaseDto } from '@gameing/contracts/social';
import type { AnnouncementTemplateChangeDto, AnnouncementTemplateDto } from '@gameing/admin-contracts/announcement-template';
import type { AdminManagedUserDto, AdminPermissionAuditDto } from '@gameing/admin-contracts/admin-permissions';
import type { AdminReferralWorkspaceSnapshot } from './referrals/admin-referral-types';
import type { AdminEventWorkspaceSnapshot } from './event-operations/event-operations-types';

export interface AdminDevelopmentSchema extends DBSchema {
  system_config_drafts: {
    key: string;
    value: SystemConfigDraftDto;
    indexes: { 'by-request-key': string };
  };
  agent_domains: {
    key: string;
    value: AgentDomainDto;
    indexes: { 'by-status': AgentDomainDto['status'] };
  };
  agent_domain_review_audit_snapshots: {
    key: string;
    value: AgentDomainReviewAuditDto;
    indexes: { 'by-user-created': [string, string]; 'by-request-key': string };
  };
  game_catalog_items: {
    key: string;
    value: GameCatalogDto;
    indexes: { 'by-status-order': [GameCatalogDto['status'], number]; 'by-code': string; 'by-game-key': string };
  };
  game_catalog_change_snapshots: {
    key: string;
    value: GameCatalogChangeDto;
    indexes: { 'by-game-created': [string, string]; 'by-request-key': string };
  };
  payment_channel_items: {
    key: string;
    value: PaymentChannelDto;
    indexes: { 'by-status-order': [PaymentChannelDto['status'], number]; 'by-provider-method': [string, PaymentChannelDto['paymentMethod']] };
  };
  payment_channel_change_snapshots: {
    key: string;
    value: PaymentChannelChangeDto;
    indexes: { 'by-channel-created': [string, string]; 'by-request-key': string };
  };
  agent_audit_events: {
    key: string;
    value: AgentAuditEventDto;
    indexes: { 'by-request-key': string; 'by-resource-created': [string, string] };
  };
  support_desk_conversations: {
    key: string;
    value: SupportDeskConversationDto;
    indexes: { 'by-status-updated': [number, string] };
  };
  support_desk_messages: {
    key: string;
    value: SupportMessageDto;
    indexes: { 'by-conversation-created': [string, string]; 'by-message-key': string };
  };
  support_desk_command_receipts: {
    key: string;
    value: { requestKey: string; conversationId: string; actorUserId: string; action: 'CLAIM' | 'RESOLVE' | 'REOPEN'; createdAt: string };
    indexes: { 'by-conversation-created': [string, string] };
  };
  social_moderation_cases: {
    key: string;
    value: SocialModerationCaseDto;
    indexes: { 'by-status-created': [number, string] };
  };
  social_moderation_audit: {
    key: string;
    value: SocialModerationAuditDto & { requestKey: string };
    indexes: { 'by-case-created': [string, string]; 'by-request-key': string };
  };
  announcement_template_drafts: { key: string; value: AnnouncementTemplateDto; indexes: { 'by-event-updated': [string, string] } };
  announcement_template_change_snapshots: { key: string; value: AnnouncementTemplateChangeDto; indexes: { 'by-template-created': [string, string]; 'by-request-key': string } };
  admin_permission_users: { key: string; value: AdminManagedUserDto; indexes: { 'by-status-username': [number, string] } };
  admin_permission_audit: { key: string; value: AdminPermissionAuditDto; indexes: { 'by-target-created': [string, string]; 'by-request-key': string } };
  admin_referral_workspace_snapshots: { key: string; value: AdminReferralWorkspaceSnapshot };
  admin_event_workspace_snapshots: { key: string; value: AdminEventWorkspaceSnapshot };
  agent_game_config_workspaces: { key: string; value: AgentGameConfigWorkspaceDto & { scopeKey: string } };
  agent_announcements: { key: string; value: AgentAnnouncementDto; indexes: { 'by-domain-created': [string, string]; 'by-domain-status': [string, number] } };
}

export const ADMIN_DEVELOPMENT_DATABASE = 'gameing_hall_admin_dev';
export const ADMIN_DEVELOPMENT_DATABASE_VERSION = 14;

export function openAdminDevelopmentDatabase(databaseName = ADMIN_DEVELOPMENT_DATABASE): Promise<IDBPDatabase<AdminDevelopmentSchema>> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('ADMIN_STORAGE_UNAVAILABLE'));
  return openDB<AdminDevelopmentSchema>(databaseName, ADMIN_DEVELOPMENT_DATABASE_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        const drafts = database.createObjectStore('system_config_drafts', { keyPath: 'configKey' });
        drafts.createIndex('by-request-key', 'requestKey', { unique: true });
      }
      if (oldVersion < 2) {
        const domains = database.createObjectStore('agent_domains', { keyPath: 'userId' });
        domains.createIndex('by-status', 'status');
        const audits = database.createObjectStore('agent_domain_review_audit_snapshots', { keyPath: 'auditId' });
        audits.createIndex('by-user-created', ['userId', 'createdAt']);
        audits.createIndex('by-request-key', 'requestKey', { unique: true });
      }
      if (oldVersion < 3) {
        const games = database.createObjectStore('game_catalog_items', { keyPath: 'gameId' });
        games.createIndex('by-status-order', ['status', 'sortOrder']);
        games.createIndex('by-code', 'gameCode', { unique: true });
        games.createIndex('by-game-key', 'gameKey', { unique: true });
        const changes = database.createObjectStore('game_catalog_change_snapshots', { keyPath: 'changeId' });
        changes.createIndex('by-game-created', ['gameId', 'createdAt']);
        changes.createIndex('by-request-key', 'requestKey', { unique: true });
      }
      if (oldVersion < 4) {
        const channels = database.createObjectStore('payment_channel_items', { keyPath: 'channelId' });
        channels.createIndex('by-status-order', ['status', 'sortOrder']);
        channels.createIndex('by-provider-method', ['providerCode', 'paymentMethod'], { unique: true });
        const changes = database.createObjectStore('payment_channel_change_snapshots', { keyPath: 'changeId' });
        changes.createIndex('by-channel-created', ['channelId', 'createdAt']);
        changes.createIndex('by-request-key', 'requestKey', { unique: true });
      }
      if (oldVersion < 5) {
        const audits = database.createObjectStore('agent_audit_events', { keyPath: 'auditId' });
        audits.createIndex('by-request-key', 'requestKey', { unique: true });
        audits.createIndex('by-resource-created', ['resourceKey', 'createdAt']);
      }
      if (oldVersion < 6) {
        const conversations = database.createObjectStore('support_desk_conversations', { keyPath: 'conversation.conversationId' });
        conversations.createIndex('by-status-updated', ['conversation.status', 'conversation.updatedAt']);
        const messages = database.createObjectStore('support_desk_messages', { keyPath: 'messageId' });
        messages.createIndex('by-conversation-created', ['conversationId', 'createdAt']);
        messages.createIndex('by-message-key', 'messageKey', { unique: true });
      }
      if (oldVersion < 7) {
        const receipts = database.createObjectStore('support_desk_command_receipts', { keyPath: 'requestKey' });
        receipts.createIndex('by-conversation-created', ['conversationId', 'createdAt']);
      }
      if (oldVersion < 8) {
        const cases = database.createObjectStore('social_moderation_cases', { keyPath: 'caseId' });
        cases.createIndex('by-status-created', ['caseStatus', 'createdAt']);
        const audits = database.createObjectStore('social_moderation_audit', { keyPath: 'auditId' });
        audits.createIndex('by-case-created', ['caseId', 'createdAt']);
        audits.createIndex('by-request-key', 'requestKey', { unique: true });
      }
      if (oldVersion < 9) {
        const templates = database.createObjectStore('announcement_template_drafts', { keyPath: 'templateId' });
        templates.createIndex('by-event-updated', ['eventType', 'updatedAt']);
        const changes = database.createObjectStore('announcement_template_change_snapshots', { keyPath: 'changeId' });
        changes.createIndex('by-template-created', ['templateId', 'createdAt']);
        changes.createIndex('by-request-key', 'requestKey', { unique: true });
      }
      if (oldVersion < 10) {
        const users = database.createObjectStore('admin_permission_users', { keyPath: 'userId' });
        users.createIndex('by-status-username', ['status', 'username']);
        const audits = database.createObjectStore('admin_permission_audit', { keyPath: 'auditId' });
        audits.createIndex('by-target-created', ['targetAdminUserId', 'createdAt']);
        audits.createIndex('by-request-key', 'requestKey', { unique: true });
      }
      if (oldVersion < 11) database.createObjectStore('admin_referral_workspace_snapshots', { keyPath: 'key' });
      if (oldVersion < 12) database.createObjectStore('admin_event_workspace_snapshots', { keyPath: 'key' });
      if (oldVersion < 13) database.createObjectStore('agent_game_config_workspaces', { keyPath: 'scopeKey' });
      if (oldVersion < 14) {
        const announcements = database.createObjectStore('agent_announcements', { keyPath: 'announcementId' });
        announcements.createIndex('by-domain-created', ['agentDomainId', 'createdAt']);
        announcements.createIndex('by-domain-status', ['agentDomainId', 'status']);
      }
    },
    blocked() {
      console.warn('Admin development database upgrade is blocked by another open tab.');
    },
  });
}
