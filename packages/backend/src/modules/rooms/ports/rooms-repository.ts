/**
 * rooms 仓储端口（room / room_membership / round / round_player / round_event /
 * settlement / game_entry）。
 *
 * 领域所有者：rooms 模块（adapters/sequelize-rooms.ts 五个独立类实现各 Repo
 * 端口；adapters/shisanshui-adapter.ts 实现 ShisanshuiAdapterPort，直接调
 * @gameing/shisanshui-rules `settleRound` 纯函数，非 HTTP/外部调用）。
 * 对应 SDD 章节：后端实施 SDD §9 第 4 步（房间与牌局：room/round handler
 * 接入，结算一次、settlement 唯一入账、断线恢复重放）、§4（锁顺序
 * room → round → round_player → settlement，asset_account.id 升序；
 * 幂等先抢唯一约束；所有分录/outbox 同事务）、§3.2 实体归属矩阵
 * （game owns room / room_membership / round / round_player / round_event /
 * settlement / game_entry，models/game.ts）。
 *
 * 约定（SDD §2 第 2 条）：
 * - 金额/ID 全链路 BigInt 计算，wire 十进制字符串（row-mapper 完成跨层
 *   格式化，本端口出入参已是字符串/BigInt 业务单位——金币为枚）；
 * - `Tx` 复用 wallet 模块 `Tx`（Sequelize 事务句柄鸭子类型，与 identity /
 *   wallet 模块同款约定），用例内所有写操作共享同一事务（回滚即整事务回滚）；
 * - 不可变表 round_event 只 create，model hooks 拦截 update/destroy
 *   （_shared.ts A.12 第 5 条）；
 * - settlement 唯一性：`U(round_id)` 保证每局只结算一次（验收红线
 *   "结算一次、settlement 唯一入账"，SDD §9 第 4 步）。
 *
 * 注：各 Repo 接口独立命名（RoomRepo / RoundRepo / GameEntryRepo /
 * RoundEventRepo / SettlementRepo），方法名经实体前缀区分（createRoom /
 * createRound / createEntry / append / createSettlement…，各表 CRUD 语义
 * 独立，无重名冲突）；适配器按"每表一类"拆分为 5 个独立类
 * （SequelizeRoomRepo / SequelizeRoundRepo / SequelizeGameEntryRepo /
 * SequelizeRoundEventRepo / SequelizeSettlementRepo，见
 * adapters/sequelize-rooms.ts），各实现自己的接口，供装配层按角色取用。
 * 本文件不再声明 ShisanshuiAdapterPort（统一经 ports/shisanshui-adapter.ts
 * 单一来源，避免重定义）。
 */

import type {
  RoomModel,
  RoomMembershipModel,
  RoundModel,
  RoundPlayerModel,
  RoundEventModel,
  SettlementModel,
  GameEntryModel,
} from '../../../infrastructure/database/models/game.js';

/** 事务句柄（复用 wallet 模块 Tx；Sequelize Transaction 鸭子类型）。 */
export type { Tx } from '../../wallet/ports/wallet-repository.js';
import type { Tx } from '../../wallet/ports/wallet-repository.js';

// ---------------------------------------------------------------------------
// RoomRepo（room + room_membership）
// 方法名：createRoom / lockRoom / listRoomsByUser / joinRoom /
//         seatedCount / listSeated / leaveRoom / closeRoom / markRoomActive
// ---------------------------------------------------------------------------

export interface RoomRepo {
  /**
   * 创建房间（room WAITING=1 + room_key 6 位字母数字随机 + ownerKey +
   * 同事务 game_entry QUEUED=1）。
   * 幂等：room_key U 约束命中 → 返回既有行（不产生第二房）。
   */
  createRoom(input: {
    gameId: string;
    gameTierId: string;
    roomKey: string;
    roomType: number;
    capacity: number;
    rulesSnapshot: Record<string, unknown>;
    ownerKey: string;
    tx: Tx;
  }): Promise<{ inserted: boolean; room: RoomModel }>;

