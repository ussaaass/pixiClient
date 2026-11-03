/**
 * game — 游戏目录、配置、房间、牌局与入局资格：`game` / `game_tier` / `game_config` /
 * `system_config` / `game_event_instance`（附录 A.10 登记归属 platform-events，本处共置便于 join）/
 * `room` / `room_membership` / `round` / `round_player` / `round_event`（不可变）/
 * `settlement` / `game_entry`。
 *
 * 领域所有者：game 模块 + platform-events 模块（models/game.ts 为其唯一 model 定义；
 * `game_event_instance` 若独立拆分见附录 A.10 备注）。
 * 对应 SDD 章节：后端实施SDD 附录 A.2 + A.10；数据库设计SDD §5.2 / §5.2.1 / §5.7。
 * DDL 以迁移 0008-create-lobby-config.ts 与 0013-create-rooms.ts 为准。
 *
 * 读写用例：
 * - `GameModel` / `GameTierModel`：大厅目录与档位准入（金币范围 CHECK）。
 * - `SystemConfigModel` / `GameConfigModel`：配置读取与发布（COALESCE(agent_domain_id,0)
 *   归一唯一索引由迁移层表达式索引承载）；agent_domain FK 由 0009 补建。
 * - `GameEventInstanceModel`：跨牌局持续的平台活动及其安全公告快照
 *   （source_round FK 待 0013 补建，批次内 0008 先建列）。
 * - `RoomModel`：房间生命周期、规则快照与进程接管栅栏（fencing_token/checkpoint_version）。
 * - `RoomMembershipModel`：座位与有效入座（active_marker 生成列 + U(user,active_marker)）。
 * - `RoundModel`：一局生命周期与恢复输入（round_key U；fencing_token 与 room 一致）。
 * - `RoundPlayerModel`：牌局参与人、资产风险与结算结果（asset_hold 1:1 U）。
 * - `RoundEventModel`（不可变）：可恢复牌局事件流水（seq 局内连续，event_key U）。
 * - `SettlementModel`：唯一牌局资产结算与战绩（round 1:1 U；结算结论不可软删）。
 * - `GameEntryModel`：游戏准入资格（active_marker 生成列 + U(user,active_marker)）。
 *
 * MEDIUMBLOB 密文列（game_state_ciphertext / player_state_ciphertext / payload_ciphertext）
 * 模型保持二进制原样（DataTypes.BLOB），解密与展示在领域层/row-mapper。
 */

import { DataTypes, Model, type Optional, type Sequelize } from 'sequelize';
import {
  appendOnlyHooks,
  appendOnlyModelOptions,
  standardTableOptions,
  binaryDataType,
  type ModelInitFn,
  type ModelInitOptions,
} from './_shared.js';

// ---------------------------------------------------------------------------
// game
// ---------------------------------------------------------------------------

/** `game` 表属性。asset_id 引用 asset 表，外键待 0017 补建。 */
export interface GameModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 稳定游戏代码，如 thirteen（U(game_code)）。 */
  gameCode: string;
  /** 显示名称。 */
  name: string;
  /** 接入类型：INTERNAL=1/EXTERNAL_STUB=2。 */
  integrationType: number;
  /** 前端注册表模块键，不为任意执行 URL。 */
  clientModuleKey: string | null;
  /** 大厅展示封面，引用 asset 表；外键待 0017 补建。 */
  assetId: string;
  /** 大厅排序，数值不是状态。 */
  sortOrder: number;
}

export type GameModelCreationAttributes = Optional<GameModelAttributes, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

export class GameModel extends Model<GameModelAttributes, GameModelCreationAttributes> implements GameModelAttributes {
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  gameCode!: string;
  name!: string;
  integrationType!: number;
  clientModuleKey!: string | null;
  assetId!: string;
  sortOrder!: number;
  static associate(models: { GameModel: typeof GameModel }): void {
    void models.GameModel;
    // asset 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// game_tier
// ---------------------------------------------------------------------------

/** `game_tier` 表属性。U(game_id,tier_code)；金币范围 CHECK：min>=0 且 max NULL 或 >=min。 */
export interface GameTierModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 所属游戏，引用 game.id。 */
  gameId: string;
  /** 游戏内唯一档位代码。 */
  tierCode: string;
  name: string;
  /** 准入金币下限（十进制字符串 wire）。 */
  minCoins: string;
  /** 准入金币上限，NULL 表示无上限。 */
  maxCoins: string | null;
  /** 档位排序。 */
  sortOrder: number;
}

export type GameTierModelCreationAttributes = Optional<GameTierModelAttributes, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

export class GameTierModel extends Model<GameTierModelAttributes, GameTierModelCreationAttributes> implements GameTierModelAttributes {
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  gameId!: string;
  tierCode!: string;
  name!: string;
  minCoins!: string;
  maxCoins!: string | null;
  sortOrder!: number;
  static associate(models: { GameTierModel: typeof GameTierModel; GameModel: typeof GameModel }): void {
    GameTierModel.belongsTo(models.GameModel, {
      foreignKey: 'game_id',
      as: 'game',
      constraints: false,
    });
  }
}

// ---------------------------------------------------------------------------
// system_config
// ---------------------------------------------------------------------------

/**
 * `system_config` 表属性。全局配置项：config_key U；config_value 为原始字符串，
 * 按 config_type 对应 parser 安全转换。
 */
export interface SystemConfigModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 配置键，如 wallet.exchange（U(config_key)）。 */
  configKey: string;
  /** 配置值类型：STRING=1/BOOLEAN=2/INTEGER=3/DECIMAL=4/JSON=5。 */
  configType: number;
  /** 原始字符串；按 config_type 与 config_key 对应的运行时 parser 严格转换。 */
  configValue: string;
  /** 面向 Admin 的用途及单位说明。 */
  description: string;
}

export type SystemConfigModelCreationAttributes = Optional<
  SystemConfigModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class SystemConfigModel
  extends Model<SystemConfigModelAttributes, SystemConfigModelCreationAttributes>
  implements SystemConfigModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  configKey!: string;
  configType!: number;
  configValue!: string;
  description!: string;
  static associate(models: { SystemConfigModel: typeof SystemConfigModel }): void {
    void models.SystemConfigModel;
  }
}

// ---------------------------------------------------------------------------
// game_config
// ---------------------------------------------------------------------------

/**
 * `game_config` 表属性。U(COALESCE(agent_domain_id,0), game_id, COALESCE(game_tier_id,0),
 * config_key)（表达式唯一索引由迁移层承载）；agent_domain FK 由 0009 补建；
 * scope_type=1⇒game_tier_id 空，=2⇒非空（CHECK 强制）。
 */
