import { describe, expect, it } from 'vitest';
import { createAdminEventOperationsApplication, createEmptyAdminEventWorkspace } from './event-operations-application';
import type { AdminEventWorkspaceRepository, AdminEventWorkspaceSnapshot } from './event-operations-types';

function createMemoryRepository(): AdminEventWorkspaceRepository {
  let snapshot = createEmptyAdminEventWorkspace();
  let id = 0;
  return {
    async read() { return snapshot; },
    async transact<T>(change: (current: AdminEventWorkspaceSnapshot) => { next: AdminEventWorkspaceSnapshot; result: T }): Promise<T> {
      const changed = change(snapshot); snapshot = changed.next; return changed.result;
    },
    createId() { id += 1; return `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`; },
    now() { return '2026-10-15T10:00:00.000Z'; },
  };
}

describe('Admin local event operations', () => {
  it('validates a burst threshold, creates an idempotent local instance and previews without delivery', async () => {
    const app = createAdminEventOperationsApplication(createMemoryRepository());
    const save = {
      ruleId: null, eventType: 'PLAYER_BURST' as const, gameKey: 'shisanshui', difficultyKey: 'bronze', threshold: 500,
      durationMinutes: 15, allowedActorTypes: ['USER'] as const, status: 'ACTIVE' as const,
      reason: '本机规则演练', requestKey: '00000000-0000-4000-8000-000000000101',
    };
    const saved = await app.saveRule(save);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const trigger = {
      ruleId: saved.value.ruleId, eventValue: 500, actorType: 'USER' as const, actorLabel: '陈先生', cannotContinue: true,
      reason: '验证燃尽门槛', requestKey: '00000000-0000-4000-8000-000000000102',
    };
    const created = await app.simulateTrigger(trigger);
    expect(created.ok).toBe(true);
    expect((await app.simulateTrigger(trigger)).ok).toBe(true);
    expect((await app.listEvents())).toHaveLength(1);
    if (!created.ok) return;
    const preview = await app.previewDelivery({ eventId: created.value.eventId, audience: 'DIFFICULTY_HALL', reason: '检查文案预览', requestKey: '00000000-0000-4000-8000-000000000103' });
    expect(preview.ok).toBe(true);
    expect((await app.listDeliveries())[0]?.status).toBe('PREVIEW_ONLY');
    expect((await app.listDeliveries())[0]?.previewText).toContain('不含活动概率或真实派奖');
    const blocked = await app.simulateTrigger({ ...trigger, cannotContinue: false, requestKey: '00000000-0000-4000-8000-000000000104' });
    expect(blocked).toMatchObject({ ok: false, code: 'PLAYER_CAN_CONTINUE' });
  });

  it('rejects reuse of one request key with a changed command', async () => {
    const app = createAdminEventOperationsApplication(createMemoryRepository());
    const base = {
      ruleId: null, eventType: 'PLAYER_STREAK' as const, gameKey: 'shisanshui', difficultyKey: 'bronze', threshold: 6,
      durationMinutes: 15, allowedActorTypes: ['BOT'] as const, status: 'PAUSED' as const,
      reason: '连续局数演练', requestKey: '00000000-0000-4000-8000-000000000201',
    };
    expect((await app.saveRule(base)).ok).toBe(true);
    expect(await app.saveRule({ ...base, threshold: 7 })).toMatchObject({ ok: false, code: 'REQUEST_KEY_REUSED' });
    expect(await app.listRules()).toHaveLength(1);
  });
});
