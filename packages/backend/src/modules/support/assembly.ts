/**
 * support 模块装配工厂（inject 全部 ports 的 SupportModule，供 server 装配调用一次）。
 *
 * 领域所有者：support 模块（support 2 表全部用例 + 本地 2 Repo 类注入）。
 * 对应 SDD 章节：后端实施 SDD §1（装配工厂 `createSupportModule({sequelize,
 * outboxPortFactory, config})` 返回注入了全部 ports 的 SupportModule 对象）、
 * §4（构造注入 ports，不用全局；锁顺序/幂等/同事务约定）、§9 实施顺序
 * 第 5 步（社交与客服：坐席队列 + 消息 outbox→Socket 双端投递 + 断线补拉）。
 *
 * 装配模式（参考 `modules/rooms/assembly.ts` + `modules/social/assembly.ts`
 * 同款纪律，简化——不依赖 wallet assembly）：
 * - `sequelize`：Sequelize 实例（models 已 addModels 注册，support 2 model
 *   + outbox）；
 * - `outboxPortFactory`：outbox 端口工厂（§6.3 "所有分录/outbox 同事务"，
 *   与 rooms `outboxPortFactory({ transaction })` 同款签名，写
 *   `OutboxModel` 行随事务提交/回滚；topic `support.message` 经 outbox
 *   worker 落地后投 /platform 与 /admin 两侧，本模块只写行）；
 * - `config`：时钟注入（测试可传固定时钟；缺省 `SystemClock`）。
 *
 * 未闭环登记（完成报告给 Lead）：
 * - Outbox worker 未建（SDD §8 后续运维项）：topic `support.message` 双端
 *   投递 /platform 与 /admin 待 §9 第 9 步 + outbox worker 闭环；
 * - 坐席 Admin audience 中间件归 §9 第 9 步（本模块首版 claim/reply/resolve
 *   同 player token + role_type 校验）；
 * - SYSTEM 通知（sender_type=3）写入端点首版未开放（经 Admin 端点 §9 第 9 步）；
 * - 会话 resolve 是否写 outbox `support.conversation.closed` 行首版暂不写
 *   （登记决策点：坐席端读 conversation 状态即可，若 Lead 要求投 /admin
 *   侧 close 通知需补写）；
 * - support_conversation 第 4 状态值（DDL CHECK IN (1,2,3,4)）待与
 *   §5.9 对齐（models/support.ts 文件头已登记决策点）。
 */

import type { Sequelize, Transaction } from 'sequelize';
import { OutboxModel } from '../../infrastructure/database/models/events.js';
import { SupportConversationModel, SupportMessageModel } from '../../infrastructure/database/models/support.js';

import { SequelizeTicketRepo, SequelizeSupportMessageRepo } from './adapters/sequelize-support.js';

import type { TicketRepo, SupportMessageRepo } from './ports/support-repository.js';

import type { OutboxPort, OutboxAppendInput, Clock } from './ports/support-repository-exports.js';
import { SystemClock } from './ports/support-repository-exports.js';

import { TicketCreateUseCase } from './application/ticket-create.js';
import { TicketListUseCase } from './application/ticket-list.js';
import { TicketClaimUseCase } from './application/ticket-claim.js';
import { TicketReplyUseCase } from './application/ticket-reply.js';
import { TicketResolveUseCase } from './application/ticket-resolve.js';

/** 装配配置（测试可注入固定时钟；缺省 `SystemClock`）。 */
export interface SupportModuleConfig {
  /** 时钟注入（测试可传固定时钟；缺省 `SystemClock`）。 */
  clock?: Clock;
}

/** outbox 端口工厂签名（与 rooms / social `outboxPortFactory` 同款；§6.3 同事务写 outbox 行）。 */
export type OutboxPortFactory = (scope: { transaction: Transaction | null }) => OutboxPort;

/** 装配依赖（Sequelize 实例 + outbox 工厂 + 配置；模型类在装配内取）。 */
export interface SupportModuleDeps {
  sequelize: Sequelize;
  outboxPortFactory: OutboxPortFactory;
  config?: SupportModuleConfig;
}

/** 全部 ports + 用例实例的 SupportModule（构造注入，不用全局，SDD §4）。 */
export interface SupportModule {
  // ports（共享实现，供测试/其他模块 mock 时参考）
  ticketRepo: TicketRepo;
  messageRepo: SupportMessageRepo;
  outbox: OutboxPort;
  clock: Clock;

  // 用例（构造注入 ports，不用全局）
  ticketCreate: TicketCreateUseCase;
  ticketList: TicketListUseCase;
  ticketClaim: TicketClaimUseCase;
  ticketReply: TicketReplyUseCase;
  ticketResolve: TicketResolveUseCase;

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
 * `const outbox = await outboxForSupportModule(module, tx)` 后传入用例 run。
 */
export function outboxForSupportModule(module: SupportModule, tx: { transaction: Transaction | null }): Promise<OutboxPort> {
  return module.withTx({ transaction: tx.transaction }, (o) => o);
}

/**
 * 装配 support 模块（inject 全部 ports 的 SupportModule，供 server 装配调用一次）。
 * 与 rooms / social 模块同款：models 对象一次性构造 + 2 个独立 Repo 类 +
 * outboxPortFactory 同事务 helper。
 */
export function createSupportModule(deps: SupportModuleDeps): SupportModule {
  const { outboxPortFactory, config } = deps;
  const clock: Clock = config?.clock ?? new SystemClock();

  // 模型类（构造注入，不用全局，SDD §4；support 2 model）
  const models = {
    SupportConversationModel,
    SupportMessageModel,
  };

  const ticketRepo = new SequelizeTicketRepo(models);
  const messageRepo = new SequelizeSupportMessageRepo(models);

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

  const ticketCreate = new TicketCreateUseCase(ticketRepo, messageRepo, defaultOutbox);
  const ticketList = new TicketListUseCase(ticketRepo);
  const ticketClaim = new TicketClaimUseCase(ticketRepo);
  const ticketReply = new TicketReplyUseCase(ticketRepo, messageRepo);
  const ticketResolve = new TicketResolveUseCase(ticketRepo);

  const module: SupportModule = {
    ticketRepo,
    messageRepo,
    outbox: defaultOutbox,
    clock,
    ticketCreate,
    ticketList,
    ticketClaim,
    ticketReply,
    ticketResolve,

    async withTx<T>(scope: { transaction: Transaction | null }, fn: (outbox: OutboxPort) => T | Promise<T>): Promise<T> {
      // 同事务 outbox（§6.3）：把 scope.transaction 传入 outboxPortFactory，
      // 写出的 OutboxModel 行随事务提交/回滚。
      return fn(outboxPortFactory({ transaction: scope.transaction }));
    },
  };

  return module;
}
