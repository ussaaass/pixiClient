import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActivePlatformAnnouncements, getPlatformAnnouncement } from './announcements-api';

const announcement = {
  announcementId: '41a8a810-2233-4acd-8a11-a1b2c3d4e5f6',
  platformEventId: '41a8a810-2233-4acd-8a11-a1b2c3d4e5f7',
  eventType: 'PLAYER_BURST',
  stateVersion: 3,
  kind: 'EFFECT',
  titleKey: 'PLAYER_BURST',
  safeParams: { gameName: '十三张', difficultyName: '策略厅' },
  scope: [{ type: 'DIFFICULTY_HALL', gameKey: 'SHISANSHUI', difficultyKey: 'STRATEGY' }],
  publicActorLabel: '陈先生',
  startsAt: '2026-10-13T00:00:00.000Z',
  expiresAt: '2026-10-13T00:15:00.000Z',
  clickAction: { route: 'PLATFORM_ANNOUNCEMENT_DETAIL', params: { announcementId: '41a8a810-2233-4acd-8a11-a1b2c3d4e5f6' } },
};
const activeResponse = {
  requestId: 'request-1', code: 'OK', message: 'OK', serverNow: '2026-10-13T00:00:00.000Z',
  data: { announcements: [announcement], cursor: 'cursor-1' },
};
const activeDetail = {
  announcement,
  kind: 'EFFECT',
  status: 'ACTIVE',
  rulesVersion: 'rules-v7',
  effectTargets: [{
    scopeLabel: '十三张 · 策略厅', summary: '活动已启用。', probabilityDeltaPoints: 10,
    payoutDeltaPercent: 10, poolRemaining: '12500', poolUnit: '金币', seat: { occupied: 2, capacity: 15 },
  }],
};

function envelope(data: unknown) {
  return { requestId: 'request-2', code: 'OK', message: 'OK', serverNow: activeResponse.serverNow, data };
}

describe('platform announcement API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts the public announcement projection and requests the active feed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(activeResponse), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getActivePlatformAnnouncements()).resolves.toEqual([announcement]);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/platform/announcements/active', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  it('rejects an activity interval with an inverted time range', async () => {
    const invalid = structuredClone(activeResponse);
    invalid.data.announcements[0]!.startsAt = '2026-10-13T00:20:00.000Z';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid), { status: 200 })));

    await expect(getActivePlatformAnnouncements()).rejects.toThrow('Announcement snapshot violates the shared contract');
  });

  it('rejects calendar-invalid UTC timestamps', async () => {
    const invalid = structuredClone(activeResponse);
    invalid.data.announcements[0]!.expiresAt = '2026-99-99T00:15:00.000Z';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid), { status: 200 })));

    await expect(getActivePlatformAnnouncements()).rejects.toThrow('Announcement snapshot violates the shared contract');
  });

  it('rejects parameters outside the registered announcement template', async () => {
    const invalid = structuredClone(activeResponse);
    (invalid.data.announcements[0]!.safeParams as Record<string, unknown>).adminNote = 'must not be projected';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid), { status: 200 })));

    await expect(getActivePlatformAnnouncements()).rejects.toThrow('Announcement snapshot violates the shared contract');
  });

  it('rejects a click action that points at a different announcement', async () => {
    const invalid = structuredClone(activeResponse);
    invalid.data.announcements[0]!.clickAction.params.announcementId = '41a8a810-2233-4acd-8a11-a1b2c3d4e5f7';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(invalid), { status: 200 })));

    await expect(getActivePlatformAnnouncements()).rejects.toThrow('Announcement snapshot violates the shared contract');
  });

  it('loads a direct-linked announcement detail by its opaque ID', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope(activeDetail)), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getPlatformAnnouncement(announcement.announcementId)).resolves.toEqual(activeDetail);
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/platform/announcements/${announcement.announcementId}`, expect.any(Object));
  });

  it('allows a draining event to remain live without an ended timestamp', async () => {
    const draining = { ...activeDetail, status: 'DRAINING' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope(draining)), { status: 200 })));

    await expect(getPlatformAnnouncement(announcement.announcementId)).resolves.toEqual(draining);
  });

  it('rejects detail snapshots with impossible seat counts or missing end time', async () => {
    const invalid = structuredClone(activeDetail);
    invalid.effectTargets[0]!.seat = { occupied: 16, capacity: 15 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope(invalid)), { status: 200 })));
    await expect(getPlatformAnnouncement(announcement.announcementId)).rejects.toThrow('Announcement detail violates the shared contract');

    const missingEndedAt = { ...activeDetail, status: 'EXPIRED' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope(missingEndedAt)), { status: 200 })));
    await expect(getPlatformAnnouncement(announcement.announcementId)).rejects.toThrow('Announcement detail violates the shared contract');

    const mismatchedAnnouncement = { ...activeDetail, announcement: { ...announcement, announcementId: '41a8a810-2233-4acd-8a11-a1b2c3d4e5f7' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope(mismatchedAnnouncement)), { status: 200 })));
    await expect(getPlatformAnnouncement(announcement.announcementId)).rejects.toThrow('Announcement detail violates the shared contract');
  });
});