export interface GameConfigModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 配置所属游戏，引用 game.id。 */
  gameId: string;
  /** 档位配置引用；全游戏配置为空。 */
  gameTierId: string | null;
  /** 配置所属代理域；NULL 表示平台基准配置；外键由 0009 补建。 */
  agentDomainId: string | null;
  /** 配置范围：GAME=1/TIER=2。 */
  scopeType: number;
  /** 游戏配置键。 */
  configKey: string;
  /** 配置值类型：STRING=1/BOOLEAN=2/INTEGER=3/DECIMAL=4/JSON=5。 */
  configType: number;
  /** 按领域 parser 转换的原始字符串。 */
  configValue: string;
  /** 配置用途与计量单位。 */
  description: string;
}

export type GameConfigModelCreationAttributes = Optional<
  GameConfigModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class GameConfigModel
  extends Model<GameConfigModelAttributes, GameConfigModelCreationAttributes>
  implements GameConfigModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  gameId!: string;
  gameTierId!: string | null;
  agentDomainId!: string | null;
  scopeType!: number;
  configKey!: string;
  configType!: number;
  configValue!: string;
  description!: string;
  static associate(models: {
    GameConfigModel: typeof GameConfigModel;
    GameModel: typeof GameModel;
    GameTierModel: typeof GameTierModel;
  }): void {
    GameConfigModel.belongsTo(models.GameModel, { foreignKey: 'game_id', as: 'game', constraints: false });
    GameConfigModel.belongsTo(models.GameTierModel, {
      foreignKey: 'game_tier_id',
      as: 'gameTier',
      constraints: false,
    });
    // agent_domain 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// game_event_instance
// ---------------------------------------------------------------------------

/**
 * `game_event_instance` 表属性（platform-events 模块登记）。event_key / trigger_key 双 U；
 * audience_scope 与 game/game_tier 组合 CHECK；source_round FK 待 0013 补建，
 * agent_domain FK 由 0009 补建。
 */
export interface GameEventInstanceModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 对外不透明活动 ID，不暴露自增主键。 */
  eventKey: string;
  /** 来源事实与触发规则组合出的幂等键。 */
  triggerKey: string;
  /** 注册的平台事件类型常量，取值由共享代码维护。 */
  eventType: number;
  /** 活动域；NULL 表示平台级，非空时仅限此域；外键待 0009 补建。 */
  agentDomainId: string | null;
  /** 公告主要展示范围：GLOBAL=1/GAME=2/GAME_TIER=3。 */
  audienceScopeType: number;
  /** 主要影响游戏；GAME/GAME_TIER 范围必填。 */
  gameId: string | null;
  /** 主要影响难度厅；GAME_TIER 范围必填。 */
  gameTierId: string | null;
  /** 触发活动的牌局，引用 round 表；非牌局来源为空；外键待 0013 补建。 */
  sourceRoundId: string | null;
  /** 活动来源角色：USER=1/BOT=2/SYSTEM=3，区分真实来源。 */
  sourceActorType: number;
  /** 公告主体，引用 user.id；服务端向该用户及其设备排除本活动。 */
  subjectUserId: string | null;
  /** BIGINT UNSIGNED：活动状态每次变化递增的并发/客户端版本。 */
  stateVersion: string;
  /** 活动开始时间。 */
  startsAt: Date | string;
  /** 配置的自然到期时间。 */
  expiresAt: Date | string;
  /** 实际结束时间，奖池耗尽/撤销/自然到期时填写。 */
  endedAt: Date | string | null;
  /** 结束原因：EXPIRED=1/POOL_EXHAUSTED=2/ADMIN_CANCELLED=3。 */
  endReasonType: number | null;
  /** 创建时生效的触发规则、配置版本和范围快照。 */
  configSnapshot: Record<string, unknown>;
  /** 有版本的影响档位、概率/派奖变更及目标列表；目标 ID 键遵守引用命名规则。 */
  effectSnapshot: Record<string, unknown>;
  /** 可重建的展示/运行投影，不作为资金账本或概率配置权威。 */
  runtimeSnapshot: Record<string, unknown> | null;
  /** 已校验的公告模板键、脱敏参数和详情路由快照。 */
  announcementSnapshot: Record<string, unknown>;
}

export type GameEventInstanceModelCreationAttributes = Optional<
  GameEventInstanceModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class GameEventInstanceModel
  extends Model<GameEventInstanceModelAttributes, GameEventInstanceModelCreationAttributes>
  implements GameEventInstanceModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  eventKey!: string;
  triggerKey!: string;
  eventType!: number;
  agentDomainId!: string | null;
  audienceScopeType!: number;
  gameId!: string | null;
  gameTierId!: string | null;
  sourceRoundId!: string | null;
  sourceActorType!: number;
  subjectUserId!: string | null;
  stateVersion!: string;
  startsAt!: Date | string;
  expiresAt!: Date | string;
  endedAt!: Date | string | null;
  endReasonType!: number | null;
  configSnapshot!: Record<string, unknown>;
  effectSnapshot!: Record<string, unknown>;
  runtimeSnapshot!: Record<string, unknown> | null;
  announcementSnapshot!: Record<string, unknown>;
  static associate(models: {
    GameEventInstanceModel: typeof GameEventInstanceModel;
    GameModel: typeof GameModel;
    GameTierModel: typeof GameTierModel;
  }): void {
    GameEventInstanceModel.belongsTo(models.GameModel, {
      foreignKey: 'game_id',
      as: 'game',
      constraints: false,
    });
    GameEventInstanceModel.belongsTo(models.GameTierModel, {
      foreignKey: 'game_tier_id',
      as: 'gameTier',
      constraints: false,
    });
    // agent_domain / subject_user / source_round 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// room
// ---------------------------------------------------------------------------

/**
 * `room` 表属性。房间接管栅栏：fencing_token 每次进程接管递增（>=1）、
 * checkpoint_version 记录已持久化检查点（>=0）。
 */
export interface RoomModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 游戏，引用 game.id。 */
  gameId: string;
  /** 难度厅，引用 game_tier.id。 */
  gameTierId: string;
  /** 公开房号（U(room_key)）。 */
  roomKey: string;
  /** 房间类型：PRIVATE=1/MATCHED=2。 */
  roomType: number;
  /** 游戏/档位配置的最大玩家数快照。 */
  capacity: number;
  /** 创建时解析规则快照，发布配置不改当前局。 */
  rulesSnapshot: Record<string, unknown>;
  /** BIGINT UNSIGNED：房间持久事件版本。 */
  version: string;
  /** 当前持有房间的游戏进程实例标识。 */
  ownerKey: string | null;
  /** BIGINT UNSIGNED：每次进程接管递增，拒绝旧进程写入（CHECK >=1）。 */
  fencingToken: string;
  /** BIGINT UNSIGNED：当前已持久化房间检查点版本（CHECK >=0）。 */
  checkpointVersion: string;
  /** 关闭时间。 */
  closedAt: Date | string | null;
}

