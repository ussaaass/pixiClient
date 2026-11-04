/**
 * outbox worker bootstrap（§6.3 首版进程内 + 租约；装配点）。
 *
 * 领域所有者：outbox worker（apps/server 传输装配层，SDD §1 "worker
 * （outbox 消费、恢复任务）装配在 apps/server/src/bootstrap/"——本文件
 * 随 main.ts 内联装配，未独立 bootstrap/ 目录登记决策点）。
 *
 * 依赖：Sequelize 实例（outbox 表）+ SocketAuthHandles（/platform 命名
 * 空间按 user_id 推送）+ 各模块装配产物（任务处理器注册表）。
 * 挂载条件：sequelize + socketAuth（/platform）均就绪时启动。
 */

import type { Sequelize } from 'sequelize';
import type { Logger } from '../logging/logger.js';
import { OutboxModel } from '@gameing/backend/infrastructure/database/models/events';
import { SequelizeOutboxWorkerRepo } from './adapters/sequelize-outbox-worker.js';
import { createOutboxDispatcher, type OutboxTaskHandler, type SocketNotifPort } from './outbox-dispatcher.js';
import { createOutboxWorker, type OutboxWorkerHandles } from './outbox-worker.js';
import { createPayoutTaskHandler, createTradeExpiryTaskHandler, createReferralRewardTaskHandler } from './outbox-task-handlers.js';
import type { PaymentsModule } from '@gameing/backend/modules/payments/public';
import type { CoinMarketModule } from '@gameing/backend/modules/coin-market/public';
import type { ReferralModule } from '@gameing/backend/modules/referral/public';
import type { WalletModule } from '@gameing/backend/modules/wallet/public';
import type { SocketAuthHandles } from '../../socket/socket-auth.js';

/** 把 SocketAuthHandles 的 user→connections Map 适配为 SocketNotifPort。 */
export function createSocketNotifPort(socketAuth: SocketAuthHandles): SocketNotifPort {
  return {
    async notifyUser(userId, event, payload) {
      // 经 /platform 命名空间向该 user 的全部连接推送（首版进程内 Map；
      // 多实例经 Redis pub/sub 广播扩展登记运维项）。
      const sockets = socketAuth.connectionsByUser.get(userId);
      if (sockets === undefined || sockets.size === 0) return;
      for (const socket of sockets) {
        socket.emit(event, { ...payload, source: 'outbox' });
      }
    },
  };
}

export interface OutboxWorkerBootstrapOptions {
  sequelize: Sequelize;
  socketAuth: SocketAuthHandles;
  logger: Logger;
  /** 任务处理器依赖（各模块装配产物；缺失的模块对应处理器不注册）。 */
  modules?: {
    paymentsModule?: PaymentsModule | undefined;
    coinMarketModule?: CoinMarketModule | undefined;
    referralModule?: ReferralModule | undefined;
    walletModule?: WalletModule | undefined;
  };
  /** worker 标识（缺省 = pid + 时间戳）。 */
  workerId?: string;
}

export interface OutboxWorkerBootstrapResult {
  worker: OutboxWorkerHandles;
}

/**
 * 装配 + 启动 outbox worker（首版进程内 ticker）。
 * 用法（main.ts sequelize 块内）：
 * ```ts
 * const outbox = bootstrapOutboxWorker({ sequelize: sequelizeInstance, socketAuth, logger, modules });
 * ```
 */
export function bootstrapOutboxWorker(options: OutboxWorkerBootstrapOptions): OutboxWorkerBootstrapResult {
  const { socketAuth, logger } = options;
  void options.sequelize; // sequelize 实例经 OutboxModel 静态访问，登记装配纪律
  const workerId = options.workerId ?? `outbox-${process.pid}-${Date.now()}`;
  const repo = new SequelizeOutboxWorkerRepo(OutboxModel);
  const socketNotif = createSocketNotifPort(socketAuth);

  // 任务注册表：仅注册依赖模块均就绪的处理器（缺省跳过，不阻塞启动）。
  const tasks: OutboxTaskHandler[] = [];
  const mod = options.modules ?? {};
  if (mod.paymentsModule !== undefined && mod.walletModule !== undefined) {
    tasks.push(
      createPayoutTaskHandler({
        paymentsModule: mod.paymentsModule,
        logger,
        clock: mod.walletModule.clock,
      }),
    );
  }
  if (mod.coinMarketModule !== undefined && mod.walletModule !== undefined) {
    tasks.push(
      createTradeExpiryTaskHandler({
        coinMarketModule: mod.coinMarketModule,
        logger,
        clock: mod.walletModule.clock,
      }),
    );
  }
  if (mod.referralModule !== undefined && mod.walletModule !== undefined) {
    tasks.push(
      createReferralRewardTaskHandler({
        referralModule: mod.referralModule,
        walletModule: mod.walletModule,
        logger,
        clock: mod.walletModule.clock,
      }),
    );
  }

  const dispatcher = createOutboxDispatcher({
    tasks,
    socketNotif,
    logger,
    workerId,
  });

  const worker = createOutboxWorker({ repo, dispatcher, config: { workerId, logger } });
  worker.start();
  logger.info('outbox worker bootstrap 完成（任务注册表已装载）', {
    workerId,
    taskTopics: tasks.map((t) => t.topic),
  });
  return { worker };
}