  /** 按主键锁读（SELECT ... FOR UPDATE；room 行锁，fencing 校验前置）。 */
  lockRoom(roomId: string, tx: Tx): Promise<RoomModel | null>;

  /** 用户房间列表（GET /me/rooms；只读，有效 room_status IN (WAITING, ACTIVE, RECOVERING)）。 */
  listRoomsByUser(userId: string, tx?: Tx): Promise<RoomModel[]>;

  /**
   * 入座（room_membership SEATED=1；U(user, active_marker) 防重复；
   * 返回既有 membership 行时 inserted=false，幂等重放）。
   */
  /** 查找用户在该房间的有效入座，用于满员前识别安全幂等重放。 */
  findSeatedMembership(roomId: string, userId: string, tx: Tx): Promise<RoomMembershipModel | null>;

  joinRoom(input: {
    roomId: string;
    userId: string;
    seatNo: number;
    tx: Tx;
  }): Promise<{ inserted: boolean; membership: RoomMembershipModel }>;

  /** 有效入座数（room 满员判定；active_marker = 1 的行数）。 */
  seatedCount(roomId: string, tx: Tx): Promise<number>;

  /** 用户房间内有效入座成员列表（开局逐玩家占款用；status = SEATED=1，按 seat_no 升序）。 */
  listSeated(roomId: string, tx: Tx): Promise<RoomMembershipModel[]>;

  /** 离座（room_membership LEFT=2；幂等：已 LEFT 重放静默返回既有行）。 */
  leaveRoom(roomId: string, userId: string, tx: Tx): Promise<RoomMembershipModel>;

  /** 关闭房间（room CLOSED=4 + closed_at；幂等：已 CLOSED 重放返回既有行）。 */
  closeRoom(roomId: string, tx: Tx): Promise<RoomModel>;

  /** 标记 room ACTIVE=2 + bump fencing_token（每次状态变更 +1，防旧进程写入）。 */
  markRoomActive(roomId: string, newFencingToken: bigint, tx: Tx): Promise<void>;

  /** 持有 room→round 锁后，以旧 token CAS 将 ACTIVE room 置为 RECOVERING 并写入新 token。 */
  claimRoomRecovery(input: { roomId: string; expectedFencingToken: string; newFencingToken: string; tx: Tx }): Promise<void>;
}

// ---------------------------------------------------------------------------
// RoundRepo（round + round_player）
// 方法名：createRound / lockRound / findRoundByRoundKey / findActiveRoundByRoom /
//         maxRoundNoByRoom / createRoundPlayer / submitRound /
//         settleRound / markRoundActive / markRoundSettling /
//         markRoundSettled / markRoundPlayerSettled / cancelRound /
//         recoverRound / listRoundPlayers
// ---------------------------------------------------------------------------

export interface RoundRepo {
  /**
   * 创建牌局（round PREPARING=1 + round_key CHAR(36) + fencing_token
   * 继承 room 当前值；U(round_key) 幂等命中 → 返回既有行，不产生第二局）。
   */
  createRound(input: {
    roomId: string;
    roundNo: bigint;
    roundKey: string;
    fencingToken: string;
    handlerVersion: string;
    rulesSnapshot: Record<string, unknown>;
    rulesHash: Uint8Array;
    tx: Tx;
  }): Promise<{ inserted: boolean; round: RoundModel }>;

  /** 只读 immutable parent id，recovery claim 不应查询 handler/ciphertext 列。 */
  findRoundRoomId(roundId: string, tx: Tx): Promise<{ roomId: string } | null>;

  /** 按主键锁读（SELECT ... FOR UPDATE；遵循 room → round 锁序）。 */
  lockRound(roundId: string, tx: Tx): Promise<RoundModel | null>;

  /** 按 round_key 查（断线恢复重放用；U(round_key) 全局唯一）。 */
  findRoundByRoundKey(roundKey: string, tx?: Tx): Promise<RoundModel | null>;

