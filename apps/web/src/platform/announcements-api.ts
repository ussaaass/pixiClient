import {
  ActivePlatformAnnouncementsResponseSchema,
  PlatformAnnouncementDetailResponseSchema,
  PlatformAnnouncementSchema,
} from '@gameing/contracts/platform-events/announcement';
import type { PlatformAnnouncement, PlatformAnnouncementDetail } from '@gameing/contracts/platform-events/announcement';
import { PlatformAnnouncementKind, PlatformAnnouncementStatus } from '@gameing/contracts/platform-events/announcement';
import { Value } from '@sinclair/typebox/value';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

function isPlatformAnnouncement(value: unknown): value is PlatformAnnouncement {
  if (!Value.Check(PlatformAnnouncementSchema, value)) return false;
  const announcement = value as PlatformAnnouncement;
  const startsAt = Date.parse(announcement.startsAt);
  const expiresAt = Date.parse(announcement.expiresAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(expiresAt) || expiresAt <= startsAt) return false;
  if (announcement.clickAction && announcement.clickAction.params.announcementId !== announcement.announcementId) return false;
  const allowedParams: Record<string, readonly string[]> = {
    PLAYER_BURST: ['gameName', 'difficultyName'],
    PLAYER_STREAK: ['gameName', 'difficultyName', 'roundCount'],
  };
  const registeredParams = allowedParams[announcement.titleKey];
  return registeredParams
    ? Object.keys(announcement.safeParams).every((key) => registeredParams.includes(key))
    : Object.keys(announcement.safeParams).length === 0;
}

function isPlatformAnnouncementDetail(value: unknown, expectedAnnouncementId: string): value is PlatformAnnouncementDetail {
  if (!Value.Check(PlatformAnnouncementDetailResponseSchema.properties.data, value)) return false;
  const detail = value as PlatformAnnouncementDetail;
  if (detail.announcement.announcementId !== expectedAnnouncementId) return false;
  const isLive = detail.status === PlatformAnnouncementStatus.ACTIVE || detail.status === PlatformAnnouncementStatus.DRAINING;
  if (isLive && detail.endedAt !== undefined) return false;
  if (!isLive && detail.endedAt === undefined) return false;
  if (detail.kind === PlatformAnnouncementKind.BROADCAST_ONLY) return detail.announcement.kind === detail.kind;
  if (detail.announcement.kind !== detail.kind) return false;
  return detail.effectTargets.every((target) => {
    const poolFieldsMatch = (target.poolRemaining === undefined) === (target.poolUnit === undefined);
    return poolFieldsMatch && (!target.seat || target.seat.occupied <= target.seat.capacity);
  });
}

export async function getActivePlatformAnnouncements(): Promise<PlatformAnnouncement[]> {
  const response = await fetch(`${apiBaseUrl}/platform/announcements/active`, {
    signal: AbortSignal.timeout(5000),
  });
  const body: unknown = await response.json();

  if (!response.ok || !Value.Check(ActivePlatformAnnouncementsResponseSchema, body)) {
    throw new Error('Active announcement response is unavailable or invalid');
  }
  const responseBody = body as import('@gameing/contracts/platform-events/announcement').ActivePlatformAnnouncementsResponse;
  if (!responseBody.data.announcements.every(isPlatformAnnouncement)) {
    throw new Error('Announcement snapshot violates the shared contract');
  }

  return responseBody.data.announcements;
}

export async function getPlatformAnnouncement(announcementId: string): Promise<PlatformAnnouncementDetail> {
  const response = await fetch(`${apiBaseUrl}/platform/announcements/${encodeURIComponent(announcementId)}`, {
    signal: AbortSignal.timeout(5000),
  });
  const body: unknown = await response.json();

  if (!response.ok || !Value.Check(PlatformAnnouncementDetailResponseSchema, body)) {
    throw new Error('Announcement detail is unavailable or invalid');
  }

  const responseBody = body as import('@gameing/contracts/platform-events/announcement').PlatformAnnouncementDetailResponse;
  if (!isPlatformAnnouncementDetail(responseBody.data, announcementId)) throw new Error('Announcement detail violates the shared contract');
  return responseBody.data;
}
