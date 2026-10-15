import { AgentAnnouncementStatus, type AgentAnnouncementDto } from '@gameing/contracts/agent-announcements';

const unsupportedClaims = /概率|中奖率|返奖率|赔率|\brtp\b|提高|提升|翻倍|派奖/i;
const externalMarkup = /<[^>]*>|(?:https?:\/\/|www\.)\S+/i;

export function isSafeAgentAnnouncementText(title: string, body: string): boolean {
  const normalized = `${title.trim()}\n${body.trim()}`;
  return !externalMarkup.test(normalized) && !unsupportedClaims.test(normalized) && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(normalized);
}

export function announcementStatusAt(announcement: AgentAnnouncementDto, now: Date): AgentAnnouncementDto['status'] {
  if (announcement.status === AgentAnnouncementStatus.RETRACTED || announcement.status === AgentAnnouncementStatus.DRAFT) return announcement.status;
  if (announcement.expiresAt && Date.parse(announcement.expiresAt) <= now.getTime()) return AgentAnnouncementStatus.EXPIRED;
  if (announcement.startsAt && Date.parse(announcement.startsAt) > now.getTime()) return AgentAnnouncementStatus.SCHEDULED;
  return AgentAnnouncementStatus.ACTIVE;
}

export function validateAnnouncementSchedule(startsAt: string, expiresAt: string, now: Date): boolean {
  const start = Date.parse(startsAt);
  const end = Date.parse(expiresAt);
  const week = 7 * 24 * 60 * 60 * 1000;
  return Number.isFinite(start) && Number.isFinite(end) && start >= now.getTime() - 60_000 && end > start && end - start <= week && start - now.getTime() <= week;
}
