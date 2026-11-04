/**
 * support 模块用例统一入口（SDD §1 用例层布局：application/ 下各用例类，
 * 经本文件统一 re-export，供 public.ts / assembly.ts 引用）。
 *
 * 领域所有者：support 模块（全部用例类；构造注入 ports，不用全局——SDD §4）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（客服坐席队列：ticket-create /
 * ticket-list / ticket-claim / ticket-reply / ticket-resolve）、§5.4
 * （support 端点）、§4（锁顺序/幂等先抢唯一约束/所有分录/outbox 同事务）。
 *
 * 导出约定（与 social / rooms 模块 application 同款纪律）：
 * - 每个用例类独立文件，跨用例共享经 domain/ 纯函数（不跨用例 import 内部类）；
 * - 用例类构造注入 ports（TicketRepo / SupportMessageRepo / OutboxPort），
 *   不用全局；
 * - wire DTO 十进制字符串 ID，金额/ID 全链路 BigInt 计算（本模块无金额，
 *   仅 ID + 状态数值常量 wire）。
 */

// 用例类（application/；构造注入 ports，不用全局）
export { TicketCreateUseCase, type ConversationCreatedDto } from './ticket-create.js';
export { TicketListUseCase, type ConversationListDto } from './ticket-list.js';
export { TicketClaimUseCase, type ClaimResultDto } from './ticket-claim.js';
export { TicketReplyUseCase, type ReplyResultDto } from './ticket-reply.js';
export { TicketResolveUseCase, type ResolveResultDto } from './ticket-resolve.js';
