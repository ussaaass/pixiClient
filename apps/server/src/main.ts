import { createApp, type ReadinessCheck } from './app.js';
import { probeMysql } from './infrastructure/database/mysql-probe.js';
import { probeRedis } from './infrastructure/redis/redis-probe.js';
import { createLogger } from './infrastructure/logging/logger.js';
import { getSequelize } from './infrastructure/database/sequelize.js';
import { getRedis, closeRedis } from '@gameing/backend/infrastructure/redis';
import { addModels } from '@gameing/backend/infrastructure/database/models';
import { createIdentityModule } from '@gameing/backend/modules/identity/public';
import { createWalletModule } from '@gameing/backend/modules/wallet/public';
import { createPaymentsModule } from '@gameing/backend/modules/payments/public';
import { createRoomsModule } from '@gameing/backend/modules/rooms/public';
import { createSocialModule } from '@gameing/backend/modules/social/public';
import { createSupportModule } from '@gameing/backend/modules/support/public';
import { createReferralModule } from '@gameing/backend/modules/referral/public';
import { createPlatformEventsModule } from '@gameing/backend/modules/platform-events/public';
import { createCoinMarketModule } from '@gameing/backend/modules/coin-market/public';
import { createAiAssetsModule } from '@gameing/backend/modules/ai-assets/public';
import { createAdminModule } from '@gameing/backend/modules/admin/public';
import { createSocketAuthServer } from './socket/socket-auth.js';
import { OutboxModel } from '@gameing/backend/infrastructure/database/models/events';
import type { OutboxAppendInput } from '@gameing/backend/modules/social/public';
import type { Sequelize } from 'sequelize';

/**
 * 服务进程入口。
 *
 * 负责：读取配置、装配应用、启动监听、注册优雅关闭。
 * 业务逻辑一律在 app/与 domain 层，本文件不包含领域规则。
 */

function readPort(): number {
  const raw = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(raw) || raw <= 0 || raw > 65535) {
    throw new Error(`PORT 非法：${process.env.PORT ?? ''}`);
  }
  return raw;
}

/**
 * 就绪探针依赖。
 *
 * P1 阶段登记 MySQL 与 Redis 两个探针：
 * - `mysql`：通过进程内唯一 Sequelize 实例执行 `authenticate`，凭证缺失时
 *   报 "credentials missing" 而不是抛异常中断探针。
 * - `redis`：当前仅做 TCP 可达性检查（Redis 尚未接入服务端依赖）；接入
 *   ioredis 后扩展为 `PING` 校验，契约保持不变。
 *
 * 探针返回 null 表示就绪；返回字符串表示未就绪的安全原因（不含密码等敏感信息）。
 * 任一探针未就绪时，`/health/ready` 返回 503 + `SERVICE_UNAVAILABLE`。
 *
 * 注意：探针未就绪不会阻止服务启动（`/health/live` 仍返回 200），
 * 只影响 `/health/ready` 与容器编排的就绪判定。
 */
const readinessChecks: ReadinessCheck[] = [
  { name: 'mysql', probe: probeMysql },
  { name: 'redis', probe: () => probeRedis() },
];

const logger = createLogger({
  level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
  base: { service: 'gameing-hall-api' },
});

const port = readPort();

// --- identity 模块装配（Redis 会话 + JWT ES256） ---
// Sequelize 实例 + addModels（注册全部 63 张表的 Model 定义，含 identity 四表 + outbox）
// 在装配前完成；Redis 连接 lazyConnect=true（首用才握手），纯读路由阶段不影响。
let identityModule;
let sequelizeInstance: Sequelize | undefined;
try {
  sequelizeInstance = getSequelize();
  addModels(sequelizeInstance);
  const redis = getRedis();
  identityModule = await createIdentityModule({
    sequelize: sequelizeInstance,
    redis,
    config: {
      issuer: 'gameing-hall-api',
      audiences: ['player'],
      accessTtlSeconds: 600,
      kid: 'identity-dev',
    },
  });
  await identityModule.init();
  logger.info('identity 模块装配完成', { issuer: 'gameing-hall-api' });
} catch (error) {
  logger.warn('identity 模块装配失败（auth 路由不挂载；MySQL/Redis 未配置或连接失败）', {
    errorCode: error instanceof Error ? error.name : 'UnknownError',
  });
  identityModule = undefined;
}

