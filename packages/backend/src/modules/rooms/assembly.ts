/**
 * rooms 模块装配工厂（inject 全部 ports 的 RoomsModule，供 server 装配调用一次）。
 *
 * 领域所有者：rooms 模块（room / room_membership / round / round_player /
 * round_event / settlement / game_entry 全部用例 + ShisanshuiAdapter 本地注入）。
 * 对应 SDD 章节：后端实施 SDD §1（装配工厂 `createRoomsModule({sequelize,
 * walletModule, config})` 返回注入了全部 ports 的 RoomsModule 对象）、
 * §4（构造注入 ports，不用全局；锁顺序/幂等/同事务约定）、§9 实施顺序
 * 第 4 步（房间与牌局）。
 *
 * 装配模式（参考 `modules/wallet/assembly.ts` + `modules/identity/assembly.ts`）：
 * - `sequelize`：Sequelize 实例（models 已 addModels 注册，§3.2 game 7 model +
 *   outbox + system_config + user）；
 * - `walletModule`：已装配的 WalletModule（取 `walletModule.ledger` 作 AssetLedger、
 *   `walletModule.configReader` 读 game_config、`walletModule.systemIdentity` 取
 *   systemUserId、`walletModule.clock` 取时钟、`walletModule.outbox` 兜底 outbox）；
 * - `config`：时钟注入（测试可传固定时钟；缺省经 walletModule.clock 取，
 *   与 wallet assembly 同款约定）。
 *
 * 未闭环登记（完成报告给 Lead）：
 * - Outbox worker 未建（SDD §8 后续运维项）：OutboxPort 实现为同事务直写
 *   outbox 行（§6.3 "所有分录/outbox 同事务"），消费端在 worker 落地前
 *   无消费者；topic `game.round.settled` 投递 /room/:roomId 待 §9 第 4 步
 *   后续运维闭环；
 * - ShisanshuiAdapter 本地注入（`@gameing/shisanshui-rules` 纯函数包，
 *   非 HTTP/外部调用；决策点登记：需加入 packages/backend package.json
 *   deps workspace:*，由 Lead 处理）；
 * - 占款 operation type：GAME_HOLD 未注册，首版复用 WITHDRAWAL_HOLD=6 +
 *   extra JSON 标记 roundId（登记决策点，若 Lead 确认 TRANSFER=1 改一行）；
 * - round_event payload_ciphertext 首版占位（加密层待闭环，决策点登记）；
 * - round 断线恢复重放（RECOVERING=6）首版只登记状态转换，实际 handler
 *   重放逻辑经 outbox 事件驱动（§9 第 4 步验收"断线恢复重放"待闭环）。
 */

import type { Sequelize, Transaction } from 'sequelize';
import { OutboxModel } from '../../infrastructure/database/models/events.js';
import {
  RoomModel,
  RoomMembershipModel,
  RoundModel,
  RoundPlayerModel,
  RoundEventModel,
  SettlementModel,
  GameEntryModel,
} from '../../infrastructure/database/models/game.js';

import {
  SequelizeRoomRepo,
  SequelizeRoundRepo,
  SequelizeGameEntryRepo,
  SequelizeRoundEventRepo,
  SequelizeSettlementRepo,
} from './adapters/sequelize-rooms.js';
import { ShisanshuiAdapter } from './adapters/shisanshui-adapter.js';

import type { RoomRepo, RoundRepo, GameEntryRepo, RoundEventRepo, SettlementRepo } from './ports/rooms-repository.js';
import type { ShisanshuiAdapterPort } from './ports/shisanshui-adapter.js';

import type { AssetLedger, OutboxPort, OutboxAppendInput, SystemIdentityPort, Clock } from './ports/rooms-repository-exports.js';

import { RoomCreateUseCase } from './application/room-create.js';
import { RoomJoinUseCase } from './application/room-join.js';
import { RoundStartUseCase } from './application/round-start.js';
import { RoundSubmitUseCase } from './application/round-submit.js';
import { RoundSettleUseCase } from './application/round-settle.js';
import { GameEntryUseCase } from './application/game-entry.js';

import type { WalletModule } from '../wallet/assembly.js';

/** 装配配置（测试可注入固定时钟；缺省经 walletModule.clock 取）。 */
export interface RoomsModuleConfig {
  /** 时钟注入（测试可传固定时钟；缺省经 walletModule.clock 取，与 wallet assembly 同款约定）。 */
  clock?: Clock;
}

/** 装配依赖（Sequelize 实例 + 已装配的 WalletModule + 配置；模型类在装配内取，参考 wallet assembly）。 */
export interface RoomsModuleDeps {
  sequelize: Sequelize;
  walletModule: WalletModule;
  config: RoomsModuleConfig;
}

/** 全部 ports + 用例实例的 RoomsModule（构造注入，不用全局，SDD §4）。 */
export interface RoomsModule {
  // ports（共享实现，供测试/其他模块 mock 时参考）
  roomRepo: RoomRepo;
  roundRepo: RoundRepo;
  gameEntryRepo: GameEntryRepo;
  roundEventRepo: RoundEventRepo;
  settlementRepo: SettlementRepo;
  shisanshui: ShisanshuiAdapterPort;
  ledger: AssetLedger;
  clock: Clock;
  systemIdentity: SystemIdentityPort;
  /** 无事务 outbox 兜底（用例外调用；正常路径经 `module.withTx` 取同事务版本）。 */
  outbox: OutboxPort;

