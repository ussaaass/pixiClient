import type { AnnouncementScope, PlatformAnnouncement } from '@gameing/contracts/platform-events/announcement';

type AnnouncementCopy = { title: string; message: string };

function textParam(announcement: PlatformAnnouncement, key: string, fallback: string): string {
  const value = announcement.safeParams[key];
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : fallback;
}

const copyByTitleKey: Record<string, (announcement: PlatformAnnouncement) => AnnouncementCopy> = {
  PLAYER_BURST: (announcement) => ({
    title: `${announcement.publicActorLabel ?? '有玩家'}在${textParam(announcement, 'gameName', '游戏')}燃尽了`,
    message: `${textParam(announcement, 'difficultyName', '对应难度厅')}的活动效果已开启，详情以服务端快照为准。`,
  }),
  PLAYER_STREAK: (announcement) => ({
    title: `${announcement.publicActorLabel ?? '有玩家'}在${textParam(announcement, 'gameName', '游戏')}连龙`,
    message: `${textParam(announcement, 'roundCount', '多')} 把 · ${textParam(announcement, 'difficultyName', '对应难度厅')}`,
  }),
};

export function announcementCopy(announcement: PlatformAnnouncement): AnnouncementCopy {
  return copyByTitleKey[announcement.titleKey]?.(announcement) ?? {
    title: '平台活动公告',
    message: '查看服务端提供的活动说明与适用范围。',
  };
}

export function announcementScopeLabel(scope: AnnouncementScope): string {
  if (scope.type === 'GLOBAL_HALL') return '全局大厅';
  if (scope.type === 'GAME_HALL') return scope.gameKey;
  if (scope.type === 'DIFFICULTY_HALL') return `${scope.gameKey} · ${scope.difficultyKey}`;
  return '当前牌局';
}
