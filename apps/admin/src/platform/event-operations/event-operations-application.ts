import { Value } from '@sinclair/typebox/value';
import {
  AdminEventAuditDtoSchema, AdminEventDeliveryDtoSchema, AdminEventRuleDtoSchema,
  AdminEventRuleSaveRequestSchema, AdminEventTriggerRequestSchema, AdminPlatformEventDtoSchema,
  EventDeliveryPreviewStatus, EventOperationsSource, EventRuleStatus, PlatformEventLocalStatus,
  type AdminEventAuditDto, type AdminEventDeliveryDto, type AdminEventRuleDto,
  type AdminEventRuleSaveRequestDto, type AdminEventTriggerRequestDto, type AdminPlatformEventDto,
} from '@gameing/contracts/event-operations';
import type { AdminEventWorkspaceRepository, AdminEventWorkspaceSnapshot } from './event-operations-types';

const actionCopy = { PLAYER_BURST: '玩家燃尽', PLAYER_STREAK: '连续局数播报' } as const;
const emptySnapshot = (): AdminEventWorkspaceSnapshot => ({ key: 'workspace', revision: 1, rules: [], events: [], deliveries: [], audits: [] });
const failure = (code: string) => ({ ok: false as const, code });
type ValueResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };
type CommandResult = { readonly ok: true } | { readonly ok: false; readonly code: string };

function audit(repository: AdminEventWorkspaceRepository, input: {
  requestKey: string; action: AdminEventAuditDto['action']; resourceId: string; reason: string; commandSignature: string;
}): AdminEventAuditDto {
  return {
    auditId: repository.createId(), requestKey: input.requestKey, action: input.action,
    resourceId: input.resourceId, reason: input.reason, commandSignature: input.commandSignature, createdAt: repository.now(), source: EventOperationsSource.LOCAL_DEMO,
  };
}