export type RoomModelCreationAttributes = Optional<RoomModelAttributes, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

export class RoomModel extends Model<RoomModelAttributes, RoomModelCreationAttributes> implements RoomModelAttributes {
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  gameId!: string;
  gameTierId!: string;
  roomKey!: string;
  roomType!: number;
  capacity!: number;
  rulesSnapshot!: Record<string, unknown>;
  version!: string;
  ownerKey!: string | null;
  fencingToken!: string;
  checkpointVersion!: string;
  closedAt!: Date | string | null;
  static associate(models: { RoomModel: typeof RoomModel; GameModel: typeof GameModel; GameTierModel: typeof GameTierModel }): void {
    RoomModel.belongsTo(models.GameModel, { foreignKey: 'game_id', as: 'game', constraints: false });
    RoomModel.belongsTo(models.GameTierModel, {
      foreignKey: 'game_tier_id',
      as: 'gameTier',
      constraints: false,
    });
  }
}

// ---------------------------------------------------------------------------
// room_membership
// ---------------------------------------------------------------------------

/**
 * `room_membership` 表属性。active_marker 生成列：status=SEATED 且未删除为 1，
 * 否则 NULL（不进入 attributes）；U(user,active_marker) 限制每用户至多一个有效入座；
 * U(room,seat_no,active_marker) 限制座位唯一。
 */
export interface RoomMembershipModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 房间，引用 room.id。 */
  roomId: string;
  /** 玩家，引用 user.id；同一用户不能跨房重复入座。 */
  userId: string;
  /** 座位编号 1 到 4。 */
  seatNo: number;
  /** 入座时间。 */
  joinedAt: Date | string;
  /** 离座时间。 */
  leftAt: Date | string | null;
  /** MEDIUMBLOB：当前房间成员的游戏专属累积状态密文；平台不解释其内部字段。 */
  gameStateCiphertext: Uint8Array | null;
  /** BIGINT UNSIGNED：当前成员游戏状态的并发版本；每次成功更新或清空递增，不使用 0。 */
  gameStateVersion: string;
  /**
   * 生成列（数据库层只读，非 TS 层 readonly）：TINYINT UNSIGNED GENERATED ALWAYS AS
   * (CASE WHEN status=1 AND deleted_at IS NULL THEN 1 ELSE NULL END) STORED；
   * 不进 model attributes（A.12 第 6 条）。
   */
  activeMarker: number | null;
}

export type RoomMembershipModelCreationAttributes = Optional<
  RoomMembershipModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class RoomMembershipModel
  extends Model<RoomMembershipModelAttributes, RoomMembershipModelCreationAttributes>
  implements RoomMembershipModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  roomId!: string;
  userId!: string;
  seatNo!: number;
  joinedAt!: Date | string;
  leftAt!: Date | string | null;
  gameStateCiphertext!: Uint8Array | null;
  gameStateVersion!: string;
  /** 生成列，只读（见 interface 注释）。 */
  activeMarker!: number | null;
  static associate(models: { RoomMembershipModel: typeof RoomMembershipModel; RoomModel: typeof RoomModel }): void {
    RoomMembershipModel.belongsTo(models.RoomModel, {
      foreignKey: 'room_id',
      as: 'room',
      constraints: false,
    });
    // user 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// round
// ---------------------------------------------------------------------------

/**
 * `round` 表属性。U(room_id,round_no)、U(round_key)；fencing_token 为
 * 本局所有权版本（关键写入须与 room.fencing_token 一致）；
 * rules_hash BINARY(32) 为规则快照摘要。
 */
export interface RoundModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 所属房间，引用 room.id。 */
  roomId: string;
  /** BIGINT UNSIGNED：房间内局号。 */
  roundNo: string;
  /** CHAR(36)：全局牌局业务编号（U(round_key)）。 */
  roundKey: string;
  /** BIGINT UNSIGNED：本局所有权版本；关键写入须与 room.fencing_token 一致。 */
  fencingToken: string;
  /** 创建本局时使用的游戏 handler 版本，保证历史局可回放。 */
  handlerVersion: string;
  /** 游戏 handler 提供的完整规则快照，平台不解释其内部字段。 */
  rulesSnapshot: Record<string, unknown>;
  /** BINARY(32)：规则快照摘要。 */
  rulesHash: Uint8Array;
  /** MEDIUMBLOB：handler 私有的随机/状态恢复数据，平台不解释内容。 */
  gameStateCiphertext: Uint8Array | null;
  /** 本局可交互阶段开始时间。 */
  playingStartedAt: Date | string | null;
  /** handler 规定的本局操作截止时间。 */
  playingDeadlineAt: Date | string | null;
  /** 已封存的 handler 结算输入与超时结果。 */
  settlementInput: Record<string, unknown> | null;
  /** BINARY(32)：不可变结算意图摘要。 */
  settlementInputHash: Uint8Array | null;
  /** 资金与战绩提交时间。 */
  settledAt: Date | string | null;
}

export type RoundModelCreationAttributes = Optional<RoundModelAttributes, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

export class RoundModel extends Model<RoundModelAttributes, RoundModelCreationAttributes> implements RoundModelAttributes {
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  roomId!: string;
  roundNo!: string;
  roundKey!: string;
  fencingToken!: string;
  handlerVersion!: string;
  rulesSnapshot!: Record<string, unknown>;
  rulesHash!: Uint8Array;
  gameStateCiphertext!: Uint8Array | null;
  playingStartedAt!: Date | string | null;
  playingDeadlineAt!: Date | string | null;
  settlementInput!: Record<string, unknown> | null;
  settlementInputHash!: Uint8Array | null;
  settledAt!: Date | string | null;
  static associate(models: { RoundModel: typeof RoundModel; RoomModel: typeof RoomModel }): void {
    RoundModel.belongsTo(models.RoomModel, { foreignKey: 'room_id', as: 'room', constraints: false });
  }
}

// ---------------------------------------------------------------------------
// round_player
// ---------------------------------------------------------------------------

/**
 * `round_player` 表属性。U(round,user)、U(round,seat_no)、U(asset_hold_id)、
 * U(submission_key)；wager_coins/max_loss_hold_coins 为有符号 BIGINT（十进制字符串 wire）。
 */