  // 用例实例（构造注入 ports，不用全局，SDD §4）
  roomCreate: RoomCreateUseCase;
  roomJoin: RoomJoinUseCase;
  roundStart: RoundStartUseCase;
  roundSubmit: RoundSubmitUseCase;
  roundSettle: RoundSettleUseCase;
  gameEntry: GameEntryUseCase;

  /**
   * 在事务 scope 内构建同事务 outbox port（§6.3 "所有分录/outbox 同事务"）：
   * 资金用例经 `module.withTx(scope, fn)` 把 `scope.transaction` 传入
   * outbox.append，随事务提交/回滚（与 wallet assembly 同款约定）。
   */
  withTx<T>(scope: { transaction: Transaction | null }, fn: (outbox: OutboxPort) => T | Promise<T>): Promise<T>;
}

/**
 * 装配 rooms 模块（inject 全部 ports 的 RoomsModule，供 server 装配调用一次）。
 * 用法（apps/server bootstrap）：
 * ```ts
 * const roomsModule = createRoomsModule({ sequelize, walletModule, config });
 * ```
 */
export function createRoomsModule(deps: RoomsModuleDeps): RoomsModule {
  const { walletModule, config } = deps;

  // 取 walletModule 共享 ports（ledger / configReader / systemIdentity / clock / outbox）。
  const ledger: AssetLedger = walletModule.ledger;
  const systemIdentity: SystemIdentityPort = walletModule.systemIdentity;
  const clock: Clock = config.clock ?? walletModule.clock;

  // Shisanshui 结算适配器（本地包纯函数封装，非 HTTP/外部调用）。
  const shisanshui: ShisanshuiAdapterPort = new ShisanshuiAdapter();

  // 构建 Sequelize 仓储实现（每表一类，不混类；7 model 类构造注入，
  // 不用全局，SDD §4；各 Repo 独立实现，供按角色取用）。
  const models = {
    RoomModel,
    RoomMembershipModel,
    RoundModel,
    RoundPlayerModel,
    RoundEventModel,
    SettlementModel,
    GameEntryModel,
  };
  const roomRepo = new SequelizeRoomRepo(models);
  const roundRepo = new SequelizeRoundRepo(models);
  const gameEntryRepo = new SequelizeGameEntryRepo(models);
  const roundEventRepo = new SequelizeRoundEventRepo(models);
  const settlementRepo = new SequelizeSettlementRepo(models);

  // outbox port（同事务直写 outbox 行，§6.3 "所有分录/outbox 同事务"；
  // 与 wallet assembly 同款约定：无事务版本兜底 + withTx 内同事务版本）。
  const outboxPortFactory = (scope: { transaction: Transaction | null }): OutboxPort => ({
    append(input: OutboxAppendInput) {
      const txq = (scope.transaction as Transaction | undefined) ?? null;
      return OutboxModel.create(
        {
          eventKey: input.eventKey ?? `rooms:${input.topic}:${Date.now()}`,
          topic: input.topic,
          userId: input.userId ?? null,
          assetOperationId: input.assetOperationId ?? null,
          payload: input.payload,
          payloadVersion: input.payloadVersion ?? 1,
          availableAt: input.availableAt ?? new Date(),
        } as never,
        { transaction: txq } as never,
      );
    },
  });

  const defaultOutbox: OutboxPort = outboxPortFactory({ transaction: null });

  // 用例实例（构造注入 ports，不用全局，SDD §4；各 Repo 独立类按角色传入）。
  const roomCreate = new RoomCreateUseCase(roomRepo, gameEntryRepo, clock);
  const roomJoin = new RoomJoinUseCase(roomRepo, gameEntryRepo, roundRepo, clock);
  const roundStart = new RoundStartUseCase(roomRepo, roundRepo, roundEventRepo, ledger, clock, systemIdentity, defaultOutbox);
  const roundSubmit = new RoundSubmitUseCase(roundRepo, roundEventRepo);
  const roundSettle = new RoundSettleUseCase(
    roundRepo,
    roundEventRepo,
    settlementRepo,
    shisanshui,
    ledger,
    systemIdentity,
    clock,
    defaultOutbox,
  );
  const gameEntry = new GameEntryUseCase(gameEntryRepo, clock);

  const module: RoomsModule = {
    roomRepo,
    roundRepo,
    gameEntryRepo,
    roundEventRepo,
    settlementRepo,
    shisanshui,
    ledger,
    clock,
    systemIdentity,
    outbox: defaultOutbox,
    roomCreate,
    roomJoin,
    roundStart,
    roundSubmit,
    roundSettle,
    gameEntry,

    async withTx<T>(scope: { transaction: Transaction | null }, fn: (outbox: OutboxPort) => T | Promise<T>): Promise<T> {
      // 同事务 outbox（§6.3）：把 scope.transaction 传入 outbox.append，随事务提交/回滚。
      return fn(outboxPortFactory({ transaction: scope.transaction }));
    },
  };

  return module;
}

/**
 * 在事务 scope 内构建 outbox port（用例调用 outbox.append 时同事务写 outbox 行，
 * §6.3 "所有分录/outbox 同事务"）。
 * 用法（路由层）：`const outbox = await outboxForRoomsModule(module, tx)` 后传入用例 run。
 */
export function outboxForRoomsModule(module: RoomsModule, tx: { transaction: Transaction | null }): Promise<OutboxPort> {
  return module.withTx({ transaction: (tx.transaction as Transaction | null) ?? null }, (o) => o);
}
