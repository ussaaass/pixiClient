/**
 * platform-events 仓储适配器（Sequelize 实现 GameEventInstanceRepo 端口；
 * models/game.ts GameEventInstanceModel 只读，活跃公告读路径全在此层）。
 *
 * 领域所有者：platform-events 模块（models/game.ts 为其唯一 model 定义；
 * game_event_instance 只读投影，公告写路径归 configuration / Admin 模块）。
 * 对应 SDD 章节：后端实施 SDD §4（锁顺序 / 幂等先抢唯一约束 / 读用例直接
 * 无事务调用）、§9 第 7 步（平台事件公告：game_event_instance 活跃公告读）、
 * §5.4（GET /me/platform-events/active 替换公告 stub）；数据库设计 SDD §5.6
 * （ix_game_event_instance_status_time（status, starts_at, expires_at, id）
 * 索引支撑活跃公告读路径）。
 *
 * 读路径约定（与 rooms / social 适配器同款纪律）：
 * - 只读无锁（避免不必要行锁，SDD §4 读用例直接无事务调用）；
 * - `lock: undefined` 显式属性在只读查询中删除（避免 exactOptionalPropertyTypes 噪音）；
 * - 活跃公告条件：`status = ACTIVE=1` + `expires_at >= now`（自然到期未过）；
 * - 排序 `starts_at DESC, id DESC`（最新优先，稳定游标）；
 * - 单页上限经 input.limit 传入（首版 ANNOUNCEMENT_PAGE_LIMIT=100，
 *   对齐 contracts ActivePlatformAnnouncementsDataSchema maxItems=100）。
 *
 * 错误码映射（platform-events domain/errors.ts PE 表）：
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障（可重试，路由层 503 映射）。
 *
 * 结构约定（每表一类，不混类）：
 * 本模块只 1 表（game_event_instance）1 个 Repo 接口 1 个类
 * （`SequelizeGameEventInstanceRepo`），共享 `txOf` 辅助函数保留在文件顶部。
 * 注：Sequelize 6 的 BIGINT 列在严格模式（string 属性接口）下读入参经
 * `as never` 桥接（rooms 适配器同款写法，_shared.ts 第 8 条）。
 * `exactOptionalPropertyTypes` 下 Sequelize 查询 options 对象经 `as never`
 * 整体桥接（rooms 适配器同款写法；`transaction: txq` 直传，不写 `?? undefined`）。
 */

import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import type { GameEventInstanceModel } from '../../../infrastructure/database/models/game.js';
import { GameEventInstanceStatus } from '../../../infrastructure/database/models/game.js';
import type { GameEventInstanceRepo, Tx } from '../ports/platform-events-repository.js';

/** 取事务（Sequelize Transaction 鸭子类型；与 rooms 适配器同款约定）。
 * 返回 `Transaction | null`（exactOptionalPropertyTypes 下 undefined 不可赋给
 * null 槽，统一 null 化；options 经 `as never` 整体桥接后直传）。 */
function txOf(tx?: Tx): Transaction | null {
  return (tx?.transaction as Transaction | undefined) ?? null;
}

/**
 * 游戏活动实例仓储（GameEventInstanceRepo；Sequelize 实现，只读路径）。
 * 读全部活跃公告（status=ACTIVE=1 + expires_at >= now，按 starts_at DESC +
 * id DESC 排序，单页上限 100），经 ix_game_event_instance_status_time 索引。
 */
export class SequelizeGameEventInstanceRepo implements GameEventInstanceRepo {
  constructor(private readonly model: typeof GameEventInstanceModel) {}

  async findActiveAnnouncements(input: { now: Date; limit: number; tx: Tx }): Promise<GameEventInstanceModel[]> {
    const txq = txOf(input.tx);
    const rows = await this.model.findAll({
      where: {
        status: GameEventInstanceStatus.ACTIVE,
        // 活跃 = 未自然到期：expires_at > now（`Op.gt` unique symbol 经
        // `as unknown as string` 桥接，TS2538 同款写法，referral 适配器同款）
        expiresAt: { [Op.gt as unknown as string]: input.now } as never,
      } as never,
      order: [
        ['startsAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: input.limit,
      transaction: txq,
    } as never);
    // 应用层双兜底：读回后按 `expiresAt >= now` 过滤（索引条件经 SQL where
    // 下推，本层二次校验防御未来 DDL 变更 / 时区偏差；SDD §4 读路径前置校验）
    const cutoffMs = input.now.getTime();
    return rows.filter((row) => {
      const exp = typeof row.expiresAt === 'string' ? new Date(row.expiresAt).getTime() : row.expiresAt.getTime();
      return exp >= cutoffMs;
    });
  }
}
