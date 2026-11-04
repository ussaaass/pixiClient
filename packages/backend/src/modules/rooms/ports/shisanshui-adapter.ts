/**
 * ShisanshuiAdapterPort 独立端口文件（十三张结算纯函数封装）。
 *
 * 领域所有者：rooms 模块（adapters/shisanshui-adapter.ts 实现，直接调
 * @gameing/shisanshui-rules `settleRound` 纯函数，非 HTTP/外部调用）。
 * 对应 SDD 章节：后端实施 SDD §9 第 4 步（room/round handler 接入
 * `games/shisanshui/server`，结算一次、settlement 唯一入账）、§4
 * （结算纯函数签名 `settleRound(players: PlayerArrangement[],
 * config: ScoringConfig): RoundSettlement`，确定性、无随机/时钟/IO）。
 *
 * 金额 wire 转换：`RoundSettlement.players[].water` 为 number（JS 整数，
 * 金币枚数），结算前经 `domain/round-rules.ts` `waterToBigInt` 转 BigInt
 * 做账本分录（SDD §2 第 2 条 "金额全链路 BigInt 计算"；rules 包 output
 * 为 number 而非 BigInt，backend 在 adapter 边界做跨层转换，注册扩展点）。
 *
 * 决策点登记（Lead 处理）：`@gameing/shisanshui-rules` 需加入
 * `packages/backend/package.json` deps（`workspace:*`），本模块不自行
 * 修改 package.json（任务纪律）。
 */

import type { PlayerArrangement, RoundSettlement, ScoringConfig } from '@gameing/shisanshui-rules';

/**
 * 十三张结算适配器端口（本地包纯函数封装，非 HTTP/外部调用）。
 * 实现（adapters/shisanshui-adapter.ts）直接调 `settleRound` 一行，
 * 接口只封装一次调用，不引入任何 IO 副作用。
 */
export interface ShisanshuiAdapterPort {
  /**
   * 调用 @gameing/shisanshui-rules `settleRound`（纯函数，确定性，
   * 无随机/时钟/IO；输入 4 个 PlayerArrangement + ScoringConfig，
   * 输出 RoundSettlement 含 players[].water 和 pairs[]）。
   */
  settle(players: PlayerArrangement[], config: ScoringConfig): RoundSettlement;
}
