import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { AnnouncementTemplateEventType, AnnouncementTemplateStatus } from '@gameing/admin-contracts/announcement-template';
import { createAnnouncementTemplateApplication } from './announcement-template-application';
import { IndexedDbAnnouncementTemplateAdapter } from './indexeddb-announcement-template-adapter';
import { renderAnnouncementTemplate } from './announcement-template-domain';

let app: ReturnType<typeof createAnnouncementTemplateApplication>;
beforeEach(() => { app = createAnnouncementTemplateApplication(new IndexedDbAnnouncementTemplateAdapter(`announcement-template-test-${crypto.randomUUID()}`)); });

const burstRequest = (overrides: Record<string, unknown> = {}) => ({
  templateId: null,
  eventType: AnnouncementTemplateEventType.PLAYER_BURST,
  titlePattern: '{{actorLabel}}在{{gameName}}燃尽了',
  messagePattern: '{{difficultyName}}活动已开启。',
  reason: '调整脱敏公告用语。',
  requestKey: '11111111-1111-4111-8111-111111111111',
  ...overrides,
});

describe('announcement template draft workflow', () => {
  it('validates registered placeholders, writes a local draft and appends immutable change snapshots', async () => {
    const created = await app.save(burstRequest());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.status).toBe(AnnouncementTemplateStatus.DRAFT);
    const listed = await app.list({ eventType: AnnouncementTemplateEventType.PLAYER_BURST });
    expect(listed.ok && listed.value).toHaveLength(1);
    const update = await app.save(burstRequest({ templateId: created.value.templateId, titlePattern: '{{actorLabel}}在{{gameName}}达成活动', requestKey: '22222222-2222-4222-8222-222222222222' }));
    expect(update.ok && update.value.titlePattern).toBe('{{actorLabel}}在{{gameName}}达成活动');
    const history = await app.listChanges(created.value.templateId);
    expect(history.ok && history.value).toHaveLength(2);
    expect(history.ok && history.value[0]?.previous?.titlePattern).toBe(created.value.titlePattern);
    expect(history.ok && history.value[1]?.previous).toBeNull();
  });

  it('rejects unknown variables, HTML, links, invalid event variables and request key reuse', async () => {
    expect(await app.save(burstRequest({ titlePattern: '{{phoneNumber}}达成活动' }))).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await app.save(burstRequest({ messagePattern: '<img src=x>' }))).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await app.save(burstRequest({ messagePattern: '点击 https://example.com' }))).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    expect(await app.save(burstRequest({ messagePattern: '{{roundCount}}把' }))).toEqual({ ok: false, code: 'INVALID_REQUEST' });
    const created = await app.save(burstRequest());
    expect(created.ok).toBe(true);
    expect(await app.save(burstRequest())).toEqual(created);
    expect(await app.save(burstRequest({ titlePattern: '不同正文' }))).toEqual({ ok: false, code: 'REQUEST_KEY_REUSED' });
  });

  it('collapses concurrent retries with the same idempotency key into one immutable change', async () => {
    const request = burstRequest();
    const [first, replay] = await Promise.all([app.save(request), app.save(request)]);
    expect(first.ok && replay.ok && first.value.templateId).toBe(replay.ok ? replay.value.templateId : null);
    const list = await app.list({});
    expect(list.ok && list.value).toHaveLength(1);
    const changes = first.ok ? await app.listChanges(first.value.templateId) : { ok: false as const, code: 'NOT_FOUND' as const };
    expect(changes.ok && changes.value).toHaveLength(1);
  });

  it('renders plain text placeholder values from a fixed preview sample', () => {
    expect(renderAnnouncementTemplate({ titlePattern: '{{actorLabel}}在{{gameName}}', messagePattern: '{{difficultyName}} {{roundCount}}把' }, {
      actorLabel: '陈先生', gameName: '跳高高', difficultyName: '进阶厅', roundCount: '8',
    })).toEqual({ title: '陈先生在跳高高', message: '进阶厅 8把' });
  });
});
