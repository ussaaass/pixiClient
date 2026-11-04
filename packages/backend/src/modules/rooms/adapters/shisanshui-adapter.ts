/**
 * ShisanshuiAdapterPort 实现（直接调 @gameing/shisanshui-rules `settleRound`
 * 纯函数，非 HTTP/外部调用；无 IO 副作用，确定性结算）。
 *
 * 领域所有者：rooms 模块（本地包封装，接口只封装一行调用）。
 * 对应 SDD 章节：后端实施 SDD §9 第 4 步（room/round handler 接入
 * `games/shisanshui/server`，结算一次、settlement 唯一入账）；
 * §4（结算纯函数签名 `settleRound(players: PlayerArrangement[],
 * config: ScoringConfig): RoundSettlement`，确定性、无随机/时钟/IO）。
 *
 * 金额 wire 转换：`RoundSettlement.players[].water` 为 number（JS 整数），
 * 结算前经 `domain/round-rules.ts` `waterToBigInt` 转 BigInt 做账本分录
 * （SDD §2 第 2 条 "金额全链路 BigInt 计算"；rules 包 output 为 number
 * 而非 BigInt，backend 在 adapter 边界做跨层转换，注册扩展点）。
 *
 * 决策点登记（Lead 处理）：`@gameing/shisanshui-rules` 需加入
 * `packages/backend/package.json` deps（`workspace:*`），本模块不自行
 * 修改 package.json（任务纪律）。
 */

import { settleRound } from '@gameing/shisanshui-rules';
import type { PlayerArrangement, RoundSettlement, ScoringConfig } from '@gameing/shisanshui-rules';
import type { ShisanshuiAdapterPort } from '../ports/shisanshui-adapter.js';

/**
 * 十三张结算适配器（本地包纯函数封装，非 HTTP/外部调用）。
 * 实现 `ShisanshuiAdapterPort` 一行：直接调 `settleRound`，
 * 无 IO 副作用，确定性（同输入 → 同输出，断线恢复重放可验证）。
 */
export class ShisanshuiAdapter implements ShisanshuiAdapterPort {
  /**
   * 调用 @gameing/shisanshui-rules `settleRound`（纯函数，确定性）。
   * 输入：4 个 PlayerArrangement（playerId + heldCards + arrangement）
   *  + ScoringConfig（规则快照，从 round.rules_snapshot JSON 读取）。
   * 输出：RoundSettlement（players[].water + pairs[]）。
   */
  settle(players: PlayerArrangement[], config: ScoringConfig): RoundSettlement {
    return settleRound(players, config);
  }
}
