/**
 * social 模块用例统一入口（SDD §1 用例层布局：application/ 下各用例类，
 * 经本文件统一 re-export，供 public.ts / assembly.ts 引用）。
 *
 * 领域所有者：social 模块（全部用例类；构造注入 ports，不用全局——SDD §4）。
 * 对应 SDD 章节：后端实施 SDD §9 第 5 步（社交与客服：好友/私信/社区）、
 * §5.4（social 端点：post-create / post-reply / conversation-create /
 * message-send / message-list / friendship initiate/accept/reject）、
 * §4（锁顺序/幂等先抢唯一约束/所有分录/outbox 同事务）。
 *
 * 导出约定（与 rooms 模块 application 同款纪律）：
 * - 每个用例类独立文件，跨用例共享经 domain/ 纯函数（不跨用例 import 内部类）；
 * - 用例类构造注入 ports（PostRepo / ConversationRepo / MessageRepo /
 *   FriendshipRepo / OutboxPort），不用全局；
 * - wire DTO 十进制字符串 ID，金额/ID 全链路 BigInt 计算（本模块无金额，
 *   仅 ID + 序号 BIGINT UNSIGNED 十进制字符串 wire）。
 */

// 用例类（application/；构造注入 ports，不用全局）
export { PostCreateUseCase, type PostCreatedDto } from './post-create.js';
export { PostReplyUseCase, type ReplyCreatedDto } from './post-reply.js';
export { ConversationCreateUseCase, type ConversationCreatedDto } from './conversation-create.js';
export { MessageSendUseCase, type MessageSentDto } from './message-send.js';
export { MessageListUseCase, type MessageListDto } from './message-list.js';
export { FriendshipUseCase, type FriendshipResultDto } from './friendship.js';