export interface RoundPlayerModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 牌局，引用 round.id。 */
  roundId: string;
  /** 玩家，引用 user.id。 */
  userId: string;
  /** 房间局开局时锁定的成员关系；非房间运行模式为空。 */
  roomMembershipId: string | null;
  /** 本局座次，1 到 4。 */
  seatNo: number;
  /** 开局最大赔付金币占款，引用 asset_hold.id；本局内不可变（U）。 */
  assetHoldId: string;
  /** MEDIUMBLOB：handler 私有的玩家状态加密数据。 */
  playerStateCiphertext: Uint8Array | null;
  /** handler 定义的玩家提交内容，平台不解释内部字段。 */
  submissionSnapshot: Record<string, unknown> | null;
  /** 提交命令幂等定位值；重复提交返回原结果。 */
  submissionKey: string | null;
  /** BINARY(32)：提交内容摘要。 */
  submissionHash: Uint8Array | null;
  /** 成功持久化提交时间。 */
  submittedAt: Date | string | null;
  /** 提交类型：MANUAL=1/TIMEOUT_AUTO=2。 */
  submissionType: number | null;
  /** 本局规则定义的有效下注额，流水计算基数（十进制字符串 wire）。 */
  wagerCoins: string;
  /** 赔付上限，独立于 wager（十进制字符串 wire）。 */
  maxLossHoldCoins: string;
  /** 实际金币净变化，有符号整数。 */
  netCoinDelta: string | null;
}

export type RoundPlayerModelCreationAttributes = Optional<
  RoundPlayerModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class RoundPlayerModel
  extends Model<RoundPlayerModelAttributes, RoundPlayerModelCreationAttributes>
  implements RoundPlayerModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  roundId!: string;
  userId!: string;
  roomMembershipId!: string | null;
  seatNo!: number;
  assetHoldId!: string;
  playerStateCiphertext!: Uint8Array | null;
  submissionSnapshot!: Record<string, unknown> | null;
  submissionKey!: string | null;
  submissionHash!: Uint8Array | null;
  submittedAt!: Date | string | null;
  submissionType!: number | null;
  wagerCoins!: string;
  maxLossHoldCoins!: string;
  netCoinDelta!: string | null;
  static associate(models: { RoundPlayerModel: typeof RoundPlayerModel; RoundModel: typeof RoundModel }): void {
    RoundPlayerModel.belongsTo(models.RoundModel, {
      foreignKey: 'round_id',
      as: 'round',
      constraints: false,
    });
    // user / room_membership / asset_hold 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// round_event（不可变）
// ---------------------------------------------------------------------------

/**
 * `round_event` 表属性（不可变可恢复牌局事件流水）。status 固定 RECORDED=1；
 * updated_at 固定等于 created_at；deleted_at 恒 NULL（迁移 CHECK）。
 * U(round_id,seq)、U(event_key)；payload_ciphertext MEDIUMBLOB 为加密负载。
 */
export interface RoundEventModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 牌局，引用 round.id。 */
  roundId: string;
  /** 涉及某玩家时引用 round_player.id。 */
  roundPlayerId: string | null;
  /** BIGINT UNSIGNED：局内连续事件序号（CHECK >=1）。 */
  seq: string;
  /** 命令或事件幂等语义键（U(event_key)）。 */
  eventKey: string;
  /** 事件类型：START=1/SUBMIT=2/INTENT=3/SETTLE=4/RECOVER=5/CANCEL=6。 */
  eventType: number;
  /** BIGINT UNSIGNED：写入 owner 版本。 */
  fencingToken: string;
  /** MEDIUMBLOB：可恢复事件加密负载。 */
  payloadCiphertext: Uint8Array;
}

export type RoundEventModelCreationAttributes = Optional<
  RoundEventModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class RoundEventModel
  extends Model<RoundEventModelAttributes, RoundEventModelCreationAttributes>
  implements RoundEventModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  roundId!: string;
  roundPlayerId!: string | null;
  seq!: string;
  eventKey!: string;
  eventType!: number;
  fencingToken!: string;
  payloadCiphertext!: Uint8Array;
  static associate(models: { RoundEventModel: typeof RoundEventModel; RoundModel: typeof RoundModel }): void {
    RoundEventModel.belongsTo(models.RoundModel, {
      foreignKey: 'round_id',
      as: 'round',
      constraints: false,
    });
    // round_player 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// settlement
// ---------------------------------------------------------------------------

/**
 * `settlement` 表属性。结算结论不可软删（deleted_at 恒 NULL，迁移 CHECK）；
 * U(round_id)（每局至多一条）、U(asset_operation_id)。
 */
export interface SettlementModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 被结算牌局，引用 round.id；每局至多一条。 */
  roundId: string;
  /** 完成资产操作，引用 asset_operation.id；作废局可为空。 */
  assetOperationId: string | null;
  /** BINARY(32)：匹配牌局封存输入。 */
  inputHash: Uint8Array;
  /** BINARY(32)：最终结果摘要。 */
  resultHash: Uint8Array;
  /** 游戏 handler 生成的完整结算结果，含其 schema/version 和展示数据。 */
  resultSnapshot: Record<string, unknown>;
  /** 结算完成时刻。 */
  completedAt: Date | string | null;
}