  /**
   * 查 room 下 ACTIVE round（开局幂等重放用；命中 → 返回既有 round，
   * 不产生第二局。status IN (PREPARING, ACTIVE, SETTLING)，取最新一轮）。
   */
  findActiveRoundByRoom(roomId: string, tx: Tx): Promise<RoundModel | null>;

  /** 读 room 下最大 round_no（新局号 = max + 1；无行 = 0n）。 */
  maxRoundNoByRoom(roomId: string, tx: Tx): Promise<bigint>;

  /**
   * 创建 round_player（ACTIVE=1 + asset_hold_id + wagerCoins + maxLossHoldCoins；
   * U(round, user) 幂等兜底，命中 → 返回既有行）。
   */
  createRoundPlayer(input: {
    roundId: string;
    userId: string;
    roomMembershipId: string | null;
    seatNo: number;
    assetHoldId: string;
    wagerCoins: string;
    maxLossHoldCoins: string;
    fencingToken: string;
    tx: Tx;
  }): Promise<{ inserted: boolean; roundPlayer: RoundPlayerModel }>;

  /**
   * 玩家出牌提交（round_player SUBMITTED=2 + submission_key
   * U(round_id, submission_key) 幂等重放；submission_snapshot JSON
   * 存 arrangement，playerStateCiphertext 存 handler 私有状态）。
   */
  submitRound(input: {
    roundId: string;
    userId: string;
    submissionKey: string;
    submissionSnapshot: Record<string, unknown>;
    submissionHash: Uint8Array;
    submissionType: number;
    tx: Tx;
  }): Promise<{ inserted: boolean; roundPlayer: RoundPlayerModel }>;

  /**
   * 结算写入（settlement PREPARED=1 行创建，round/round_player 状态推进
   * 由用例层经 markRoundSettled / markRoundPlayerSettled 同事务完成）。
   * 唯一性：settlement U(round_id) 命中 → 幂等返回既有行（验收红线）。
   */
  settleRound(input: {
    roundId: string;
    settlementInputHash: Uint8Array;
    resultHash: Uint8Array;
    resultSnapshot: Record<string, unknown>;
    assetOperationId: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; settlement: SettlementModel }>;

  /** 标记 round ACTIVE=2（PREPARING=1 → ACTIVE=2，占款完成后调用）。 */
  markRoundActive(roundId: string, tx: Tx): Promise<void>;

  /** 标记 round SETTLING=3（全部玩家 SUBMITTED 后调用）。 */
  markRoundSettling(roundId: string, tx: Tx): Promise<void>;

  /** 标记 round SETTLED=4（结算完成；settlement COMMITTED=2 同事务）。 */
  markRoundSettled(roundId: string, tx: Tx): Promise<void>;

  /** 标记 round_player SETTLED=3 + net_coin_delta 回填（结算分录同事务）。 */
  markRoundPlayerSettled(roundPlayerId: string, netCoinDelta: string, tx: Tx): Promise<void>;

  /**
   * 取消牌局（round CANCELLED=5 + round_player ABORTED=4 + round_event
   * CANCEL=6）。释放占款由用例经 AssetLedger 完成（同事务）。
   */
  cancelRound(input: { roundId: string; fencingToken: string; tx: Tx }): Promise<void>;

  /** ACTIVE round 以当前 fencing token CAS 转为 RECOVERING 并同步新 room token。 */
  recoverRound(input: { roundId: string; expectedFencingToken: string; newFencingToken: string; tx: Tx }): Promise<void>;

  /** 读 round_player 全量快照（断线恢复用；按 seat_no 升序）。 */
  listRoundPlayers(roundId: string, tx?: Tx): Promise<RoundPlayerModel[]>;
}

// ---------------------------------------------------------------------------
// GameEntryRepo（game_entry）
// 方法名：createEntry / claimEntry / lockEntry / finishEntry / expireEntry /
//         listEntriesByUser
// ---------------------------------------------------------------------------

export interface GameEntryRepo {
  /**
   * 创建入局资格（game_entry QUEUED=1 + entry_key CHAR(36)；
   * U(entry_key) 幂等命中 → 返回既有行）。
   */
  createEntry(input: {
    userId: string;
    gameId: string;
    gameTierId: string;
    entryKey: string;
    rulesSnapshot: Record<string, unknown>;
    expiresAt: Date;
    tx: Tx;
  }): Promise<{ inserted: boolean; entry: GameEntryModel }>;

