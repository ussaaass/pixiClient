/**
 * GET /me/wallet/summary 用例（双资产汇总 + 流水判定 + 欢迎赠币快照）。
 *
 * 领域所有者：wallet 模块（auth wallet.summary）。
 * 对应 SDD 章节：后端实施 SDD §5.4（me/wallet/summary，契约已有 handler 新实现）、
 * §4（读用例无事务/锁，纯只读）；双资产文档 §2（独立账本，金币/CNY 两行）。
 *
 * 错误码映射（contracts `WalletErrorCode` → 触发条件）：
 * - `WALLET_STORAGE_UNAVAILABLE`：Sequelize 故障 / 玩家账户行未开户
 *   （开户由注册 workflow 完成，本用例不建账户；缺行 = 上游状态缺口，
 *   以存储不可用暴露而非静默零值，决策点登记）。
 * - 成功 → WalletSummaryResponseDto（200）。
 *
 * wire 约定（SDD §2 第 2 条）：amount/frozen/available/version 全十进制字符串；
 * turnover 段由 turnover_state 判定（无行 = 无流水要求 = remaining '0' 可转可提）；
 * welcomeGift 段读 gift_grant（按账号一次；无赠币行 = null，§4 "注册 workflow
 * 幂等调用新用户赠币"，赠币落地前新用户此段为 null，正常）。
 */

import type { WalletSummaryResponseDto } from '@gameing/contracts/wallet';
import type { AssetLedger, WalletContext, Tx } from '../ports/wallet-repository.js';
import { toWalletSummary } from '../adapters/row-mappers.js';
import { WalletDomainError, W } from '../domain/errors.js';

export class WalletSummaryUseCase {
  constructor(private readonly ledger: AssetLedger) {}

  /** 读用例（无锁；调用方可不传 tx = 无事务只读）。 */
  async run(ctx: WalletContext, tx?: Tx): Promise<WalletSummaryResponseDto> {
    try {
      const [coin, cny, turnover, gift] = await Promise.all([
        this.ledger.readAccount(ctx.userId, 1 /* AssetType.COIN */, 1 /* AccountType.PLAYER */, tx),
        this.ledger.readAccount(ctx.userId, 2 /* AssetType.CNY_BALANCE */, 1 /* AccountType.PLAYER */, tx),
        this.ledger.getTurnover(ctx.userId, tx),
        this.ledger.readWelcomeGift(ctx.userId, tx),
      ]);
      if (coin === null || cny === null) {
        // 玩家账户行缺失（未开户）→ 上游状态缺口（注册 workflow 未建账），
        // 以存储不可用暴露，不静默零值（决策点登记：开户时机统一归 identity 注册流）。
        throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, 'player asset accounts not provisioned');
      }
      const accounts = [coin, cny];
      return toWalletSummary(accounts, turnover, gift);
    } catch (err) {
      if (err instanceof WalletDomainError) throw err;
      throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, 'wallet summary read failed');
    }
  }
}