export type SettlementModelCreationAttributes = Optional<
  SettlementModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class SettlementModel
  extends Model<SettlementModelAttributes, SettlementModelCreationAttributes>
  implements SettlementModelAttributes
{
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  roundId!: string;
  assetOperationId!: string | null;
  inputHash!: Uint8Array;
  resultHash!: Uint8Array;
  resultSnapshot!: Record<string, unknown>;
  completedAt!: Date | string | null;
  static associate(models: { SettlementModel: typeof SettlementModel; RoundModel: typeof RoundModel }): void {
    SettlementModel.belongsTo(models.RoundModel, {
      foreignKey: 'round_id',
      as: 'round',
      constraints: false,
    });
    // asset_operation 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// game_entry
// ---------------------------------------------------------------------------

/**
 * `game_entry` 表属性。入局资格：U(entry_key)、U(user,active_marker)（active_marker
 * 生成列：status IN (QUEUED,SEATED) 且未删除为 1，不进入 attributes）。
 */
export interface GameEntryModelAttributes {
  id: string;
  status: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  deletedAt: Date | string | null;
  /** 入局玩家，引用 user.id；一个用户全平台最多一个有效准入。 */
  userId: string;
  /** 目标游戏，引用 game.id。 */
  gameId: string;
  /** 目标难度厅，引用 game_tier.id。 */
  gameTierId: string;
  /** CHAR(36)：准入请求幂等定位值（U）。 */
  entryKey: string;
  /** 解析后的准入和规则配置快照。 */
  rulesSnapshot: Record<string, unknown>;
  /** 匹配成功后的房间，引用 room.id。 */
  roomId: string | null;
  /** 待匹配资格有效期。 */
  expiresAt: Date | string;
  /**
   * 生成列（数据库层只读，非 TS 层 readonly）：TINYINT UNSIGNED GENERATED ALWAYS AS
   * (CASE WHEN status IN (1,2) AND deleted_at IS NULL THEN 1 ELSE NULL END) STORED；
   * 不进 model attributes（A.12 第 6 条）。
   */
  activeMarker: number | null;
}

export type GameEntryModelCreationAttributes = Optional<
  GameEntryModelAttributes,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export class GameEntryModel extends Model<GameEntryModelAttributes, GameEntryModelCreationAttributes> implements GameEntryModelAttributes {
  id!: string;
  status!: number;
  createdAt!: Date | string;
  updatedAt!: Date | string;
  deletedAt!: Date | string | null;
  userId!: string;
  gameId!: string;
  gameTierId!: string;
  entryKey!: string;
  rulesSnapshot!: Record<string, unknown>;
  roomId!: string | null;
  expiresAt!: Date | string;
  /** 生成列，只读（见 interface 注释）。 */
  activeMarker!: number | null;
  static associate(models: {
    GameEntryModel: typeof GameEntryModel;
    GameModel: typeof GameModel;
    GameTierModel: typeof GameTierModel;
  }): void {
    GameEntryModel.belongsTo(models.GameModel, { foreignKey: 'game_id', as: 'game', constraints: false });
    GameEntryModel.belongsTo(models.GameTierModel, {
      foreignKey: 'game_tier_id',
      as: 'gameTier',
      constraints: false,
    });
    // user / room 侧 FK 在 index.ts 跨文件登记。
  }
}

// ---------------------------------------------------------------------------
// 状态/类型常量（本地常量；单一来源在 @gameing/contracts 落地后迁移）
// ---------------------------------------------------------------------------

/** ActiveStatus：行工作状态（多文件共用，单一来源在 contracts 落地后统一）。 */
export const ActiveStatus = { ACTIVE: 1, DISABLED: 2, RETIRED: 3 } as const;
export type ActiveStatusValue = (typeof ActiveStatus)[keyof typeof ActiveStatus];

export const GameIntegrationType = { INTERNAL: 1, EXTERNAL_STUB: 2 } as const;
export type GameIntegrationTypeValue = (typeof GameIntegrationType)[keyof typeof GameIntegrationType];

/** ConfigType：配置值类型（system_config / game_config 共用）。 */
export const ConfigType = { STRING: 1, BOOLEAN: 2, INTEGER: 3, DECIMAL: 4, JSON: 5 } as const;
export type ConfigTypeValue = (typeof ConfigType)[keyof typeof ConfigType];

/** GameEventInstanceStatus：平台活动状态。 */
export const GameEventInstanceStatus = { ACTIVE: 1, ENDED: 2, CANCELLED: 3 } as const;
export type GameEventInstanceStatusValue = (typeof GameEventInstanceStatus)[keyof typeof GameEventInstanceStatus];

export const GameEventScopeType = { GLOBAL: 1, GAME: 2, GAME_TIER: 3 } as const;
export type GameEventScopeTypeValue = (typeof GameEventScopeType)[keyof typeof GameEventScopeType];

export const GameEventSourceActorType = { USER: 1, BOT: 2, SYSTEM: 3 } as const;
export type GameEventSourceActorTypeValue = (typeof GameEventSourceActorType)[keyof typeof GameEventSourceActorType];

export const GameEventEndReasonType = { EXPIRED: 1, POOL_EXHAUSTED: 2, ADMIN_CANCELLED: 3 } as const;
export type GameEventEndReasonTypeValue = (typeof GameEventEndReasonType)[keyof typeof GameEventEndReasonType];

export const RoomStatus = { WAITING: 1, ACTIVE: 2, RECOVERING: 3, CLOSED: 4 } as const;
export type RoomStatusValue = (typeof RoomStatus)[keyof typeof RoomStatus];

export const RoomType = { PRIVATE: 1, MATCHED: 2 } as const;
export type RoomTypeValue = (typeof RoomType)[keyof typeof RoomType];

export const MembershipStatus = { SEATED: 1, LEFT: 2 } as const;
export type MembershipStatusValue = (typeof MembershipStatus)[keyof typeof MembershipStatus];

export const RoundStatus = {
  PREPARING: 1,
  ACTIVE: 2,
  SETTLING: 3,
  SETTLED: 4,
  CANCELLED: 5,
  RECOVERING: 6,
} as const;
export type RoundStatusValue = (typeof RoundStatus)[keyof typeof RoundStatus];

export const RoundPlayerStatus = { ACTIVE: 1, SUBMITTED: 2, SETTLED: 3, ABORTED: 4 } as const;
export type RoundPlayerStatusValue = (typeof RoundPlayerStatus)[keyof typeof RoundPlayerStatus];

export const RoundSubmissionType = { MANUAL: 1, TIMEOUT_AUTO: 2 } as const;
export type RoundSubmissionTypeValue = (typeof RoundSubmissionType)[keyof typeof RoundSubmissionType];

/** RecordStatus：不可变事件行固定 1（本地常量，单一来源在 contracts 落地后统一）。 */
export const RecordStatus = { RECORDED: 1 } as const;
export type RecordStatusValue = (typeof RecordStatus)[keyof typeof RecordStatus];

export const RoundEventType = {
  START: 1,
  SUBMIT: 2,
  INTENT: 3,
  SETTLE: 4,
  RECOVER: 5,
  CANCEL: 6,
} as const;
export type RoundEventTypeValue = (typeof RoundEventType)[keyof typeof RoundEventType];

export const SettlementStatus = { PREPARED: 1, COMMITTED: 2, CANCELLED: 3 } as const;
export type SettlementStatusValue = (typeof SettlementStatus)[keyof typeof SettlementStatus];

export const EntryStatus = { QUEUED: 1, SEATED: 2, FINISHED: 3, CANCELLED: 4, EXPIRED: 5 } as const;
export type EntryStatusValue = (typeof EntryStatus)[keyof typeof EntryStatus];

export function register_GameModel(sequelize: Sequelize): void {
  (GameModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '游戏行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      },
      gameCode: {
        field: 'game_code',
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '稳定游戏代码，如 thirteen',
      },
      name: { type: DataTypes.STRING(64), allowNull: false, comment: '显示名称' },
      integrationType: {
        field: 'integration_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '接入类型：INTERNAL=1/EXTERNAL_STUB=2',
      },
      clientModuleKey: {
        field: 'client_module_key',
        type: DataTypes.STRING(128),
        allowNull: true,
        comment: '前端注册表模块键，不为任意执行 URL',
      },
      assetId: {
        field: 'asset_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '大厅展示封面，引用 asset 表；外键待 0017 补建',
      },
      sortOrder: {
        field: 'sort_order',
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '大厅排序，数值不是状态',
      },
    },

    {
      ...standardTableOptions('game'),
      comment: '大厅游戏目录与外接 Stub',
      sequelize,
    } as unknown as ModelInitOptions<GameModel>,
  );
}

export function register_GameTierModel(sequelize: Sequelize): void {
  (GameTierModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '档位行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      },
      gameId: {
        field: 'game_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '所属游戏，引用 game.id',
      },
      tierCode: {
        field: 'tier_code',
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '游戏内唯一档位代码',
      },
      name: { type: DataTypes.STRING(64), allowNull: false, comment: '档位名称' },
      minCoins: {
        field: 'min_coins',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '准入金币下限',
      },
      maxCoins: {
        field: 'max_coins',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '准入金币上限，NULL 表示无上限',
      },
      sortOrder: {
        field: 'sort_order',
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '档位排序',
      },
    },

    {
      ...standardTableOptions('game_tier'),
      comment: '游戏难度厅及金币准入范围',
      sequelize,
    } as unknown as ModelInitOptions<GameTierModel>,
  );
}

