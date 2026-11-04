/**
 * social 模块 ports 重导出（跨模块复用 wallet 端口，不重定义；
 * 供 assembly.ts / public.ts / application 用例统一 import 入口）。
 *
 * 领域所有者：social 模块（经本文件统一取 wallet ports，不直接跨模块 import
 * 内部文件，保持模块内聚）。
 * 对应 SDD 章节：后端实施 SDD §4（构造注入 ports，不用全局；social 模块
 * 不触 AssetLedger，仅复用 Tx / Clock / OutboxPort 接口契约）、§9 第 5 步
 * （社交与客服：好友/私信/社区 + 消息 outbox→Socket 双端投递）。
 */

// wallet 端口（跨模块复用，不重定义；social 模块只用 Tx / Clock / OutboxPort）
export type { Tx } from '../../wallet/ports/wallet-repository.js';

export type { OutboxPort, OutboxAppendInput } from '../../wallet/ports/outbox-port.js';

export type { Clock } from '../../wallet/ports/clock.js';
export { SystemClock } from '../../wallet/ports/clock.js';

// social 本地仓储端口
export type { PostRepo, ConversationRepo, MessageRepo, FriendshipRepo } from './social-repository.js';
