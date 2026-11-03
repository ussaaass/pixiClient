/**
 * 流水门槛判定用例（turnover_state remaining_coins > 0 → 禁止提现/转出）。
 *
 * 领域所有者：wallet 模块（turnover_state 读取与判定；写入唯一路径为
 * gift-grant.ts upsert 与牌局结算扣减——后者 SDD §9 第 4 步房间模块落地）。
 * 对应 SDD 章节：后端实施 SDD §9 第 2 步（钱包闭环验收含"流水门槛"）、
 * §5.4（summary.turnover 段）；双资产文档 §2/§5（"赠币按配置加流水要求，
 * 未完成流水禁止提现及转出"；"完成牌局按有效下注额累计（下注 500 计 500，
 * 赢多少不额外计）"；AGENTS.md 赠币规则同文）。
 *
 * 判定语义（任务硬约定 6）：
 * - 无 turnover_state 行 = 无流水要求 = 放行（`canTransferOrWithdraw = true`）；
 * - remaining_coins > 0 且 status = ACTIVE(1) = 未完成流水，禁止提现/转出金币
 *   （转账 submit 与提现申请原子事务内复核，双资产文档 §5.1 "这项服务端事务
 *   校验不可由前端禁用按钮取代"）；
 * - remaining_coins = 0 或 status = COMPLETE(2)/REVERSED(3) = 放行。
 *
 * 错误码映射（contracts `WalletErrorCode` → 触发条件）：
 * - `TURNOVER_INCOMPLETE`：`assertTransferAllowed` 判定 remaining_coins > 0 且
 *   status = ACTIVE 时抛出（调用方——transfer.ts submit / payments 模块提现
 *   申请——在同一事务捕获后回滚，不冻结余额、不创建 withdrawal，双资产文档
 *   §5.1 "校验失败必须不冻结余额、不创建 withdrawal"）。
 * - `WALLET_STORAGE_UNAVAILABLE`：Sequelize 故障（读流水状态失败）。
 * - 成功 → TurnoverGateResult（无 HTTP 端点；summary.turnover 段与
 *   转账/提现事务内校验共用本判定，§5.4）。
 */

import { TurnoverStatus } from '../../../infrastructure/database/models/wallet.js';
import { checkTurnoverGate } from '../domain/ledger-rules.js';
import { WalletDomainError, W } from '../domain/errors.js';
import type { AssetLedger, Tx, TurnoverState } from '../ports/wallet-repository.js';

/** 流水判定结果（summary.turnover 段 + 转出/提现门禁共用）。 */
export interface TurnoverGateResult {
  /** 仍须完成的有效下注额（十进制字符串 wire；无行 = '0'）。 */
  remainingCoins: string;
  /** false = 未完成流水，禁止提现/转出（双资产文档 §2）。 */
  canTransferOrWithdraw: boolean;
  /** 判定来源（可观测性，供 Admin 排查）。 */
  source: 'no-state' | 'state-row';
}

export class TurnoverGateUseCase {
  constructor(private readonly ledger: AssetLedger) {}

  /** 流水门槛判定（读用例，无锁；调用方在资金事务内复核时传 tx）。 */
  async evaluate(userId: string, tx?: Tx): Promise<TurnoverGateResult> {
    let view: TurnoverState | null;
    let source: TurnoverGateResult['source'];
    try {
      view = await this.ledger.getTurnover(userId, tx);
      source = view === null ? 'no-state' : 'state-row';
    } catch (err) {
      if (err instanceof WalletDomainError) throw err;
      throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, 'turnover state read failed');
    }
    const remaining = view === null ? '0' : view.remainingCoins;
    // 门禁纯函数（domain/ledger-rules.ts；无行 = 无流水要求 = 放行）。
    return {
      remainingCoins: remaining,
      canTransferOrWithdraw: checkTurnoverGate(remaining) || (view !== null && view.canTransferOrWithdraw),
      source,
    };
  }

  /**
   * 转出/提现阶段门禁（事务内调用，双资产文档 §5.1 "最后一步服务端校验"）：
   * remaining > 0 且 status = ACTIVE → 抛 TURNOVER_INCOMPLETE（不冻结余额、
   * 不创建 withdrawal；调用方在同一事务回滚后按 §5.1 弹窗解释剩余流水）。
   */
  async assertTransferAllowed(userId: string, tx: Tx): Promise<void> {
    const result = await this.evaluate(userId, tx);
    if (!result.canTransferOrWithdraw) {
      throw new WalletDomainError(W.TURNOVER_INCOMPLETE, `turnover incomplete: ${result.remainingCoins} coins remaining`);
    }
  }
}

export { TurnoverStatus };
export type { TurnoverState as TurnoverView };
