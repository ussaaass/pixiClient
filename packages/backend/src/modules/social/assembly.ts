/**
 * social 模块装配工厂（inject 全部 ports 的 SocialModule，供 server 装配调用一次）。
 *
 * 领域所有者：social 模块（social 6 表全部用例 + 本地 4 Repo 类注入）。
 * 对应 SDD 章节：后端实施 SDD §1（装配工厂 `createSocialModule({sequelize,
 * outboxPortFactory, config})` 返回注入了全部 ports 的 SocialModule 对象）、
 * §4（构造注入 ports，不用全局；锁顺序/幂等/同事务约定）、§9 实施顺序
 * 第 5 步（社交与客服：好友/私信/社区 + 坐席队列 + 消息 outbox→Socket
 * 双端投递 + 断线补拉）。
 *
 * 装配模式（参考 `modules/rooms/assembly.ts` 同款纪律，简化——不依赖
 * wallet assembly）：
 * - `sequelize`：Sequelize 实例（models 已 addModels 注册，social 9 model
 *   + outbox）；
 * - `outboxPortFactory`：outbox 端口工厂（§6.3 "所有分录/outbox 同事务"，
 *   与 rooms `outboxPortFactory({ transaction })` 同款签名，写
 *   `OutboxModel` 行随事务提交/回滚；topic `social.message` /
 *   `social.post` / `social.post_reply` 经 outbox worker 落地后投
 *   /platform，本模块只写行）；
 * - `config`：时钟注入（测试可传固定时钟；缺省 `SystemClock`）。
 *
 * 未闭环登记（完成报告给 Lead）：
 * - Outbox worker 未建（SDD §8 后续运维项）：topic `social.message` /
 *   `social.post` / `social.post_reply` / `support.message` 投递
 *   /platform 与 /admin 两侧待 §9 第 9 步 + outbox worker 闭环；
 * - 审核/屏蔽/举报/互动 4 表（social_moderation / social_block /
 *   social_report / social_content_interaction）端点归 §9 第 9 步
 *   Admin 模块，本模块不建；
 * - 坐席 Admin audience 中间件归 §9 第 9 步（本模块 support 端点首版
 *   同 player token + role_type 校验）；
 * - 已读回执端点（user_low/high_read_through_no 推进）首版未建，
 *   登记决策点；
 * - 消息补拉单页上限 50 首版固定（可经配置注入，决策点登记）。
 */

import type { Sequelize, Transaction } from 'sequelize';
import { OutboxModel } from '../../infrastructure/database/models/events.js';
import {
  SocialTopicModel,
  SocialPostModel,
  SocialPostReplyModel,
  SocialFriendshipModel,
  SocialConversationModel,
  SocialMessageModel,
} from '../../infrastructure/database/models/social.js';

import {
  SequelizePostRepo,
  SequelizeConversationRepo,
  SequelizeMessageRepo,
  SequelizeFriendshipRepo,
} from './adapters/sequelize-social.js';

import type { PostRepo, ConversationRepo, MessageRepo, FriendshipRepo } from './ports/social-repository.js';

import type { OutboxPort, OutboxAppendInput, Clock } from './ports/social-repository-exports.js';
import { SystemClock } from './ports/social-repository-exports.js';

import { PostCreateUseCase } from './application/post-create.js';
import { PostReplyUseCase } from './application/post-reply.js';
import { ConversationCreateUseCase } from './application/conversation-create.js';
import { MessageSendUseCase } from './application/message-send.js';
import { MessageListUseCase } from './application/message-list.js';
import { FriendshipUseCase } from './application/friendship.js';

/** 装配配置（测试可注入固定时钟；缺省 `SystemClock`）。 */
export interface SocialModuleConfig {
  /** 时钟注入（测试可传固定时钟；缺省 `SystemClock`）。 */
  clock?: Clock;
}

/** outbox 端口工厂签名（与 rooms `outboxPortFactory` 同款；§6.3 同事务写 outbox 行）。 */
export type OutboxPortFactory = (scope: { transaction: Transaction | null }) => OutboxPort;

/** 装配依赖（Sequelize 实例 + outbox 工厂 + 配置；模型类在装配内取）。 */
export interface SocialModuleDeps {
  sequelize: Sequelize;
  outboxPortFactory: OutboxPortFactory;
  config?: SocialModuleConfig;
}