  /**
   * 入座认领（game_entry QUEUED=1 → SEATED=2 + room_id 回填；
   * 幂等：已 SEATED 同 room 重放返回既有行）。
   */
  claimEntry(input: { entryId: string; roomId: string; tx: Tx }): Promise<{ claimed: boolean; entry: GameEntryModel | null }>;

  /** 按主键锁读。 */
  lockEntry(entryId: string, tx: Tx): Promise<GameEntryModel | null>;

  /** 结算后完成（game_entry SEATED=2 → FINISHED=3；幂等：已 FINISHED 重放）。 */
  finishEntry(entryId: string, tx: Tx): Promise<GameEntryModel>;

  /** 过期判定（expires_at < now → EXPIRED=5；幂等：已 EXPIRED 重放）。 */
  expireEntry(entryId: string, tx: Tx): Promise<GameEntryModel>;

  /** 用户有效 game_entry 列表（GET /me/game-entries；status IN (QUEUED, SEATED)）。 */
  listEntriesByUser(userId: string, tx?: Tx): Promise<GameEntryModel[]>;
}

// ---------------------------------------------------------------------------
// RoundEventRepo（round_event，不可变 append-only）
// 方法名：appendRoundEvent / listRoundEventsAfterSeq
// ---------------------------------------------------------------------------

export interface RoundEventRepo {
  /**
   * 追加事件行（round_event；U(event_key) 幂等；status 固定 RECORDED=1）。
   * 不可变：只 create，model hooks 拦截 update/destroy。
   */
  appendRoundEvent(input: {
    roundId: string;
    roundPlayerId: string | null;
    seq: string;
    eventKey: string;
    eventType: number;
    fencingToken: string;
    payloadCiphertext: Uint8Array;
    tx: Tx;
  }): Promise<{ inserted: boolean; event: RoundEventModel }>;

  /**
   * 游标分页补拉（GET /rounds/:roundId/snapshot 断线恢复；
   * round_event 按 seq 升序，游标 = 上一批最后 seq）。
   */
  listRoundEventsAfterSeq(roundId: string, afterSeq: string, limit: number, tx?: Tx): Promise<RoundEventModel[]>;
}

// ---------------------------------------------------------------------------
// SettlementRepo（settlement，唯一性 U(round_id)）
// 方法名：createSettlement / commitSettlement / findSettlementByRoundId
// ---------------------------------------------------------------------------

export interface SettlementRepo {
  /**
   * 创建结算行（settlement PREPARED=1；U(round_id) 唯一约束幂等兜底，
   * 命中 → 返回既有行，不产生第二笔——验收红线"结算一次"）。
   */
  createSettlement(input: {
    roundId: string;
    inputHash: Uint8Array;
    resultHash: Uint8Array;
    resultSnapshot: Record<string, unknown>;
    assetOperationId: string | null;
    tx: Tx;
  }): Promise<{ inserted: boolean; settlement: SettlementModel }>;

  /** 推进 settlement PREPARED=1 → COMMITTED=2（同事务回填 completed_at）。 */
  commitSettlement(settlementId: string, completedAt: Date, tx: Tx): Promise<SettlementModel>;

  /** 按 round_id 查（幂等重放用；U(round_id) 保证至多一行）。 */
  findSettlementByRoundId(roundId: string, tx?: Tx): Promise<SettlementModel | null>;
}