// --- wallet 模块装配（资金用例；需 identity 模块就绪） ---
// systemUserId 通过 env var 注入（SYSTEM 行 user.id，首版由 bootstrap 脚本解析，
// 未设置时 wallet 路由不挂载，不影响 identity 路由可用）。
let walletModule;
if (identityModule && sequelizeInstance) {
  try {
    const systemUserId = process.env.SYSTEM_USER_ID ?? '';
    if (!systemUserId) {
      logger.warn('SYSTEM_USER_ID env 未设置，wallet 路由不挂载（资金端点不可用）');
    } else {
      walletModule = createWalletModule({
        sequelize: sequelizeInstance,
        config: { systemUserId },
      });
      logger.info('wallet 模块装配完成', { systemUserId });
    }
  } catch (error) {
    logger.warn('wallet 模块装配失败（wallet 路由不挂载）', {
      errorCode: error instanceof Error ? error.name : 'UnknownError',
    });
    walletModule = undefined;
  }
}

// --- payments 模块装配（资金用例；需 wallet 模块就绪 + sequelize） ---
// 与 wallet 模块共用 systemUserId；wallet 未装配时 payments 不挂载。
let paymentsModule;
if (walletModule && sequelizeInstance) {
  try {
    paymentsModule = createPaymentsModule({
      sequelize: sequelizeInstance,
      walletModule,
      config: {},
    });
    logger.info('payments 模块装配完成');
  } catch (error) {
    logger.warn('payments 模块装配失败（payments 路由不挂载）', {
      errorCode: error instanceof Error ? error.name : 'UnknownError',
    });
    paymentsModule = undefined;
  }
}

// --- rooms 模块装配（需 wallet 模块就绪 + sequelize；占款经 walletModule.ledger） ---
let roomsModule;
if (walletModule && sequelizeInstance) {
  try {
    roomsModule = createRoomsModule({
      sequelize: sequelizeInstance,
      walletModule,
      config: {},
    });
    logger.info('rooms 模块装配完成');
  } catch (error) {
    logger.warn('rooms 模块装配失败（rooms 路由不挂载）', {
      errorCode: error instanceof Error ? error.name : 'UnknownError',
    });
    roomsModule = undefined;
  }
}

// --- social 模块装配（需 sequelize；社交无资金操作，不依赖 wallet） ---
let socialModule;
if (sequelizeInstance) {
  try {
    socialModule = createSocialModule({
      sequelize: sequelizeInstance,
      outboxPortFactory: ({ transaction }) => ({
        async append(input: OutboxAppendInput) {
          await OutboxModel.create(
            {
              eventKey: input.eventKey ?? `social:${input.topic}:${Date.now()}`,
              topic: input.topic,
              userId: input.userId ?? null,
              payload: input.payload,
              payloadVersion: input.payloadVersion ?? 1,
              availableAt: input.availableAt ?? new Date(),
              assetOperationId: input.assetOperationId ?? null,
            } as never,
            { transaction: transaction ?? undefined } as never,
          );
        },
      }),
      config: {},
    });
    logger.info('social 模块装配完成');
  } catch (error) {
    logger.warn('social 模块装配失败（social 路由不挂载）', {
      errorCode: error instanceof Error ? error.name : 'UnknownError',
    });
    socialModule = undefined;
  }
}

