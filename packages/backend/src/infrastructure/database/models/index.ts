/**
 * 中央 model 注册中心（附录 A.12 第 1 条）。
 *
 * 职责：
 * 1. 聚合 11 个 model 文件导出的全部 Model 类（共 63 张表）；
 * 2. `addModels(sequelize)` 统一调用各文件的 `init*` 做 `Model.init`
 *    （各 Model 文件不自行注册 instance，避免循环依赖）；
 * 3. 各文件的 `associate*` 声明同文件内跨表关联；跨文件关联（FK 目标位于
 *    另一文件）在本文件 `associateAll` 内集中补全，一律 `foreignKey` 显式 +
 *    `constraints: false`（FK 约束全部由迁移 DDL 管理，A.12 第 2 条）。
 *
 * 用法（由 apps/server bootstrap 或 backend 用例装配调用）：
 * ```ts
 * import { getSequelize } from '../sequelize.js';
 * import { addModels } from './models/index.js';
 *
 * const sequelize = getSequelize();
 * addModels(sequelize);
 * ```
 *
 * 注意：本注册器只做 `init` + 关联声明，**不**调用 `sequelize.sync()`——
 * 表结构只通过 Umzug 迁移变更（见 `../sequelize.ts` 头注释）。
 */

import type { Model, Sequelize } from 'sequelize';

import { associateIdentity, initIdentity, type IdentityModels } from './identity.js';
import { associateWallet, initWallet, type WalletModels } from './wallet.js';
import { associatePayments, initPayments, type PaymentModels } from './payments.js';
import { associateChain, initChain, type ChainModels } from './chain.js';
import { associateReferral, initReferral, type ReferralModels } from './referral.js';
import { associateSocial, initSocial, type SocialModels } from './social.js';
import { associateSupport, initSupport, type SupportModels } from './support.js';
import { associateAdmin, initAdmin, type AdminModels } from './admin.js';
import { associateGame, initGame, type GameModels } from './game.js';
import { associateEvents, initEvents, type EventModels } from './events.js';
import { associateAssets, initAssets, type AssetModels } from './assets.js';
import { associateCoinMarket, initCoinMarket, type CoinMarketModels } from './coin-market.js';

/** 全部 63 张表的 Model 类映射（11 个文件聚合）。 */
export interface AllModels
  extends
    IdentityModels,
    WalletModels,
    PaymentModels,
    ChainModels,
    ReferralModels,
    SocialModels,
    SupportModels,
    AdminModels,
    GameModels,
    EventModels,
    AssetModels,
    CoinMarketModels {}

function collectClasses(models: AllModels): Array<typeof Model & (new () => Model)> {
  return Object.values(models) as Array<typeof Model & (new () => Model)>;
}

/**
 * 一键注册全部 63 张表的 Model 定义与关联。
 * 调用方应在进程装配阶段调用一次；重复调用会重新 `init` 各 Model 类（Sequelize 允许覆盖注册）。
 */
export function addModels(sequelize: Sequelize): void {
  const models = {} as AllModels;

  // 1. 各文件 init*（按批次依赖顺序注册，被引用表先于引用表）。
  initIdentity(sequelize, models); // 0002 user / 0007 device, recovery_credential, user_security_event
  initWallet(sequelize, models); // 0003-0006 asset_* / 0010 coin_exchange, gift_grant, turnover_state
  initPayments(sequelize, models); // 0010 payment_provider ~ payout_attempt
  initChain(sequelize, models); // 0011 chain_*
  initReferral(sequelize, models); // 0012 referral_*
  initSocial(sequelize, models); // 0014 social_*
  initSupport(sequelize, models); // 0015 support_*
  initAdmin(sequelize, models); // 0009 agent_domain, admin_permission, admin_audit_event, agent_audit_event
  initGame(sequelize, models); // 0008 game*/config/event / 0013 room/round*/settlement/game_entry
  initEvents(sequelize, models); // 0018 outbox
  initAssets(sequelize, models); // 0017 asset, asset_release*, ai_asset_*
  initCoinMarket(sequelize, models); // 0016 coin_market_listing, coin_market_trade

  // 2. 各文件内关联。
  associateIdentity(models);
  associateWallet(models);
  associatePayments(models);
  associateChain(models);
  associateReferral(models);
  associateSocial(models);
  associateSupport(models);
  associateAdmin(models);
  associateGame(models);
  associateEvents(models);
  associateAssets(models);
  associateCoinMarket(models);

  // 3. 跨文件关联补全（FK 目标位于另一文件的引用列）。
  associateAll(models);
}