export function register_SystemConfigModel(sequelize: Sequelize): void {
  (SystemConfigModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '配置行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      },
      configKey: {
        field: 'config_key',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '配置键，如 wallet.exchange',
      },
      configType: {
        field: 'config_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '配置值类型，取值见 ConfigType：STRING=1/BOOLEAN=2/INTEGER=3/DECIMAL=4/JSON=5，由对应 parser 安全转换',
      },
      configValue: {
        field: 'config_value',
        type: DataTypes.TEXT,
        allowNull: false,
        comment: '原始字符串；按 config_type 与 config_key 对应的运行时 parser 严格转换',
      },
      description: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: '面向 Admin 的用途及单位说明',
      },
    },

    {
      ...standardTableOptions('system_config'),
      comment: '当前全局配置项',
      sequelize,
    } as unknown as ModelInitOptions<SystemConfigModel>,
  );
}

export function register_GameConfigModel(sequelize: Sequelize): void {
  (GameConfigModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '配置行工作状态，取值见 ActiveStatus：ACTIVE=1/DISABLED=2/RETIRED=3',
      },
      gameId: {
        field: 'game_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '配置所属游戏，引用 game.id',
      },
      gameTierId: {
        field: 'game_tier_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '档位配置引用；全游戏配置为空',
      },
      agentDomainId: {
        field: 'agent_domain_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '配置所属代理域；NULL 表示平台基准配置；外键由 0009 补建',
      },
      scopeType: {
        field: 'scope_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '配置范围：GAME=1/TIER=2',
      },
      configKey: {
        field: 'config_key',
        type: DataTypes.STRING(128),
        allowNull: false,
        comment: '游戏配置键',
      },
      configType: {
        field: 'config_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '配置值类型，取值见 ConfigType：STRING=1/BOOLEAN=2/INTEGER=3/DECIMAL=4/JSON=5，由对应 parser 安全转换',
      },
      configValue: {
        field: 'config_value',
        type: DataTypes.TEXT,
        allowNull: false,
        comment: '按领域 parser 转换的原始字符串',
      },
      description: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: '配置用途与计量单位',
      },
    },

    {
      ...standardTableOptions('game_config'),
      comment: '当前游戏及档位配置项',
      sequelize,
    } as unknown as ModelInitOptions<GameConfigModel>,
  );
}

export function register_GameEventInstanceModel(sequelize: Sequelize): void {
  (GameEventInstanceModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '活动状态，取值见 GameEventInstanceStatus：ACTIVE=1/ENDED=2/CANCELLED=3',
      },
      eventKey: {
        field: 'event_key',
        type: DataTypes.CHAR(36),
        allowNull: false,
        comment: '对外不透明活动 ID，不暴露自增主键',
      },
      triggerKey: {
        field: 'trigger_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '来源事实与触发规则组合出的幂等键',
      },
      eventType: {
        field: 'event_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '注册的平台事件类型常量，取值由共享代码维护',
      },
      agentDomainId: {
        field: 'agent_domain_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '活动域；NULL 表示平台级，非空时仅限此域；外键待 0009 补建',
      },
      audienceScopeType: {
        field: 'audience_scope_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '公告主要展示范围：GLOBAL=1/GAME=2/GAME_TIER=3',
      },
      gameId: {
        field: 'game_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '主要影响游戏；GAME/GAME_TIER 范围必填',
      },
      gameTierId: {
        field: 'game_tier_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '主要影响难度厅；GAME_TIER 范围必填',
      },
      sourceRoundId: {
        field: 'source_round_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '触发活动的牌局，引用 round 表；非牌局来源为空；外键待 0013 补建',
      },
      sourceActorType: {
        field: 'source_actor_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '活动来源角色：USER=1/BOT=2/SYSTEM=3，区分真实来源',
      },
      subjectUserId: {
        field: 'subject_user_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '公告主体，引用 user.id；服务端向该用户及其设备排除本活动',
      },
      stateVersion: {
        field: 'state_version',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 1,
        comment: '活动状态每次变化递增的并发/客户端版本',
      },
      startsAt: {
        field: 'starts_at',
        type: DataTypes.DATE,
        allowNull: false,
        comment: '活动开始时间，UTC',
      },
      expiresAt: {
        field: 'expires_at',
        type: DataTypes.DATE,
        allowNull: false,
        comment: '配置的自然到期时间，UTC',
      },
      endedAt: {
        field: 'ended_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '实际结束时间，奖池耗尽/撤销/自然到期时填写，UTC',
      },
      endReasonType: {
        field: 'end_reason_type',
        type: DataTypes.SMALLINT,
        allowNull: true,
        comment: '结束原因：EXPIRED=1/POOL_EXHAUSTED=2/ADMIN_CANCELLED=3',
      },
      configSnapshot: {
        field: 'config_snapshot',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '创建时生效的触发规则、配置版本和范围快照',
      },
      effectSnapshot: {
        field: 'effect_snapshot',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '有版本的影响档位、概率/派奖变更及目标列表；目标 ID 键遵守引用命名规则',
      },
      runtimeSnapshot: {
        field: 'runtime_snapshot',
        type: DataTypes.JSON,
        allowNull: true,
        comment: '可重建的展示/运行投影，不作为资金账本或概率配置权威',
      },
      announcementSnapshot: {
        field: 'announcement_snapshot',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '已校验的公告模板键、脱敏参数和详情路由快照',
      },
    },

    {
      ...standardTableOptions('game_event_instance'),
      comment: '跨牌局持续的平台活动状态及其安全公告快照',
      sequelize,
    } as unknown as ModelInitOptions<GameEventInstanceModel>,
  );
}