// --- support 模块装配（需 sequelize；客服无资金操作，不依赖 wallet） ---
let supportModule;
if (sequelizeInstance) {
  try {
    supportModule = createSupportModule({
      sequelize: sequelizeInstance,
      outboxPortFactory: ({ transaction }) => ({
        async append(input: OutboxAppendInput) {
          await OutboxModel.create(
            {
              eventKey: input.eventKey ?? `support:${input.topic}:${Date.now()}`,
              topic: input.topic,
              userId: input.userId ?? null,
              payload: input.payload,
              payloadVersion: input.payloadVersion ?? 1,
              availableAt: input.availableAt ?? new Date(),
              assetOperationId: input.assetOperationId ?? null,
            } as never,
            { transaction: transaction ?? undefined } as never,
          );
        },
      }),
      config: {},
    });
    logger.info('support 模块装配完成');
  } catch (error) {
    logger.warn('support 模块装配失败（support 路由不挂载）', {
      errorCode: error instanceof Error ? error.name : 'UnknownError',
    });
    supportModule = undefined;
  }
}

// --- referral 模块装配（需 sequelize；归因无资金操作，不依赖 wallet） ---
let referralModule;
if (sequelizeInstance) {
  try {
    referralModule = createReferralModule({
      sequelize: sequelizeInstance,
      config: {},
    });
    logger.info('referral 模块装配完成');
  } catch (error) {
    logger.warn('referral 模块装配失败（referral 路由不挂载）', {
      errorCode: error instanceof Error ? error.name : 'UnknownError',
    });
    referralModule = undefined;
  }
}

// --- platform-events 模块装配（需 sequelize；公告读路径无资金操作，不依赖 wallet） ---
let platformEventsModule;
if (sequelizeInstance) {
  try {
    platformEventsModule = createPlatformEventsModule({
      sequelize: sequelizeInstance,
      config: {},
    });
    logger.info('platform-events 模块装配完成');
  } catch (error) {
    logger.warn('platform-events 模块装配失败（platform-events 路由不挂载）', {
      errorCode: error instanceof Error ? error.name : 'UnknownError',
    });
    platformEventsModule = undefined;
  }
}

// --- coin-market 模块装配（需 wallet 模块就绪 + sequelize；挂牌占款 / 成交确认 / 取消释放经 wallet ledger） ---
let coinMarketModule;
if (walletModule && sequelizeInstance) {
  try {
    coinMarketModule = createCoinMarketModule({
      sequelize: sequelizeInstance,
      walletModule,
      config: {},
    });
    logger.info('coin-market 模块装配完成');
  } catch (error) {
    logger.warn('coin-market 模块装配失败（coin-market 路由不挂载）', {
      errorCode: error instanceof Error ? error.name : 'UnknownError',
    });
    coinMarketModule = undefined;
  }
}

// --- ai-assets 模块装配（需 sequelize；AI 素材台账无资金操作，不依赖 wallet） ---
let aiAssetsModule;
if (sequelizeInstance) {
  try {
    aiAssetsModule = createAiAssetsModule({
      sequelize: sequelizeInstance,
      config: {},
    });
    logger.info('ai-assets 模块装配完成');
  } catch (error) {
    logger.warn('ai-assets 模块装配失败（ai-assets 路由不挂载）', {
      errorCode: error instanceof Error ? error.name : 'UnknownError',
    });
    aiAssetsModule = undefined;
  }
}

// --- admin 模块装配（需 sequelize；审计/审批无资金操作，不依赖 wallet；
//     出账经 payout worker 闭环，登记决策点） ---
let adminModule;
if (sequelizeInstance) {
  try {
    adminModule = createAdminModule({
      sequelize: sequelizeInstance,
      config: {},
    });
    logger.info('admin 模块装配完成');
  } catch (error) {
    logger.warn('admin 模块装配失败（/admin-api/v1 路由不挂载）', {
      errorCode: error instanceof Error ? error.name : 'UnknownError',
    });
    adminModule = undefined;
  }
}

