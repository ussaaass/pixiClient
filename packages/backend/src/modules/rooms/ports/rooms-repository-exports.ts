/**
 * rooms 模块 ports 重导出（跨模块复用 wallet 端口，不重定义；
 * 供 assembly.ts / public.ts / application 用例统一 import 入口）。
 *
 * 领域所有者：rooms 模块（经本文件统一取 wallet ports，不直接跨模块 import
 * 内部文件，保持模块内聚）。
 * 对应 SDD 章节：后端实施 SDD §4（构造注入 ports，不用全局；资产操作经
 * wallet 模块 AssetLedger 端口，rooms 模块不直接查 asset_* 表）、
 * §3.2 实体归属矩阵（wallet owns 7 asset_* 表，rooms owns 7 game 表）。
 */

// wallet 端口（跨模块复用，不重定义）
export type {
  AssetLedger,
  EntryIntent,
  Tx,
  SystemIdentityPort,
  ConfigReader,
  ExchangeRate,
  LedgerPost,
} from '../../wallet/ports/wallet-repository.js';
export { WalletOperationType, WalletEntryType } from '../../wallet/ports/wallet-repository.js';

export type { OutboxPort, OutboxAppendInput } from '../../wallet/ports/outbox-port.js';

export type { Clock } from '../../wallet/ports/clock.js';
export { SystemClock } from '../../wallet/ports/clock.js';

// rooms 本地端口（ShisanshuiAdapterPort）
export type { ShisanshuiAdapterPort } from './shisanshui-adapter.js';

// rooms 本地仓储端口
export type { RoomRepo, RoundRepo, GameEntryRepo, RoundEventRepo, SettlementRepo } from './rooms-repository.js';
