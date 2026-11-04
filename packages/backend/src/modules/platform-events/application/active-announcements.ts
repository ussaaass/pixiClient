/**
 * platform-events 模块用例：活跃公告读取（GET /me/platform-events/active，
 * 替换 app.ts 公告 stub；读 game_event_instance 活跃公告，投影为
 * ActivePlatformAnnouncementsData wire DTO，脱敏最小负载）。
 *
 * 领域所有者：platform-events 模块（读 game_event_instance + 公告投影，
 * 不写表；SDD §9 第 7 步"公告 stub 替换为真实读"）。
 * 对应 SDD 章节：后端实施 SDD §5.4（GET /me/platform-events/active 端点，
 * 替换 /platform/announcements/active stub）、§9 第 7 步（平台事件公告）、
 * §7.3（announcement-templates 发布前后值快照，公告模板键 / 脱敏参数
 * 经 configuration 模块发布，本用例只读投影）；数据库设计 SDD §5.6
 * （game_event_instance 活跃公告读路径 + ix_game_event_instance_status_time）。
 *
 * 用例语义：
 * - 读全部活跃公告（status=ACTIVE=1 + expires_at >= now，经仓储层过滤）；
 * - 经 `domain/event-rules.ts` `projectAnnouncement` 投影为 wire DTO
 *   （announcementId = eventKey，不暴露自增主键；kind=BROADCAST_ONLY，
 *   EFFECT 类活动投影归 §9 第 7 步后续，登记决策点）；
 * - 0 行 → 返回空 announcements 数组（路由层 200 + 空列表，与 stub 行为
 *   一致但来源改为真实读；Stub 替换登记：app.ts `/platform/announcements/active`
 *   路由注册改挂本模块真实读，前端依赖路径 `/platform/announcements/active`
 *   保留不删除，登记决策点：Lead 确认是否双挂新旧路径）。
 *
 * 错误码映射（PE → 触发条件）：
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障（可重试，路由层 503 映射）。
 *
 * 时钟注入：`now` 经 config.clock（SystemClock 缺省，测试可传固定时钟，
 * 与 wallet / rooms assembly 同款约定）。
 */

import type { GameEventInstanceRepo, Tx } from '../ports/platform-events-repository.js';
import type { Clock } from '../../wallet/ports/clock.js';
import { projectAnnouncement, type AnnouncementWire } from '../domain/event-rules.js';

/** 活跃公告单页上限（对齐 contracts ActivePlatformAnnouncementsDataSchema maxItems=100）。 */
export const ANNOUNCEMENT_PAGE_LIMIT = 100;

/**
 * 活跃公告读取结果（wire DTO；对齐 contracts ActivePlatformAnnouncementsDataSchema：
 * announcements: PlatformAnnouncement[] maxItems=100 + cursor 可选）。
 * 首版不启用游标（公告上限 100 单页全量），`nextCursor` 恒 null（登记扩展点：
 * 公告量 > 100 时经 created_at + id 稳定游标分页，§9 第 7 步后续运维闭环）。
 */
export interface ActiveAnnouncementsDto {
  announcements: AnnouncementWire[];
  nextCursor: string | null;
}

/**
 * 活跃公告读取用例（构造注入 GameEventInstanceRepo + Clock，不用全局，
 * SDD §4；读路径无写操作，同事务约定不适用）。
 */
export class ActiveAnnouncementsUseCase {
  constructor(
    private readonly eventRepo: GameEventInstanceRepo,
    private readonly clock: Clock,
  ) {}

  /**
   * GET /me/platform-events/active：读全部活跃公告（投影 wire DTO）。
   * 路由层无事务调用（读用例直接无事务，SDD §4），`tx.transaction` 传 null。
   */
  async run(tx: Tx): Promise<ActiveAnnouncementsDto> {
    const now = await this.clock.now();
    const rows = await this.eventRepo.findActiveAnnouncements({
      now,
      limit: ANNOUNCEMENT_PAGE_LIMIT,
      tx,
    });
    const announcements: AnnouncementWire[] = rows.map((row) =>
      projectAnnouncement({
        id: row.id,
        eventKey: row.eventKey,
        eventType: row.eventType,
        stateVersion: row.stateVersion,
        startsAt: row.startsAt,
        expiresAt: row.expiresAt,
        announcementSnapshot: row.announcementSnapshot,
      }),
    );
    return { announcements, nextCursor: null };
  }
}