const identityModuleOpt = identityModule ?? undefined;
const walletModuleOpt = walletModule ?? undefined;
const paymentsModuleOpt = paymentsModule ?? undefined;
const roomsModuleOpt = roomsModule ?? undefined;
const socialModuleOpt = socialModule ?? undefined;
const supportModuleOpt = supportModule ?? undefined;
const referralModuleOpt = referralModule ?? undefined;
const platformEventsModuleOpt = platformEventsModule ?? undefined;
const coinMarketModuleOpt = coinMarketModule ?? undefined;
const aiAssetsModuleOpt = aiAssetsModule ?? undefined;
const adminModuleOpt = adminModule ?? undefined;
const sequelizeOpt = sequelizeInstance ?? undefined;
const app = createApp({
  logger,
  readinessChecks,
  ...(identityModuleOpt ? { identityModule: identityModuleOpt } : {}),
  ...(walletModuleOpt && sequelizeOpt ? { walletModule: walletModuleOpt, sequelize: sequelizeOpt } : {}),
  ...(paymentsModuleOpt && identityModuleOpt && sequelizeOpt ? { paymentsModule: paymentsModuleOpt } : {}),
  ...(roomsModuleOpt && identityModuleOpt && sequelizeOpt ? { roomsModule: roomsModuleOpt } : {}),
  ...(socialModuleOpt && identityModuleOpt && sequelizeOpt ? { socialModule: socialModuleOpt } : {}),
  ...(supportModuleOpt && identityModuleOpt && sequelizeOpt ? { supportModule: supportModuleOpt } : {}),
  ...(referralModuleOpt && identityModuleOpt && sequelizeOpt ? { referralModule: referralModuleOpt } : {}),
  ...(platformEventsModuleOpt && identityModuleOpt && sequelizeOpt ? { platformEventsModule: platformEventsModuleOpt } : {}),
  ...(coinMarketModuleOpt && identityModuleOpt && walletModuleOpt && sequelizeOpt ? { coinMarketModule: coinMarketModuleOpt } : {}),
  ...(aiAssetsModuleOpt && identityModuleOpt && sequelizeOpt ? { aiAssetsModule: aiAssetsModuleOpt } : {}),
  ...(adminModuleOpt && identityModuleOpt && sequelizeOpt ? { adminModule: adminModuleOpt } : {}),
});
const server = app.listen(port, '0.0.0.0', () => {
  logger.info('服务已启动', { port });
});

// --- Socket.IO 握手鉴权基座（SDD §6.1 /platform 命名空间） ---
// identity 模块装配成功时才挂载（MySQL/Redis 缺失时降级：Socket 不挂）。
let socketAuth: ReturnType<typeof createSocketAuthServer> | undefined;
if (identityModuleOpt) {
  socketAuth = createSocketAuthServer(server, {
    module: identityModuleOpt,
    logger,
    namespace: '/platform',
  });
  logger.info('Socket.IO /platform 命名空间已挂载', { port });
}

async function shutdown(signal: string): Promise<void> {
  logger.info('收到关闭信号，开始优雅关闭', { signal });
  server.close(async (error) => {
    if (error) {
      logger.error('关闭时发生错误', { errorCode: error.name, cause: error.stack });
      process.exit(1);
      return;
    }
    // 关闭 Socket.IO（先断开所有连接）
    try {
      socketAuth?.io.close();
    } catch {
      /* socket 未初始化则跳过 */
    }
    // 关闭 Redis + Sequelize（身份会话 + 数据库连接池）
    try {
      await closeRedis();
    } catch {
      /* Redis 未初始化则跳过 */
    }
    const { closeSequelize } = await import('./infrastructure/database/sequelize.js');
    await closeSequelize();
    logger.info('服务已关闭');
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// 未捕获异常与未处理 rejection 必须落到日志再退出，不能让进程静默挂起。
process.on('uncaughtException', (error) => {
  logger.error('未捕获异常', { errorCode: error.name, cause: error.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise rejection', {
    errorCode: reason instanceof Error ? reason.name : 'UnknownError',
    cause: reason instanceof Error ? reason.stack : String(reason),
  });
  process.exit(1);
});
