/**
 * platform-events 模块仓储端口（game_event_instance 活跃公告读路径）。
 *
 * 领域所有者：platform-events 模块（adapters/sequelize-platform-events.ts
 * 实现各端口；models/game.ts GameEventInstanceModel 为 model 定义）。
 * 对应 SDD 章节：后端实施 SDD §4（构造注入 ports，用例 / 适配器经端口落库）、
 * §9 第 7 步（平台事件公告：game_event_instance 活跃公告读 + 公告投影
 * wire）、§5.4（GET /me/platform-events/active 替换公告 stub）；
 * 数据库设计 SDD §5.6（game_event_instance 索引 ix_game_event_instance_
 * status_time（status, starts_at, expires_at, id）支撑活跃公告读路径）。
 *
 * 约定（与 rooms / social / referral 模块 ports 同款纪律）：
 * - 方法名经实体前缀区分（findActiveAnnouncements / lockAnnouncement，
 *   各表 CRUD 语义独立，无重名冲突）；
 * - `Tx` 复用 wallet 模块 `Tx`（Sequelize 事务句柄鸭子类型），用例内所有
 *   读操作共享同一事务（读路径首版可无事务 `tx: { transaction: null }`）；
 * - 本模块首版只读路径（SDD §9 第 7 步"公告 stub 替换为真实读"），
 *   公告写路径（活动创建 / 配置发布 / 撤销）归 configuration 模块 +
 *   Admin 端点（§9 第 9 步），不在本端口范围。
 *
 * 活跃公告读路径（ix_game_event_instance_status_time 索引）：
 * - `status = ACTIVE=1`（GameEventInstanceStatus，models/game.ts）；
 * - `expires_at >= now`（自然到期时间未过）；
 * - `agent_domain_id` 可空（NULL = 平台级；非空 = 域级，本端点不传域筛选，
 *   读全部平台级 + 域级公告，登记决策点：首版不隔离域，Lead 确认）；
 * - 按 `starts_at DESC, id DESC` 排序（最新优先）；
 * - 单页上限 `ANNOUNCEMENT_PAGE_LIMIT = 100`（对齐 contracts
 *   ActivePlatformAnnouncementsDataSchema maxItems=100）。
 */

import type { GameEventInstanceModel } from '../../../infrastructure/database/models/game.js';
import type { Tx } from '../../wallet/ports/wallet-repository.js';

export type { Tx };

// ---------------------------------------------------------------------------
// GameEventInstanceRepo（game_event_instance，只读路径）
// 方法名：findActiveAnnouncements
// ---------------------------------------------------------------------------

export interface GameEventInstanceRepo {
  /**
   * 读全部活跃公告（status=ACTIVE=1 + expires_at >= now；按 starts_at DESC +
   * id DESC 排序，单页上限 100）。
   * @param input.now 当前 UTC 时刻（用例层注入时钟，测试可传固定时钟；
   *   缺省 `new Date()`）。
   * @returns 活跃公告行（0 行 → 空数组，路由层返回 200 + 空公告列表，
   *   与 stub 行为一致但来源改为真实读）。
   */
  findActiveAnnouncements(input: { now: Date; limit: number; tx: Tx }): Promise<GameEventInstanceModel[]>;
}
