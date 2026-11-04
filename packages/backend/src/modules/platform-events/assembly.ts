/**
 * platform-events 模块装配工厂（inject 全部 ports 的 PlatformEventsModule，
 * 供 server 装配调用一次）。
 *
 * 领域所有者：platform-events 模块（game_event_instance 活跃公告读用例 +
 * 公告投影；models/game.ts GameEventInstanceModel 只读，公告写路径归
 * configuration / Admin 模块）。
 * 对应 SDD 章节：后端实施 SDD §1（装配工厂 `createPlatformEventsModule({sequelize,
 * config})` 返回注入了全部 ports 的 PlatformEventsModule 对象）、§4（构造注入
 * ports，不用全局；读用例直接无事务调用）、§9 实施顺序第 7 步（平台事件
 * 公告：活跃公告读 + 公告投影 wire，替换公告 stub）。
 *
 * 装配模式（参考 `modules/rooms/assembly.ts` + `modules/referral/assembly.ts`）：
 * - `sequelize`：Sequelize 实例（models 已 addModels 注册，game_event_instance
 *   经 game.ts model）；
 * - **不依赖 walletModule**：读路径无资金操作；
 * - `config`：时钟注入（测试可传固定时钟；缺省 SystemClock，与 wallet / rooms
 *   assembly 同款约定）。
 *
 * 未闭环登记（完成报告给 Lead）：
 * - 公告写路径（活动创建 / 配置发布 / 撤销 / EFFECT 类活动投影）归
 *   §9 第 7 步 configuration 模块 + §9 第 9 步 Admin 端点，本模块只建
 *   读路径（SDD §5.4 "公告 stub 替换为真实读"验收）；
 * - 公告游标分页（单页 > 100 时）经 created_at + id 稳定游标，首版
 *   全量 100 上限单页，登记扩展点（§9 第 7 步后续运维闭环）；
 * - `/platform/announcements/active` 旧 stub 路径替换：app.ts 挂载真实
 *   读路由，前端依赖路径保留双挂（登记决策点：Lead 确认是否双挂新旧路径）。
 */

import type { Sequelize, Transaction } from 'sequelize';
import { GameEventInstanceModel } from '../../infrastructure/database/models/game.js';
import type { Clock } from '../wallet/ports/clock.js';
import { SystemClock } from '../wallet/ports/clock.js';

import { SequelizeGameEventInstanceRepo } from './adapters/sequelize-platform-events.js';
import type { GameEventInstanceRepo, Tx } from './ports/platform-events-repository.js';
import { ActiveAnnouncementsUseCase } from './application/active-announcements.js';

/** 装配配置（时钟注入；测试可传固定时钟；缺省 SystemClock）。 */
export interface PlatformEventsModuleConfig {
  /** 时钟注入（测试可传固定时钟；缺省 SystemClock，与 wallet / rooms assembly 同款约定）。 */
  clock?: Clock;
}

/** 装配依赖（Sequelize 实例 + 配置；模型类在装配内取，参考 rooms / referral assembly）。 */
export interface PlatformEventsModuleDeps {
  sequelize: Sequelize;
  config: PlatformEventsModuleConfig;
}

/** 全部 ports + 用例实例的 PlatformEventsModule（构造注入，不用全局，SDD §4）。 */
export interface PlatformEventsModule {
  // ports（共享实现，供测试 / 其他模块 mock 时参考）
  eventRepo: GameEventInstanceRepo;
  clock: Clock;

  // 用例实例（构造注入 ports，不用全局，SDD §4）
  activeAnnouncements: ActiveAnnouncementsUseCase;

  /**
   * 在事务 scope 内构建同事务端口（§6.3 "所有分录/outbox 同事务"约定；
   * platform-events 读路径无 outbox，withTx 只透传 tx，供用例读
   * game_event_instance 同事务 / 无事务调用）。
   */
  withTx<T>(scope: { transaction: Transaction | null }, fn: (tx: Tx) => T | Promise<T>): Promise<T>;
}

/**
 * 装配 platform-events 模块（inject 全部 ports 的 PlatformEventsModule，
 * 供 server 装配调用一次）。
 * 用法（apps/server bootstrap）：
 * ```ts
 * const platformEventsModule = createPlatformEventsModule({ sequelize, config });
 * ```
 */
export function createPlatformEventsModule(deps: PlatformEventsModuleDeps): PlatformEventsModule {
  const { sequelize, config } = deps;
  const clock: Clock = config.clock ?? new SystemClock();

  // 构建 Sequelize 仓储实现（每表一类，不混类；1 model 类构造注入，
  // 不用全局，SDD §4；各 Repo 独立实现，供按角色取用）。
  const eventRepo = new SequelizeGameEventInstanceRepo(GameEventInstanceModel);

  // 用例实例（构造注入 ports，不用全局，SDD §4；各 Repo 独立类按角色传入）。
  const activeAnnouncements = new ActiveAnnouncementsUseCase(eventRepo, clock);

  const module: PlatformEventsModule = {
    eventRepo,
    clock,
    activeAnnouncements,

    async withTx<T>(scope: { transaction: Transaction | null }, fn: (tx: Tx) => T | Promise<T>): Promise<T> {
      // 读路径无 outbox，withTx 只透传 tx（用例读 game_event_instance，
      // 同事务 / 无事务调用随 scope.transaction 走，随事务提交 / 回滚）。
      const tx: Tx = { transaction: scope.transaction as Transaction | undefined };
      void sequelize; // 依赖登记（模型类已在构造注入，此处只透传 tx）
      return fn(tx);
    },
  };

  return module;
}
