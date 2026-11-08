/**
 * rooms 模块跨模块唯一入口（SDD §1 public.ts 约定：模块内聚，对外仅 public.ts）。
 *
 * 领域所有者：rooms 模块（room / room_membership / round / round_player /
 * round_event / settlement / game_entry 全部用例 + ShisanshuiAdapter 本地注入）。
 * 对应 SDD 章节：后端实施 SDD §1（"modules/…/public.ts 跨模块唯一入口"）、
 * §4（application / ports / adapters 布局）、§9 实施顺序第 4 步
 * （房间与牌局：结算一次、settlement 唯一入账、断线恢复重放）。
 *
 * 导出约定（与 wallet 模块 public.ts 同款纪律）：
 * - 全部用例类（构造注入 ports，不用全局——SDD §4 "构造注入"）；
 * - ports 接口（供其他模块 / 测试 mock 依赖，不直接 import adapters）；
 * - 装配工厂 `createRoomsModule`（由 `assembly.ts` 提供，本入口 re-export）；
 * - 领域纯函数与错误工具（domain/ 子目录；fencing/状态机/幂等键/哈希/
 *   金额转换，无 IO）；
 * - 本地 ports（ShisanshuiAdapterPort + rooms 仓储端口）。
 *
 * 用例文件之间不互相 import 内部类；跨用例共享经本文件。
 * 与 wallet 模块集成点（装配层经 `WalletModule` 取共享 ports）：
 * - `AssetLedger`（ledger / claimOperation / postEntries / createHold /
 *   releaseHold / lockAccountsByIds）；
 * - `Clock`（时钟注入，测试可传固定时钟）；
 * - `SystemIdentityPort`（systemUserId，结算分录系统账户定位）；
 * - `OutboxPort`（同事务 outbox，§6.3 "所有分录/outbox 同事务"）。
 */

// ---------------------------------------------------------------------------
// 用例类（application/；构造注入 ports，不用全局）
// ---------------------------------------------------------------------------
export { RoomCreateUseCase, type RoomCreatedDto } from './application/room-create.js';
export { RoomJoinUseCase, type JoinRoomResultDto } from './application/room-join.js';
export { RoundStartUseCase, type RoundStartResultDto } from './application/round-start.js';
export { RoundSubmitUseCase, type RoundSubmitResultDto } from './application/round-submit.js';
export { RoundSettleUseCase, type RoundSettlementDto } from './application/round-settle.js';
export { createRoundSnapshotUseCase, type RoundSnapshotDto } from './application/round-snapshot.js';
export { GameEntryUseCase, type GameEntryDto } from './application/game-entry.js';

// ---------------------------------------------------------------------------
// 装配工厂（inject 全部 ports 的 RoomsModule 对象，供 server 装配调用一次）
// ---------------------------------------------------------------------------
export { createRoomsModule, outboxForRoomsModule, type RoomsModule, type RoomsModuleDeps, type RoomsModuleConfig } from './assembly.js';

// ---------------------------------------------------------------------------
// ports（供其他模块 / 测试 mock；不直接 import adapters）
// ---------------------------------------------------------------------------
export type { RoomRepo, RoundRepo, GameEntryRepo, RoundEventRepo, SettlementRepo, Tx } from './ports/rooms-repository.js';
export type { ShisanshuiAdapterPort } from './ports/shisanshui-adapter.js';

// 跨模块复用 wallet ports（经 rooms-repository-exports.ts 统一入口，
// 不直接跨模块 import 内部文件，保持模块内聚）
export type { AssetLedger, EntryIntent, SystemIdentityPort, OutboxPort, Clock } from './ports/rooms-repository-exports.js';
export { WalletOperationType, WalletEntryType } from './ports/rooms-repository-exports.js';

// ---------------------------------------------------------------------------
// 领域纯函数与错误工具（domain/；fencing/状态机/幂等键/哈希/金额转换，无 IO）
// ---------------------------------------------------------------------------
export { RoomDomainError, R, isRoomDomainError, isDuplicateKeyError, type RoomErrorCode } from './domain/errors.js';
export {
  parseShisanshuiStakeConfig,
  resolveShisanshuiStake,
  type ShisanshuiStakeConfig,
  type ResolvedShisanshuiStake,
} from './domain/stake-config.js';
export {
  ROUND_STATUS,
  ROUND_PLAYER_STATUS,
  ROUND_TRANSITIONS,
  ROUND_PLAYER_TRANSITIONS,
  canRoundTransition,
  canRoundPlayerTransition,
  isValidFencingToken,
  bumpFencingToken,
  submissionKeyOf,
  settlementInputHashOf,
  resultHashOf,
  waterToBigInt,
  bigIntToWire,
  type RoundStatusValue,
  type RoundPlayerStatusValue,
} from './domain/round-rules.js';

// ---------------------------------------------------------------------------
// 适配器（Sequelize 实现；每表一类；供测试直接构造，生产经 createRoomsModule）
// ---------------------------------------------------------------------------
export {
  SequelizeRoomRepo,
  SequelizeRoundRepo,
  SequelizeGameEntryRepo,
  SequelizeRoundEventRepo,
  SequelizeSettlementRepo,
} from './adapters/sequelize-rooms.js';
export { ShisanshuiAdapter } from './adapters/shisanshui-adapter.js';