export function createAdminEventOperationsApplication(repository: AdminEventWorkspaceRepository) {
  return {
    async listRules(): Promise<AdminEventRuleDto[]> {
      const snapshot = await repository.read();
      return [...snapshot.rules].filter((row) => Value.Check(AdminEventRuleDtoSchema, row)).sort((a, b) => a.gameKey.localeCompare(b.gameKey) || a.difficultyKey.localeCompare(b.difficultyKey));
    },
    async listEvents(): Promise<AdminPlatformEventDto[]> {
      const snapshot = await repository.read();
      const now = Date.parse(repository.now());
      return [...snapshot.events].filter((row) => Value.Check(AdminPlatformEventDtoSchema, row))
        .map((row) => row.status === PlatformEventLocalStatus.ACTIVE && Date.parse(row.expiresAt) <= now ? { ...row, status: PlatformEventLocalStatus.EXPIRED } : row)
        .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
    },
    async listDeliveries(): Promise<AdminEventDeliveryDto[]> {
      const snapshot = await repository.read();
      return [...snapshot.deliveries].filter((row) => Value.Check(AdminEventDeliveryDtoSchema, row)).sort((a, b) => b.previewedAt.localeCompare(a.previewedAt));
    },
    async listAudits(resourceId?: string): Promise<AdminEventAuditDto[]> {
      const snapshot = await repository.read();
      return [...snapshot.audits].filter((row) => Value.Check(AdminEventAuditDtoSchema, row) && (!resourceId || row.resourceId === resourceId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async saveRule(request: unknown) {
      if (!Value.Check(AdminEventRuleSaveRequestSchema, request)) return failure('INVALID_REQUEST');
      const input = request as AdminEventRuleSaveRequestDto;
      const reason = input.reason.trim();
      if (reason.length < 3) return failure('INVALID_REQUEST');
      try {
        return await repository.transact<ValueResult<AdminEventRuleDto>>((current) => {
          const replay = current.audits.find((item) => item.requestKey === input.requestKey);
          if (replay) {
            const rule = current.rules.find((item) => item.ruleId === replay.resourceId);
            const signature = JSON.stringify({ ruleId: input.ruleId, eventType: input.eventType, gameKey: input.gameKey, difficultyKey: input.difficultyKey, threshold: input.threshold, durationMinutes: input.durationMinutes, allowedActorTypes: input.allowedActorTypes, status: input.status, reason });
            return rule && replay.action === 'RULE_SAVED' && replay.commandSignature === signature
              ? { next: current, result: { ok: true as const, value: rule } }
              : { next: current, result: failure('REQUEST_KEY_REUSED') };
          }
          const previous = input.ruleId ? current.rules.find((item) => item.ruleId === input.ruleId) : undefined;
          if (input.ruleId && !previous) return { next: current, result: failure('NOT_FOUND') };
          const rule: AdminEventRuleDto = {
            ruleId: previous?.ruleId ?? repository.createId(), eventType: input.eventType,
            gameKey: input.gameKey, difficultyKey: input.difficultyKey, threshold: input.threshold,
            durationMinutes: input.durationMinutes, allowedActorTypes: [...new Set(input.allowedActorTypes)].sort(), status: input.status,
            effect: 'BROADCAST_ONLY', updatedAt: repository.now(), source: EventOperationsSource.LOCAL_DEMO,
          };
          const commandSignature = JSON.stringify({ ruleId: input.ruleId, eventType: input.eventType, gameKey: input.gameKey, difficultyKey: input.difficultyKey, threshold: input.threshold, durationMinutes: input.durationMinutes, allowedActorTypes: [...new Set(input.allowedActorTypes)].sort(), status: input.status, reason });
          const record = audit(repository, { requestKey: input.requestKey, action: 'RULE_SAVED', resourceId: rule.ruleId, reason, commandSignature });
          if (!Value.Check(AdminEventRuleDtoSchema, rule) || !Value.Check(AdminEventAuditDtoSchema, record)) return { next: current, result: failure('INVALID_REQUEST') };
          const next: AdminEventWorkspaceSnapshot = {
            ...current, revision: current.revision + 1,
            rules: previous ? current.rules.map((item) => item.ruleId === rule.ruleId ? rule : item) : [...current.rules, rule],
            audits: [...current.audits, record],
          };
          return { next, result: { ok: true as const, value: rule } };
        });
      } catch { return failure('WRITE_FAILED'); }
    },
    async simulateTrigger(request: unknown) {
      if (!Value.Check(AdminEventTriggerRequestSchema, request)) return failure('INVALID_REQUEST');
      const input = request as AdminEventTriggerRequestDto;
      const reason = input.reason.trim();
      const actorLabel = input.actorLabel.trim();
      const safeActorLabel = input.actorType === 'USER' ? /^[\u4e00-\u9fa5]{1,2}(先生|女士|玩家)$/.test(actorLabel)
        : input.actorType === 'BOT' ? /^机器人[1-9][0-9]{0,2}$/.test(actorLabel)
          : actorLabel === '系统事件';
      if (reason.length < 3 || !safeActorLabel) return failure('INVALID_REQUEST');
      try {
        return await repository.transact<ValueResult<AdminPlatformEventDto>>((current) => {
          const prior = current.audits.find((item) => item.requestKey === input.requestKey);
          if (prior) {
            const event = current.events.find((item) => item.eventId === prior.resourceId);
            const signature = JSON.stringify({ ruleId: input.ruleId, eventValue: input.eventValue, actorType: input.actorType, actorLabel, cannotContinue: input.cannotContinue, reason });
            return event && prior.action === 'EVENT_SIMULATED' && prior.commandSignature === signature ? { next: current, result: { ok: true as const, value: event } } : { next: current, result: failure('REQUEST_KEY_REUSED') };
          }
          const rule = current.rules.find((item) => item.ruleId === input.ruleId);
          if (!rule) return { next: current, result: failure('NOT_FOUND') };
          if (rule.status !== EventRuleStatus.ACTIVE) return { next: current, result: failure('RULE_DISABLED') };
          if (!rule.allowedActorTypes.includes(input.actorType)) return { next: current, result: failure('ACTOR_NOT_ALLOWED') };
          if (input.eventValue < rule.threshold) return { next: current, result: failure('TRIGGER_NOT_MET') };
          if (rule.eventType === 'PLAYER_BURST' && !input.cannotContinue) return { next: current, result: failure('PLAYER_CAN_CONTINUE') };
          if (rule.eventType === 'PLAYER_STREAK' && input.cannotContinue) return { next: current, result: failure('STREAK_EVENT_INVALID') };
          const startsAt = repository.now();
          const event: AdminPlatformEventDto = {
            eventId: repository.createId(), ruleId: rule.ruleId, eventType: rule.eventType,
            gameKey: rule.gameKey, difficultyKey: rule.difficultyKey, metricValue: input.eventValue,
            actorType: input.actorType, publicActorLabel: actorLabel, effect: 'BROADCAST_ONLY', status: PlatformEventLocalStatus.ACTIVE,
            startsAt, expiresAt: new Date(Date.parse(startsAt) + rule.durationMinutes * 60_000).toISOString(),
            stateVersion: 1, source: EventOperationsSource.LOCAL_DEMO,
          };
          const commandSignature = JSON.stringify({ ruleId: input.ruleId, eventValue: input.eventValue, actorType: input.actorType, actorLabel, cannotContinue: input.cannotContinue, reason });
          const record = audit(repository, { requestKey: input.requestKey, action: 'EVENT_SIMULATED', resourceId: event.eventId, reason, commandSignature });
          if (!Value.Check(AdminPlatformEventDtoSchema, event) || !Value.Check(AdminEventAuditDtoSchema, record)) return { next: current, result: failure('INVALID_REQUEST') };
          const next = { ...current, revision: current.revision + 1, events: [...current.events, event], audits: [...current.audits, record] };
          return { next, result: { ok: true as const, value: event } };
        });
      } catch { return failure('WRITE_FAILED'); }
    },
    async cancelEvent(input: { eventId: string; reason: string; requestKey: string }) {
      if (input.reason.trim().length < 3) return failure('INVALID_REQUEST');
      try {
        return await repository.transact<CommandResult>((current) => {
          const replay = current.audits.find((item) => item.requestKey === input.requestKey);
          const signature = JSON.stringify({ eventId: input.eventId, reason: input.reason.trim() });
          if (replay) return replay.resourceId === input.eventId && replay.commandSignature === signature ? { next: current, result: { ok: true as const } } : { next: current, result: failure('REQUEST_KEY_REUSED') };
          const event = current.events.find((item) => item.eventId === input.eventId);
          if (!event) return { next: current, result: failure('NOT_FOUND') };
          if (event.status !== PlatformEventLocalStatus.ACTIVE || Date.parse(event.expiresAt) <= Date.parse(repository.now())) return { next: current, result: failure('EVENT_NOT_ACTIVE') };
          const record = audit(repository, { requestKey: input.requestKey, action: 'EVENT_CANCELLED', resourceId: event.eventId, reason: input.reason.trim(), commandSignature: signature });
          const next = { ...current, revision: current.revision + 1, events: current.events.map((item) => item.eventId === event.eventId ? { ...item, status: PlatformEventLocalStatus.CANCELLED, stateVersion: item.stateVersion + 1 } : item), audits: [...current.audits, record] };
          return { next, result: { ok: true as const } };
        });
      } catch { return failure('WRITE_FAILED'); }
    },
    async previewDelivery(input: { eventId: string; audience: AdminEventDeliveryDto['audience']; reason: string; requestKey: string }) {
      if (input.reason.trim().length < 3) return failure('INVALID_REQUEST');
      try {
        return await repository.transact<ValueResult<AdminEventDeliveryDto>>((current) => {
          const replay = current.audits.find((item) => item.requestKey === input.requestKey);
          if (replay) {
            const delivery = current.deliveries.find((item) => item.deliveryId === replay.resourceId);
            const signature = JSON.stringify({ ...input, reason: input.reason.trim() });
            return delivery && replay.action === 'DELIVERY_PREVIEWED' && replay.commandSignature === signature ? { next: current, result: { ok: true as const, value: delivery } } : { next: current, result: failure('REQUEST_KEY_REUSED') };
          }
          const event = current.events.find((item) => item.eventId === input.eventId);
          if (!event) return { next: current, result: failure('NOT_FOUND') };
          if (event.status !== PlatformEventLocalStatus.ACTIVE || Date.parse(event.expiresAt) <= Date.parse(repository.now())) return { next: current, result: failure('EVENT_NOT_ACTIVE') };
          const fact = event.eventType === 'PLAYER_BURST' ? `累计损失达到${event.metricValue}且无法继续` : `符合该游戏定义的连续局数达到${event.metricValue}把`;
          const text = `${actionCopy[event.eventType]}：${event.publicActorLabel}在${event.gameKey}·${event.difficultyKey}${fact}；这是本机预览，不含活动概率或真实派奖。`;
          const delivery: AdminEventDeliveryDto = {
            deliveryId: repository.createId(), eventId: event.eventId, audience: input.audience,
            status: EventDeliveryPreviewStatus.PREVIEW_ONLY, previewText: text,
            previewedAt: repository.now(), source: EventOperationsSource.LOCAL_DEMO,
          };
          const commandSignature = JSON.stringify({ ...input, reason: input.reason.trim() });
          const record = audit(repository, { requestKey: input.requestKey, action: 'DELIVERY_PREVIEWED', resourceId: delivery.deliveryId, reason: input.reason.trim(), commandSignature });
          if (!Value.Check(AdminEventDeliveryDtoSchema, delivery) || !Value.Check(AdminEventAuditDtoSchema, record)) return { next: current, result: failure('INVALID_REQUEST') };
          const next = { ...current, revision: current.revision + 1, deliveries: [...current.deliveries, delivery], audits: [...current.audits, record] };
          return { next, result: { ok: true as const, value: delivery } };
        });
      } catch { return failure('WRITE_FAILED'); }
    },
  };
}

export { emptySnapshot as createEmptyAdminEventWorkspace };