/** 全部 ports + 用例实例的 SocialModule（构造注入，不用全局，SDD §4）。 */
export interface SocialModule {
  // ports（共享实现，供测试/其他模块 mock 时参考）
  postRepo: PostRepo;
  conversationRepo: ConversationRepo;
  messageRepo: MessageRepo;
  friendshipRepo: FriendshipRepo;
  outbox: OutboxPort;
  clock: Clock;

  // 用例（构造注入 ports，不用全局）
  postCreate: PostCreateUseCase;
  postReply: PostReplyUseCase;
  conversationCreate: ConversationCreateUseCase;
  messageSend: MessageSendUseCase;
  messageList: MessageListUseCase;
  friendship: FriendshipUseCase;

  /**
   * 同事务 outbox helper（§6.3 "所有分录/outbox 同事务"）：
   * 用例调用 `outbox.append` 时经 scope.transaction 绑定事务，
   * 随事务提交/回滚。
   */
  withTx<T>(scope: { transaction: Transaction | null }, fn: (outbox: OutboxPort) => T | Promise<T>): Promise<T>;
}

/**
 * 在事务 scope 内构建 outbox port（用例调用 outbox.append 时同事务写 outbox 行，
 * §6.3 "所有分录/outbox 同事务"）。用法（路由层）：
 * `const outbox = await outboxForSocialModule(module, tx)` 后传入用例 run。
 */
export function outboxForSocialModule(module: SocialModule, tx: { transaction: Transaction | null }): Promise<OutboxPort> {
  return module.withTx({ transaction: tx.transaction }, (o) => o);
}

/**
 * 装配 social 模块（inject 全部 ports 的 SocialModule，供 server 装配调用一次）。
 * 与 rooms 模块同款：models 对象一次性构造 + 4 个独立 Repo 类 +
 * outboxPortFactory 同事务 helper。
 */
export function createSocialModule(deps: SocialModuleDeps): SocialModule {
  const { outboxPortFactory, config } = deps;
  const clock: Clock = config?.clock ?? new SystemClock();

  // 模型类（构造注入，不用全局，SDD §4；social 6 model 实际首版用到）
  const models = {
    SocialTopicModel,
    SocialPostModel,
    SocialPostReplyModel,
    SocialFriendshipModel,
    SocialConversationModel,
    SocialMessageModel,
  };

  const postRepo = new SequelizePostRepo(models);
  const conversationRepo = new SequelizeConversationRepo(models);
  const messageRepo = new SequelizeMessageRepo(models);
  const friendshipRepo = new SequelizeFriendshipRepo(models);

  // 默认 outbox（无事务 scope 的兜底实现；用例经 `withTx` 取事务绑定版本）
  const defaultOutbox: OutboxPort = {
    async append(input: OutboxAppendInput): Promise<void> {
      // 兜底：无事务时直接写入（不随事务回滚；仅用于测试/无事务用例）
      await OutboxModel.create({
        eventKey: input.eventKey ?? `${input.topic}:fallback`,
        topic: input.topic,
        userId: input.userId ?? null,
        payload: input.payload,
        payloadVersion: input.payloadVersion ?? 1,
        availableAt: input.availableAt ?? new Date(),
        assetOperationId: input.assetOperationId ?? null,
      } as never);
    },
  };

  const postCreate = new PostCreateUseCase(postRepo, defaultOutbox);
  const postReply = new PostReplyUseCase(postRepo, defaultOutbox);
  const conversationCreate = new ConversationCreateUseCase(conversationRepo);
  const messageSend = new MessageSendUseCase(conversationRepo, messageRepo, defaultOutbox);
  const messageList = new MessageListUseCase(conversationRepo, messageRepo);
  const friendship = new FriendshipUseCase(friendshipRepo);

  const module: SocialModule = {
    postRepo,
    conversationRepo,
    messageRepo,
    friendshipRepo,
    outbox: defaultOutbox,
    clock,
    postCreate,
    postReply,
    conversationCreate,
    messageSend,
    messageList,
    friendship,

    async withTx<T>(scope: { transaction: Transaction | null }, fn: (outbox: OutboxPort) => T | Promise<T>): Promise<T> {
      // 同事务 outbox（§6.3）：把 scope.transaction 传入 outboxPortFactory，
      // 写出的 OutboxModel 行随事务提交/回滚。
      return fn(outboxPortFactory({ transaction: scope.transaction }));
    },
  };

  return module;
}