/** 全部 Model 类（供 `sequelize.addModels(allModels)` 或类型推导使用，A.12 第 1 条）。 */
export function allModels(sequelize: Sequelize): Array<typeof Model & (new () => Model)> {
  const models = {} as AllModels;
  initIdentity(sequelize, models);
  initWallet(sequelize, models);
  initPayments(sequelize, models);
  initChain(sequelize, models);
  initReferral(sequelize, models);
  initSocial(sequelize, models);
  initSupport(sequelize, models);
  initAdmin(sequelize, models);
  initGame(sequelize, models);
  initEvents(sequelize, models);
  initAssets(sequelize, models);
  initCoinMarket(sequelize, models);
  return collectClasses(models);
}

// ---------------------------------------------------------------------------
// 跨文件关联补全（FK 目标 Model 位于另一文件的引用列，全部 constraints: false）
// ---------------------------------------------------------------------------

function associateAll(models: AllModels): void {
  const {
    UserModel,
    DeviceModel,
    UserSecurityEventModel,
    AssetAccountModel,
    AssetOperationModel,
    AssetEntryModel,
    AssetHoldModel,
    CoinExchangeModel,
    GiftGrantModel,
    TurnoverStateModel,
    OrderModel,
    PaymentChannelModel,
    PaymentEventModel,
    ExternalSettlementModel,
    PayoutAccountModel,
    WithdrawalModel,
    PayoutAttemptModel,
    ChainAddressModel,
    ChainDepositEventModel,
    ReferralBindingModel,
    ReferralBindingEventModel,
    ReferralRewardAllocationModel,
    SocialTopicModel,
    SocialFriendshipModel,
    SocialConversationModel,
    SocialContentInteractionModel,
    SocialBlockModel,
    SocialReportModel,
    SupportConversationModel,
    SupportMessageModel,
    AgentDomainModel,
    AdminAuditEventModel,
    AgentAuditEventModel,
    GameModel,
    GameConfigModel,
    GameEventInstanceModel,
    RoomMembershipModel,
    RoundPlayerModel,
    RoundEventModel,
    OutboxModel,
    AssetModel,
    AssetReleaseModel,
    CoinMarketListingModel,
    CoinMarketTradeModel,
  } = models;
  // 仅按名引用的跨文件关联目标（FK 全部 constraints: false）——直接从 models 取值。
  const _GameTierModel = models.GameTierModel;
  const GameEntryModel = models.GameEntryModel;
  const SocialPostModel = models.SocialPostModel;
  const SocialPostReplyModel = models.SocialPostReplyModel;
  const SocialMessageModel = models.SocialMessageModel;
  const SettlementModel = models.SettlementModel;
  const _AssetReleaseItemModel = models.AssetReleaseItemModel;

  // ---- identity 侧 ----
  // user_security_event.device_id 在 0007 批次内已建 RESTRICT 外键，读模型 join 登记。
  UserSecurityEventModel.belongsTo(DeviceModel, {
    foreignKey: 'device_id',
    as: 'device',
    constraints: false,
  });
  UserSecurityEventModel.belongsTo(SupportConversationModel, {
    foreignKey: 'support_conversation_id',
    as: 'supportConversation',
    constraints: false,
  });

  // ---- wallet 侧 ----
  AssetAccountModel.belongsTo(UserModel, { foreignKey: 'user_id', as: 'user', constraints: false });

  AssetOperationModel.belongsTo(UserModel, {
    foreignKey: 'initiated_by_user_id',
    as: 'initiator',
    constraints: false,
  });
  AssetOperationModel.belongsTo(UserModel, {
    foreignKey: 'operated_by_admin_user_id',
    as: 'operator',
    constraints: false,
  });
  AssetOperationModel.belongsTo(UserModel, {
    foreignKey: 'approved_by_admin_user_id',
    as: 'approver',
    constraints: false,
  });

  AssetEntryModel.belongsTo(AssetOperationModel, {
    foreignKey: 'asset_operation_id',
    as: 'assetOperation',
    constraints: false,
  });
  AssetEntryModel.belongsTo(AssetAccountModel, {
    foreignKey: 'asset_account_id',
    as: 'assetAccount',
    constraints: false,
  });
  AssetEntryModel.belongsTo(AssetHoldModel, {
    foreignKey: 'asset_hold_id',
    as: 'assetHold',
    constraints: false,
  });

  AssetHoldModel.belongsTo(AssetAccountModel, {
    foreignKey: 'asset_account_id',
    as: 'assetAccount',
    constraints: false,
  });
  AssetHoldModel.belongsTo(AssetOperationModel, {
    foreignKey: 'asset_operation_id',
    as: 'assetOperation',
    constraints: false,
  });

  CoinExchangeModel.belongsTo(UserModel, { foreignKey: 'user_id', as: 'user', constraints: false });
  CoinExchangeModel.belongsTo(AssetOperationModel, {
    foreignKey: 'asset_operation_id',
    as: 'assetOperation',
    constraints: false,
  });

  GiftGrantModel.belongsTo(UserModel, { foreignKey: 'user_id', as: 'user', constraints: false });
  GiftGrantModel.belongsTo(AssetOperationModel, {
    foreignKey: 'asset_operation_id',
    as: 'assetOperation',
    constraints: false,
  });
  GiftGrantModel.belongsTo(OrderModel, { foreignKey: 'order_id', as: 'order', constraints: false });

  TurnoverStateModel.belongsTo(UserModel, { foreignKey: 'user_id', as: 'user', constraints: false });

  // ---- payments 侧 ----
  OrderModel.belongsTo(UserModel, { foreignKey: 'user_id', as: 'user', constraints: false });
  OrderModel.belongsTo(AssetOperationModel, {
    foreignKey: 'asset_operation_id',
    as: 'assetOperation',
    constraints: false,
  });

  PaymentEventModel.belongsTo(OrderModel, { foreignKey: 'order_id', as: 'order', constraints: false });
  PaymentEventModel.belongsTo(PayoutAttemptModel, {
    foreignKey: 'payout_attempt_id',
    as: 'payoutAttempt',
    constraints: false,
  });

  ExternalSettlementModel.belongsTo(OrderModel, {
    foreignKey: 'order_id',
    as: 'order',
    constraints: false,
  });
  ExternalSettlementModel.belongsTo(PayoutAttemptModel, {
    foreignKey: 'payout_attempt_id',
    as: 'payoutAttempt',
    constraints: false,
  });
  ExternalSettlementModel.belongsTo(AssetOperationModel, {
    foreignKey: 'asset_operation_id',
    as: 'assetOperation',
    constraints: false,
  });

  PayoutAccountModel.belongsTo(UserModel, { foreignKey: 'user_id', as: 'user', constraints: false });

  WithdrawalModel.belongsTo(UserModel, { foreignKey: 'user_id', as: 'user', constraints: false });
  WithdrawalModel.belongsTo(AssetOperationModel, {
    foreignKey: 'asset_operation_id',
    as: 'assetOperation',
    constraints: false,
  });
  WithdrawalModel.belongsTo(AssetHoldModel, {
    foreignKey: 'asset_hold_id',
    as: 'assetHold',
    constraints: false,
  });

  PayoutAttemptModel.belongsTo(WithdrawalModel, {
    foreignKey: 'withdrawal_id',
    as: 'withdrawal',
    constraints: false,
  });

  // ---- chain 侧 ----
  ChainAddressModel.belongsTo(UserModel, { foreignKey: 'user_id', as: 'user', constraints: false });
  ChainAddressModel.belongsTo(OrderModel, { foreignKey: 'order_id', as: 'order', constraints: false });
  ChainDepositEventModel.belongsTo(OrderModel, {
    foreignKey: 'order_id',
    as: 'order',
    constraints: false,
  });

  // ---- referral 侧 ----
  ReferralBindingModel.belongsTo(UserModel, { foreignKey: 'user_id', as: 'user', constraints: false });
  ReferralBindingModel.belongsTo(UserModel, {
    foreignKey: 'parent_1_user_id',
    as: 'parent1User',
    constraints: false,
  });
  ReferralBindingModel.belongsTo(UserModel, {
    foreignKey: 'parent_2_user_id',
    as: 'parent2User',
    constraints: false,
  });
  ReferralBindingModel.belongsTo(UserModel, {
    foreignKey: 'parent_3_user_id',
    as: 'parent3User',
    constraints: false,
  });
  ReferralBindingModel.belongsTo(UserModel, {
    foreignKey: 'parent_4_user_id',
    as: 'parent4User',
    constraints: false,
  });

  ReferralBindingEventModel.belongsTo(UserModel, {
    foreignKey: 'user_id',
    as: 'user',
    constraints: false,
  });
  ReferralBindingEventModel.belongsTo(UserModel, {
    foreignKey: 'previous_parent_1_user_id',
    as: 'previousParent1User',
    constraints: false,
  });
  ReferralBindingEventModel.belongsTo(UserModel, {
    foreignKey: 'new_parent_1_user_id',
    as: 'newParent1User',
    constraints: false,
  });
  ReferralBindingEventModel.belongsTo(UserModel, {
    foreignKey: 'admin_user_id',
    as: 'adminUser',
    constraints: false,
  });

  ReferralRewardAllocationModel.belongsTo(UserModel, {
    foreignKey: 'user_id',
    as: 'user',
    constraints: false,
  });
  ReferralRewardAllocationModel.belongsTo(OrderModel, {
    foreignKey: 'order_id',
    as: 'order',
    constraints: false,
  });
  ReferralRewardAllocationModel.belongsTo(AssetOperationModel, {
    foreignKey: 'asset_operation_id',
    as: 'assetOperation',
    constraints: false,
  });
  ReferralRewardAllocationModel.belongsTo(AssetHoldModel, {
    foreignKey: 'asset_hold_id',
    as: 'assetHold',
    constraints: false,
  });

  // ---- social 侧 ----
  SocialTopicModel.belongsTo(AgentDomainModel, {
    foreignKey: 'agent_domain_id',
    as: 'agentDomain',
    constraints: false,
  });
  SocialTopicModel.belongsTo(AssetModel, {
    foreignKey: 'cover_asset_id',
    as: 'coverAsset',
    constraints: false,
  });

  SocialPostModel.belongsTo(UserModel, { foreignKey: 'user_id', as: 'author', constraints: false });
  SocialPostModel.belongsTo(AgentDomainModel, {
    foreignKey: 'agent_domain_id',
    as: 'agentDomain',
    constraints: false,
  });
  SocialPostModel.belongsTo(UserModel, {
    foreignKey: 'pinned_by_user_id',
    as: 'pinnedByUser',
    constraints: false,
  });
  SocialPostModel.belongsTo(UserModel, {
    foreignKey: 'moderated_by_user_id',
    as: 'moderatedByUser',
    constraints: false,
  });

  SocialPostReplyModel.belongsTo(UserModel, {
    foreignKey: 'user_id',
    as: 'author',
    constraints: false,
  });
  SocialPostReplyModel.belongsTo(UserModel, {
    foreignKey: 'moderated_by_user_id',
    as: 'moderatedByUser',
    constraints: false,
  });

  SocialFriendshipModel.belongsTo(AgentDomainModel, {
    foreignKey: 'agent_domain_id',
    as: 'agentDomain',
    constraints: false,
  });
  SocialFriendshipModel.belongsTo(UserModel, {
    foreignKey: 'low_user_id',
    as: 'lowUser',
    constraints: false,
  });
  SocialFriendshipModel.belongsTo(UserModel, {
    foreignKey: 'high_user_id',
    as: 'highUser',
    constraints: false,
  });
  SocialFriendshipModel.belongsTo(UserModel, {
    foreignKey: 'requester_user_id',
    as: 'requesterUser',
    constraints: false,
  });

  SocialConversationModel.belongsTo(AgentDomainModel, {
    foreignKey: 'agent_domain_id',
    as: 'agentDomain',
    constraints: false,
  });
  SocialConversationModel.belongsTo(UserModel, {
    foreignKey: 'low_user_id',
    as: 'lowUser',
    constraints: false,
  });
  SocialConversationModel.belongsTo(UserModel, {
    foreignKey: 'high_user_id',
    as: 'highUser',
    constraints: false,
  });
  SocialConversationModel.belongsTo(UserModel, {
    foreignKey: 'pending_first_message_user_id',
    as: 'pendingFirstMessageUser',
    constraints: false,
  });

  SocialMessageModel.belongsTo(UserModel, {
    foreignKey: 'sender_user_id',
    as: 'senderUser',
    constraints: false,
  });
  SocialMessageModel.belongsTo(UserModel, {
    foreignKey: 'redacted_by_user_id',
    as: 'redactedByUser',
    constraints: false,
  });
  SocialMessageModel.belongsTo(AssetModel, {
    foreignKey: 'asset_id',
    as: 'asset',
    constraints: false,
  });

  SocialContentInteractionModel.belongsTo(UserModel, {
    foreignKey: 'actor_user_id',
    as: 'actorUser',
    constraints: false,
  });
  SocialContentInteractionModel.belongsTo(models.SocialPostModel, {
    foreignKey: 'social_post_id',
    as: 'socialPost',
    constraints: false,
  });
  SocialContentInteractionModel.belongsTo(models.SocialPostReplyModel, {
    foreignKey: 'social_post_reply_id',
    as: 'socialPostReply',
    constraints: false,
  });
  SocialContentInteractionModel.belongsTo(UserModel, {
    foreignKey: 'target_user_id',
    as: 'targetUser',
    constraints: false,
  });

  SocialBlockModel.belongsTo(AgentDomainModel, {
    foreignKey: 'agent_domain_id',
    as: 'agentDomain',
    constraints: false,
  });
  SocialBlockModel.belongsTo(UserModel, {
    foreignKey: 'blocker_user_id',
    as: 'blockerUser',
    constraints: false,
  });
  SocialBlockModel.belongsTo(UserModel, {
    foreignKey: 'blocked_user_id',
    as: 'blockedUser',
    constraints: false,
  });

  SocialReportModel.belongsTo(AgentDomainModel, {
    foreignKey: 'agent_domain_id',
    as: 'agentDomain',
    constraints: false,
  });
  SocialReportModel.belongsTo(UserModel, {
    foreignKey: 'reporter_user_id',
    as: 'reporterUser',
    constraints: false,
  });
  SocialReportModel.belongsTo(models.SocialPostModel, {
    foreignKey: 'social_post_id',
    as: 'socialPost',
    constraints: false,
  });
  SocialReportModel.belongsTo(models.SocialPostReplyModel, {
    foreignKey: 'social_post_reply_id',
    as: 'socialPostReply',
    constraints: false,
  });
  SocialReportModel.belongsTo(models.SocialMessageModel, {
    foreignKey: 'social_message_id',
    as: 'socialMessage',
    constraints: false,
  });
  SocialReportModel.belongsTo(UserModel, {
    foreignKey: 'reported_user_id',
    as: 'reportedUser',
    constraints: false,
  });
  SocialReportModel.belongsTo(UserModel, {
    foreignKey: 'handled_by_user_id',
    as: 'handledByUser',
    constraints: false,
  });

  // ---- support 侧 ----
  SupportConversationModel.belongsTo(UserModel, {
    foreignKey: 'user_id',
    as: 'user',
    constraints: false,
  });
  SupportConversationModel.belongsTo(UserModel, {
    foreignKey: 'assigned_admin_user_id',
    as: 'assignedAdminUser',
    constraints: false,
  });
  SupportConversationModel.belongsTo(OrderModel, {
    foreignKey: 'order_id',
    as: 'order',
    constraints: false,
  });
  SupportConversationModel.belongsTo(WithdrawalModel, {
    foreignKey: 'withdrawal_id',
    as: 'withdrawal',
    constraints: false,
  });

  SupportMessageModel.belongsTo(UserModel, {
    foreignKey: 'sender_user_id',
    as: 'senderUser',
    constraints: false,
  });
  SupportMessageModel.belongsTo(UserModel, {
    foreignKey: 'redacted_by_user_id',
    as: 'redactedByUser',
    constraints: false,
  });
  SupportMessageModel.belongsTo(AssetModel, {
    foreignKey: 'asset_id',
    as: 'asset',
    constraints: false,
  });

  // ---- admin 侧 ----
  AgentDomainModel.belongsTo(UserModel, { foreignKey: 'user_id', as: 'user', constraints: false });

  AdminAuditEventModel.belongsTo(UserModel, {
    foreignKey: 'admin_user_id',
    as: 'adminUser',
    constraints: false,
  });
  AdminAuditEventModel.belongsTo(UserModel, {
    foreignKey: 'user_id',
    as: 'player',
    constraints: false,
  });
  AdminAuditEventModel.belongsTo(UserModel, {
    foreignKey: 'target_admin_user_id',
    as: 'targetAdminUser',
    constraints: false,
  });
  AdminAuditEventModel.belongsTo(AssetOperationModel, {
    foreignKey: 'asset_operation_id',
    as: 'assetOperation',
    constraints: false,
  });
  AdminAuditEventModel.belongsTo(WithdrawalModel, {
    foreignKey: 'withdrawal_id',
    as: 'withdrawal',
    constraints: false,
  });
  AdminAuditEventModel.belongsTo(models.SystemConfigModel, {
    foreignKey: 'system_config_id',
    as: 'systemConfig',
    constraints: false,
  });
  AdminAuditEventModel.belongsTo(GameConfigModel, {
    foreignKey: 'game_config_id',
    as: 'gameConfig',
    constraints: false,
  });
  AdminAuditEventModel.belongsTo(AgentDomainModel, {
    foreignKey: 'agent_domain_id',
    as: 'agentDomain',
    constraints: false,
  });
  AdminAuditEventModel.belongsTo(ReferralBindingEventModel, {
    foreignKey: 'referral_binding_event_id',
    as: 'referralBindingEvent',
    constraints: false,
  });
  AdminAuditEventModel.belongsTo(SupportConversationModel, {
    foreignKey: 'support_conversation_id',
    as: 'supportConversation',
    constraints: false,
  });

  AgentAuditEventModel.belongsTo(UserModel, {
    foreignKey: 'user_id',
    as: 'user',
    constraints: false,
  });

  // ---- game 侧 ----
  GameModel.belongsTo(AssetModel, { foreignKey: 'asset_id', as: 'asset', constraints: false });

  GameConfigModel.belongsTo(AgentDomainModel, {
    foreignKey: 'agent_domain_id',
    as: 'agentDomain',
    constraints: false,
  });

  GameEventInstanceModel.belongsTo(AgentDomainModel, {
    foreignKey: 'agent_domain_id',
    as: 'agentDomain',
    constraints: false,
  });
  GameEventInstanceModel.belongsTo(UserModel, {
    foreignKey: 'subject_user_id',
    as: 'subjectUser',
    constraints: false,
  });
  GameEventInstanceModel.belongsTo(models.RoomModel, {
    foreignKey: 'source_round_id',
    as: 'sourceRound',
    constraints: false,
  });

  RoomMembershipModel.belongsTo(UserModel, {
    foreignKey: 'user_id',
    as: 'user',
    constraints: false,
  });

  RoundPlayerModel.belongsTo(UserModel, { foreignKey: 'user_id', as: 'user', constraints: false });
  RoundPlayerModel.belongsTo(RoomMembershipModel, {
    foreignKey: 'room_membership_id',
    as: 'roomMembership',
    constraints: false,
  });
  RoundPlayerModel.belongsTo(AssetHoldModel, {
    foreignKey: 'asset_hold_id',
    as: 'assetHold',
    constraints: false,
  });

  RoundEventModel.belongsTo(RoundPlayerModel, {
    foreignKey: 'round_player_id',
    as: 'roundPlayer',
    constraints: false,
  });

  SettlementModel.belongsTo(AssetOperationModel, {
    foreignKey: 'asset_operation_id',
    as: 'assetOperation',
    constraints: false,
  });

  GameEntryModel.belongsTo(UserModel, { foreignKey: 'user_id', as: 'user', constraints: false });
  GameEntryModel.belongsTo(models.RoomModel, { foreignKey: 'room_id', as: 'room', constraints: false });

  // ---- events 侧 ----
  OutboxModel.belongsTo(UserModel, { foreignKey: 'user_id', as: 'user', constraints: false });
  OutboxModel.belongsTo(AssetOperationModel, {
    foreignKey: 'asset_operation_id',
    as: 'assetOperation',
    constraints: false,
  });
  OutboxModel.belongsTo(models.RoundModel, {
    foreignKey: 'round_id',
    as: 'round',
    constraints: false,
  });

  // ---- assets 侧 ----
  AssetReleaseModel.belongsTo(GameModel, { foreignKey: 'game_id', as: 'game', constraints: false });

  // ---- coin-market 侧（A.11；0016）----
  CoinMarketListingModel.belongsTo(UserModel, {
    foreignKey: 'seller_user_id',
    as: 'sellerUser',
    constraints: false,
  });
  CoinMarketListingModel.belongsTo(UserModel, {
    foreignKey: 'suspended_by_user_id',
    as: 'suspendedByUser',
    constraints: false,
  });
  CoinMarketListingModel.belongsTo(AssetHoldModel, {
    foreignKey: 'asset_hold_id',
    as: 'assetHold',
    constraints: false,
  });

  CoinMarketTradeModel.belongsTo(CoinMarketListingModel, {
    foreignKey: 'coin_market_listing_id',
    as: 'coinMarketListing',
    constraints: false,
  });
  CoinMarketTradeModel.belongsTo(UserModel, {
    foreignKey: 'buyer_user_id',
    as: 'buyerUser',
    constraints: false,
  });
  CoinMarketTradeModel.belongsTo(UserModel, {
    foreignKey: 'adjudicated_by_user_id',
    as: 'adjudicatedByUser',
    constraints: false,
  });
  CoinMarketTradeModel.belongsTo(PaymentChannelModel, {
    foreignKey: 'payment_channel_id',
    as: 'paymentChannel',
    constraints: false,
  });
  CoinMarketTradeModel.belongsTo(SupportConversationModel, {
    foreignKey: 'support_conversation_id',
    as: 'supportConversation',
    constraints: false,
  });
  CoinMarketTradeModel.belongsTo(AssetOperationModel, {
    foreignKey: 'asset_operation_id',
    as: 'assetOperation',
    constraints: false,
  });
  // 凭证/证据资产列（外键 0017 补建）
  CoinMarketTradeModel.belongsTo(AssetModel, {
    foreignKey: 'payment_proof_asset_id',
    as: 'paymentProofAsset',
    constraints: false,
  });
  CoinMarketTradeModel.belongsTo(AssetModel, {
    foreignKey: 'buyer_evidence_asset_id',
    as: 'buyerEvidenceAsset',
    constraints: false,
  });
  CoinMarketTradeModel.belongsTo(AssetModel, {
    foreignKey: 'seller_evidence_asset_id',
    as: 'sellerEvidenceAsset',
    constraints: false,
  });

  // 0016 补建 FK（0010 已建列）：payment_event / external_settlement 引用 coin_market_trade
  PaymentEventModel.belongsTo(CoinMarketTradeModel, {
    foreignKey: 'coin_market_trade_id',
    as: 'coinMarketTrade',
    constraints: false,
  });
  ExternalSettlementModel.belongsTo(CoinMarketTradeModel, {
    foreignKey: 'coin_market_trade_id',
    as: 'coinMarketTrade',
    constraints: false,
  });

  // 0016 补建 FK（0009 已建列）：admin_audit_event 引用 coin_market_trade /
  // referral_binding_event / support_conversation
  AdminAuditEventModel.belongsTo(CoinMarketTradeModel, {
    foreignKey: 'coin_market_trade_id',
    as: 'coinMarketTrade',
    constraints: false,
  });
}
