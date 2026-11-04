/**
 * platform-events 模块纯领域规则（announcement 投影：GameEventInstance →
 * PlatformAnnouncement wire 转换，脱敏最小负载，无 IO）。
 *
 * 领域所有者：platform-events 模块（domain/event-rules.ts；用例层 / 适配器层
 * 前置投影经本文件纯函数，不直接读表）。
 * 对应 SDD 章节：后端实施 SDD §9 第 7 步（平台事件公告：game_event_instance
 * 活跃公告读 + 公告投影 wire）、§7.3（announcement-templates 发布前后值
 * 快照，公告模板键 / 脱敏参数经 configuration 模块发布，本模块只读投影）；
 * contracts platform-events/announcement.ts（PlatformAnnouncementSchema：
 * announcementId / eventType / stateVersion / kind / titleKey / safeParams /
 * scope / startsAt / expiresAt + clickAction 可选，脱敏最小负载不含内部
 * 概率 / 资金账本权威）。
 *
 * 投影约定（脱敏红线，SDD §7.3 "公告投影只读不改写权威"）：
 * - `announcementId`：用 `eventKey`（对外不透明活动 ID，不暴露自增主键）；
 * - `eventType`：`event_key` 经 `eventTypeOf` 常量映射（首版 ANNOUNCEMENT=1
 *   登记，未来扩展经 configuration 模块注册）；
 * - `stateVersion`：BIGINT 十进制字符串 wire；
 * - `kind`：`BROADCAST_ONLY`（首版只读广播公告，EFFECT 类活动归 §9 第 7 步
 *   后续；登记决策点：EFFECT 投影需 probabilityDelta / payoutDelta 字段，
 *   首版不含）；
 * - `titleKey` / `safeParams` / `scope` / `clickAction`：经 `announcementSnapshot`
 *   字段读（已校验的公告模板键 + 脱敏参数 + 详情路由快照，SDD §5.6 "已校验
 *   的公告模板键、脱敏参数和详情路由快照"）；snapshot 缺失 → 默认空 safeParams
 *   + 无 clickAction；
 * - 时间列：UTC ISO 字符串 wire（`toISOString`）。
 *
 * 注：本文件纯函数无 IO；GameEventInstanceModel 行经适配器读入后经本投影，
 * 不直接查表（模块内聚，SDD §4）。
 */

/** 平台事件类型常量（首版只注册 ANNOUNCEMENT=1；未来扩展经 configuration 模块注册，登记决策点）。 */
export const PlatformEventType = {
  ANNOUNCEMENT: 1,
} as const;

export type PlatformEventTypeValue = (typeof PlatformEventType)[keyof typeof PlatformEventType];

/**
 * 公告事件类型映射（GameEventInstance.eventType 数值 → 契约 `eventType` 字符串）。
 * 首版只映射 ANNOUNCEMENT=1；未知类型回退 'PLATFORM_EVENT'（登记决策点：
 * 未来经 configuration 模块注册表驱动，本处只改映射点）。
 */
export function eventTypeOf(eventType: number): string {
  if (eventType === PlatformEventType.ANNOUNCEMENT) {
    return 'ANNOUNCEMENT';
  }
  return 'PLATFORM_EVENT';
}

/** 公告 wire DTO（对齐 contracts PlatformAnnouncementSchema；脱敏最小负载）。 */
export interface AnnouncementWire {
  announcementId: string;
  eventType: string;
  stateVersion: number;
  kind: 'EFFECT' | 'BROADCAST_ONLY';
  titleKey: string;
  safeParams: Record<string, string | number>;
  scope: Array<{ type: string; gameKey?: string; difficultyKey?: string }>;
  startsAt: string;
  expiresAt: string;
}

/** 公告 snapshot 形状（models/game.ts `announcementSnapshot` 字段，已校验快照）。 */
export interface AnnouncementSnapshot {
  titleKey?: string;
  safeParams?: Record<string, string | number>;
  scope?: Array<{ type: string; gameKey?: string; difficultyKey?: string }>;
  publicActorLabel?: string;
  clickAction?: { route: string; params: Record<string, unknown> };
}

/**
 * 公告投影（GameEventInstance 行 → AnnouncementWire；脱敏最小负载，无 IO）。
 *
 * @param row 活跃公告行（status=ACTIVE=1，经适配器前置过滤；本函数只投影）。
 * @returns wire DTO；snapshot 缺失字段经默认值兜底（titleKey 缺省 'GENERAL_NOTICE'，
 *   safeParams 缺省空对象，scope 缺省 GLOBAL_HALL 单 scope，无 clickAction）。
 */
export function projectAnnouncement(row: {
  id: string;
  eventKey: string;
  eventType: number;
  stateVersion: string;
  startsAt: Date | string;
  expiresAt: Date | string;
  announcementSnapshot: Record<string, unknown>;
}): AnnouncementWire {
  const snap = (row.announcementSnapshot ?? {}) as AnnouncementSnapshot;
  const scope = snap.scope && snap.scope.length > 0 ? snap.scope.map((s) => s) : [{ type: 'GLOBAL_HALL' }];
  return {
    announcementId: row.eventKey,
    eventType: eventTypeOf(row.eventType),
    stateVersion: Number(row.stateVersion),
    kind: 'BROADCAST_ONLY',
    titleKey: snap.titleKey ?? 'GENERAL_NOTICE',
    safeParams: snap.safeParams ?? {},
    scope,
    startsAt: toIso(row.startsAt),
    expiresAt: toIso(row.expiresAt),
  };
}

/** 时间列 → UTC ISO 字符串 wire（string / Date 双形）。 */
function toIso(d: Date | string): string {
  return typeof d === 'string' ? d : d.toISOString();
}