export function register_RoomModel(sequelize: Sequelize): void {
  (RoomModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '房间状态，取值见 RoomStatus：WAITING=1/ACTIVE=2/RECOVERING=3/CLOSED=4',
      },
      gameId: { field: 'game_id', type: DataTypes.BIGINT, allowNull: false, comment: '游戏，引用 game.id' },
      gameTierId: { field: 'game_tier_id', type: DataTypes.BIGINT, allowNull: false, comment: '难度厅，引用 game_tier.id' },
      roomKey: {
        field: 'room_key',
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '公开房号',
      },
      roomType: {
        field: 'room_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '房间类型：PRIVATE=1/MATCHED=2',
      },
      capacity: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '游戏/档位配置的最大玩家数快照',
      },
      rulesSnapshot: {
        field: 'rules_snapshot',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '创建时解析规则快照，发布配置不改当前局',
      },
      version: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 1,
        comment: '房间持久事件版本',
      },
      ownerKey: {
        field: 'owner_key',
        type: DataTypes.STRING(128),
        allowNull: true,
        comment: '当前持有房间的游戏进程实例标识',
      },
      fencingToken: {
        field: 'fencing_token',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 1,
        comment: '每次进程接管递增，拒绝旧进程写入',
      },
      checkpointVersion: {
        field: 'checkpoint_version',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '当前已持久化房间检查点版本',
      },
      closedAt: {
        field: 'closed_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '关闭时间，UTC',
      },
    },

    {
      ...standardTableOptions('room'),
      comment: '房间生命周期、规则快照及当前游戏进程接管栅栏',
      sequelize,
    } as unknown as ModelInitOptions<RoomModel>,
  );
}

export function register_RoomMembershipModel(sequelize: Sequelize): void {
  (RoomMembershipModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '成员状态，取值见 MembershipStatus：SEATED=1/LEFT=2',
      },
      roomId: {
        field: 'room_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '房间，引用 room.id',
      },
      userId: {
        field: 'user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家，引用 user.id；同一用户不能跨房重复入座',
      },
      seatNo: {
        field: 'seat_no',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '座位编号 1 到 4',
      },
      joinedAt: {
        field: 'joined_at',
        type: DataTypes.DATE,
        allowNull: false,
        comment: '入座时间，UTC',
      },
      leftAt: {
        field: 'left_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '离座时间，UTC',
      },
      gameStateCiphertext: {
        field: 'game_state_ciphertext',
        type: DataTypes.BLOB,
        allowNull: true,
        comment: '当前这次房间成员关系的游戏专属累积状态密文；用于可跨 round 恢复的积分进度等，平台不解释其内部字段',
      },
      gameStateVersion: {
        field: 'game_state_version',
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 1,
        comment: '当前成员游戏状态的并发版本；每次成功更新或清空递增，不使用 0',
      },
    },

    {
      ...standardTableOptions('room_membership'),
      comment: '房间座位及用户有效归属',
      sequelize,
    } as unknown as ModelInitOptions<RoomMembershipModel>,
  );
}

export function register_RoundModel(sequelize: Sequelize): void {
  (RoundModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '牌局状态，取值见 RoundStatus：PREPARING=1/ACTIVE=2/SETTLING=3/SETTLED=4/CANCELLED=5/RECOVERING=6',
      },
      roomId: { field: 'room_id', type: DataTypes.BIGINT, allowNull: false, comment: '所属房间，引用 room.id' },
      roundNo: {
        field: 'round_no',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '房间内局号',
      },
      roundKey: {
        field: 'round_key',
        type: DataTypes.CHAR(36),
        allowNull: false,
        comment: '全局牌局业务编号',
      },
      fencingToken: {
        field: 'fencing_token',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '本局所有权版本；关键写入须与 room.fencing_token 一致',
      },
      handlerVersion: {
        field: 'handler_version',
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '创建本局时使用的游戏 handler 版本，保证历史局可回放',
      },
      rulesSnapshot: {
        field: 'rules_snapshot',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '游戏 handler 提供的完整规则快照，平台不解释其内部字段',
      },
      rulesHash: {
        field: 'rules_hash',
        type: binaryDataType(32),
        allowNull: false,
        comment: '规则快照摘要',
      },
      gameStateCiphertext: {
        field: 'game_state_ciphertext',
        type: DataTypes.BLOB,
        allowNull: true,
        comment: 'handler 私有的随机/状态恢复数据，平台不解释内容',
      },
      playingStartedAt: {
        field: 'playing_started_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '本局可交互阶段开始时间，UTC',
      },
      playingDeadlineAt: {
        field: 'playing_deadline_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'handler 规定的本局操作截止时间，UTC',
      },
      settlementInput: {
        field: 'settlement_input',
        type: DataTypes.JSON,
        allowNull: true,
        comment: '已封存的 handler 结算输入与超时结果',
      },
      settlementInputHash: {
        field: 'settlement_input_hash',
        type: binaryDataType(32),
        allowNull: true,
        comment: '不可变结算意图摘要',
      },
      settledAt: {
        field: 'settled_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '资金与战绩提交时间，UTC',
      },
    },

    {
      ...standardTableOptions('round'),
      comment: '一局通用生命周期、handler 版本和恢复输入',
      sequelize,
    } as unknown as ModelInitOptions<RoundModel>,
  );
}

export function register_RoundPlayerModel(sequelize: Sequelize): void {
  (RoundPlayerModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '玩家状态，取值见 RoundPlayerStatus：ACTIVE=1/SUBMITTED=2/SETTLED=3/ABORTED=4',
      },
      roundId: { field: 'round_id', type: DataTypes.BIGINT, allowNull: false, comment: '牌局，引用 round.id' },
      userId: { field: 'user_id', type: DataTypes.BIGINT, allowNull: false, comment: '玩家，引用 user.id' },
      roomMembershipId: {
        field: 'room_membership_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '房间局开局时锁定的成员关系；非房间运行模式为空',
      },
      seatNo: {
        field: 'seat_no',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '本局座次，1 到 4',
      },
      assetHoldId: {
        field: 'asset_hold_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '开局最大赔付金币占款，引用 asset_hold.id；本局内不可变',
      },
      playerStateCiphertext: {
        field: 'player_state_ciphertext',
        type: DataTypes.BLOB,
        allowNull: true,
        comment: 'handler 私有的玩家状态加密数据',
      },
      submissionSnapshot: {
        field: 'submission_snapshot',
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'handler 定义的玩家提交内容，平台不解释内部字段',
      },
      submissionKey: {
        field: 'submission_key',
        type: DataTypes.CHAR(36),
        allowNull: true,
        comment: '提交命令幂等定位值；重复提交返回原结果',
      },
      submissionHash: {
        field: 'submission_hash',
        type: binaryDataType(32),
        allowNull: true,
        comment: '提交内容摘要',
      },
      submittedAt: {
        field: 'submitted_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '成功持久化提交时间，UTC',
      },
      submissionType: {
        field: 'submission_type',
        type: DataTypes.SMALLINT,
        allowNull: true,
        comment: '提交类型：MANUAL=1/TIMEOUT_AUTO=2',
      },
      wagerCoins: {
        field: 'wager_coins',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '本局规则定义的有效下注额，流水计算基数',
      },
      maxLossHoldCoins: {
        field: 'max_loss_hold_coins',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '赔付上限，独立于 wager',
      },
      netCoinDelta: {
        field: 'net_coin_delta',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '实际金币净变化，有符号整数',
      },
    },

    {
      ...standardTableOptions('round_player'),
      comment: '通用牌局参与人、资产风险和结算结果',
      sequelize,
    } as unknown as ModelInitOptions<RoundPlayerModel>,
  );
}

export function register_RoundEventModel(sequelize: Sequelize): void {
  (RoundEventModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '事件状态，固定为 RecordStatus.RECORDED=1，可恢复牌局事件不可改写',
      },
      roundId: { field: 'round_id', type: DataTypes.BIGINT, allowNull: false, comment: '牌局，引用 round.id' },
      roundPlayerId: {
        field: 'round_player_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '涉及某玩家时引用 round_player.id',
      },
      seq: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '局内连续事件序号',
      },
      eventKey: {
        field: 'event_key',
        type: DataTypes.STRING(160),
        allowNull: false,
        comment: '命令或事件幂等语义键',
      },
      eventType: {
        field: 'event_type',
        type: DataTypes.SMALLINT,
        allowNull: false,
        comment: '事件类型：START=1/SUBMIT=2/INTENT=3/SETTLE=4/RECOVER=5/CANCEL=6',
      },
      fencingToken: {
        field: 'fencing_token',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '写入 owner 版本',
      },
      payloadCiphertext: {
        field: 'payload_ciphertext',
        type: DataTypes.BLOB,
        allowNull: false,
        comment: '可恢复事件加密负载',
      },
    },

    {
      ...appendOnlyModelOptions('round_event'),
      hooks: { ...appendOnlyHooks('round_event') },
      comment: '低频可恢复牌局事件',
      sequelize,
    } as unknown as ModelInitOptions<RoundEventModel>,
  );
}

export function register_SettlementModel(sequelize: Sequelize): void {
  (SettlementModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '结算状态，取值见 SettlementStatus：PREPARED=1/COMMITTED=2/CANCELLED=3',
      },
      roundId: {
        field: 'round_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '被结算牌局，引用 round.id；每局至多一条',
      },
      assetOperationId: {
        field: 'asset_operation_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '完成资产操作，引用 asset_operation.id；作废局可为空',
      },
      inputHash: {
        field: 'input_hash',
        type: binaryDataType(32),
        allowNull: false,
        comment: '匹配牌局封存输入',
      },
      resultHash: {
        field: 'result_hash',
        type: binaryDataType(32),
        allowNull: false,
        comment: '最终结果摘要',
      },
      resultSnapshot: {
        field: 'result_snapshot',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '游戏 handler 生成的完整结算结果，含其 schema/version 和展示数据',
      },
      completedAt: {
        field: 'completed_at',
        type: DataTypes.DATE,
        allowNull: true,
        comment: '结算完成时刻，UTC',
      },
    },

    {
      ...standardTableOptions('settlement'),
      comment: '唯一牌局资产结算与战绩',
      sequelize,
    } as unknown as ModelInitOptions<SettlementModel>,
  );
}

export function register_GameEntryModel(sequelize: Sequelize): void {
  (GameEntryModel.init as unknown as ModelInitFn)(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false, comment: '此表主键，对外以十进制字符串表示' },
      status: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 1,
        comment: '入局状态，取值见 EntryStatus：QUEUED=1/SEATED=2/FINISHED=3/CANCELLED=4/EXPIRED=5',
      },
      userId: {
        field: 'user_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '入局玩家，引用 user.id；一个用户全平台最多一个有效准入',
      },
      gameId: {
        field: 'game_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '目标游戏，引用 game.id',
      },
      gameTierId: {
        field: 'game_tier_id',
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '目标难度厅，引用 game_tier.id',
      },
      entryKey: {
        field: 'entry_key',
        type: DataTypes.CHAR(36),
        allowNull: false,
        comment: '准入请求幂等定位值',
      },
      rulesSnapshot: {
        field: 'rules_snapshot',
        type: DataTypes.JSON,
        allowNull: false,
        comment: '解析后的准入和规则配置快照',
      },
      roomId: {
        field: 'room_id',
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '匹配成功后的房间，引用 room.id',
      },
      expiresAt: {
        field: 'expires_at',
        type: DataTypes.DATE,
        allowNull: false,
        comment: '待匹配资格有效期，UTC',
      },
    },

    {
      ...standardTableOptions('game_entry'),
      comment: '游戏准入及当前入局资格',
      sequelize,
    } as unknown as ModelInitOptions<GameEntryModel>,
  );
}
// ---------------------------------------------------------------------------
// 文件级注册器
// ---------------------------------------------------------------------------

export interface GameModels {
  GameModel: typeof GameModel;
  GameTierModel: typeof GameTierModel;
  SystemConfigModel: typeof SystemConfigModel;
  GameConfigModel: typeof GameConfigModel;
  GameEventInstanceModel: typeof GameEventInstanceModel;
  RoomModel: typeof RoomModel;
  RoomMembershipModel: typeof RoomMembershipModel;
  RoundModel: typeof RoundModel;
  RoundPlayerModel: typeof RoundPlayerModel;
  RoundEventModel: typeof RoundEventModel;
  SettlementModel: typeof SettlementModel;
  GameEntryModel: typeof GameEntryModel;
}

/** 定义 12 个 game model（不在此声明跨文件关联）。 */
export function initGame(sequelize: Sequelize, models: GameModels): void {
  register_GameModel(sequelize);
  register_GameTierModel(sequelize);
  register_SystemConfigModel(sequelize);
  register_GameConfigModel(sequelize);
  register_GameEventInstanceModel(sequelize);
  register_RoomModel(sequelize);
  register_RoomMembershipModel(sequelize);
  register_RoundModel(sequelize);
  register_RoundPlayerModel(sequelize);
  register_RoundEventModel(sequelize);
  register_SettlementModel(sequelize);
  register_GameEntryModel(sequelize);
  void models;
}

/** 声明 game 文件内的跨表关联（FK 全部 constraints: false，由迁移管理）。 */
export function associateGame(models: GameModels): void {
  GameModel.associate(models);
  GameTierModel.associate(models);
  SystemConfigModel.associate(models);
  GameConfigModel.associate(models);
  GameEventInstanceModel.associate(models);
  RoomModel.associate(models);
  RoomMembershipModel.associate(models);
  RoundModel.associate(models);
  RoundPlayerModel.associate(models);
  RoundEventModel.associate(models);
  SettlementModel.associate(models);
  GameEntryModel.associate(models);
}
