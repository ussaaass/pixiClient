/**
 * 金币转账用例：POST /me/wallet/transfers/quote + POST /me/wallet/transfers。
 *
 * 领域所有者：wallet 模块（auth wallet.transferQuote / wallet.transfer）。
 * 对应 SDD 章节：后端实施 SDD §5.4（transfers/quote+submit，契约已有 handler
 * 新实现）、§4（锁顺序 `sender account → receiver account → hold`（按
 * asset_account.id 数值升序 SELECT FOR UPDATE）；幂等先抢
 * `asset_operation.operation_key` 唯一约束；所有分录/outbox 同事务）；
 * 双资产文档 §2（转账手续费 5% 由发送方额外支付，@gameing/domain 纯函数；
 * 赠币流水未完成禁止转出，turnover_state 判定）。
 *
 * 报价（quote，无事务）：
 * - 读汇率/费率 + 读收件人昵称，构造 `WalletTransferQuoteDto`（domain 包
 *   `createTransferQuote`，5% 手续费 domain 包 `calculateTransferFee`）。
 *
 * 提交（transfer，单事务）：
 * 1. 幂等抢键：operationKey = `transfer:{userId}:{idempotencyKey}`，先 INSERT
 *    asset_operation（request_hash 防同键异内容）；命中 committed_at 非空 →
 *    重放原结果（result_snapshot），不产生第二笔（§10 红线）。
 * 2. 报价校验：`checkTransferQuote`（过期 → TRANSFER_QUOTE_EXPIRED；
 *    费率/金额变化 → TRANSFER_QUOTE_CHANGED，domain 包 `transferQuoteMatches`）。
 * 3. 门禁：SELF_TRANSFER（收件人 = 自己）/ RECIPIENT_NOT_FOUND（收件人不存在
 *    或非 ACTIVE）/ 流水门槛（turnover_state.remaining_coins > 0 →
 *    TURNOVER_INCOMPLETE，双资产文档 §2 "未完成流水禁止转出"）。
 * 4. 锁账户：sender COI + receiver COI 玩家账户按 asset_account.id 数值升序
 *    SELECT ... FOR UPDATE（§4 锁顺序）。
 * 5. 余额门禁：sender 可用余额（amount - frozen_amount）≥ coins + fee
 *    （INSUFFICIENT_AVAILABLE_BALANCE；AGENTS.md "校验本金加手续费的可用余额"）。
 * 6. 分录（同一 operation 下，守恒）：sender COI -totalCoins；
 *    receiver COI +coins；系统 COI +fee（5% 手续费归系统账户，
 *    系统账户为资产归宿，双资产文档 §2 / AGENTS.md "手续费均有对应系统分录"）。
 * 7. 快照回填 committed_at + result_snapshot + outbox 同事务（§6.3）。
 *
 * 错误码映射（contracts `WalletErrorCode` → 触发条件）：
 * - `RECIPIENT_NOT_FOUND`：quote/submit 收件人 user 不存在或 status ≠ ACTIVE。
 * - `SELF_TRANSFER`：recipientUserId == 发起 userId。
 * - `INVALID_TRANSFER_AMOUNT`：coins ≤ 0（schema 已挡，防御性二次校验）。
 * - `TRANSFER_QUOTE_EXPIRED`：提交时报价已过 expiresAt。
 * - `TRANSFER_QUOTE_CHANGED`：报价费率/金额与当前 5% 费率不匹配（配置变化须
 *   重新报价，双资产文档 §2）。
 * - `TURNOVER_INCOMPLETE`：turnover_state.remaining_coins > 0（未完成赠币流水
 *   禁止转出金币，双资产文档 §2）。
 * - `INSUFFICIENT_AVAILABLE_BALANCE`：可用余额 < coins + fee（本金加手续费，
 *   AGENTS.md 硬约束；冻结额计入占用）。
 * - `IDEMPOTENCY_KEY_REUSED`：同 operation_key 命中但 request_hash 不一致。
 * - `WALLET_STORAGE_UNAVAILABLE`：Sequelize 故障 / 账户未开户 / 乐观 version
 *   冲突（可重试）/ 未提交残留操作行。
 * - 成功 → WalletTransferResultDto（201；重放原结果 = 200 语义由路由层按
 *   inserted 标志决定，登记决策点）。
 */

import type {
  WalletTransferQuoteRequestDto,
  WalletTransferQuoteDto,
  WalletTransferRequestDto,
  WalletTransferResultDto,
} from '@gameing/contracts/wallet';
import { WalletTransferQuoteRequestSchema, WalletTransferRequestSchema, Value } from '@gameing/contracts/wallet';
import { createTransferQuote } from '@gameing/domain/wallet';
// Value 经 @gameing/contracts/wallet 桥接导出（与 identity.ts Static 桥接同款先例；
// backend 不直接依赖 @sinclair/typebox，SDD §1 依赖清单纪律）。
import { checkTransferQuote, requestHashOf, assertAvailableBalance, assertConservation, TRANSFER_FEE_BPS } from '../domain/ledger-rules.js';
import { WalletDomainError, W } from '../domain/errors.js';
import type { AssetLedger, ConfigReader, Tx, WalletContext, EntryIntent, SystemIdentityPort } from '../ports/wallet-repository.js';
import { WalletOperationType, WalletEntryType } from '../ports/wallet-repository.js';
import type { OutboxPort } from '../ports/outbox-port.js';
import type { Clock } from '../ports/clock.js';
import { toDateIso } from '../adapters/row-mappers.js';

export interface TransferQuoteInput extends WalletContext {
  request: WalletTransferQuoteRequestDto;
}

export interface TransferSubmitInput extends WalletContext {
  request: WalletTransferRequestDto;
  tx: Tx;
  /** 同事务 outbox（§6.3；装配层经 module.withTx 传入）。 */
  outbox: OutboxPort;
}

export class CoinTransferUseCase {
  constructor(
    private readonly ledger: AssetLedger,
    private readonly config: ConfigReader,
    private readonly clock: Clock,
    private readonly systemIdentity: SystemIdentityPort,
  ) {}

  /** 报价（无事务）：读收件人昵称 + 5% 费率构造报价。 */
  async quote(ctx: WalletContext, request: WalletTransferQuoteRequestDto): Promise<WalletTransferQuoteDto> {
    if (!Value.Check(WalletTransferQuoteRequestSchema, request)) {
      throw new WalletDomainError(W.INVALID_TRANSFER_AMOUNT, 'transfer quote request schema failed');
    }
    const recipient = await this.ledger.readUser(request.recipientUserId);
    if (recipient === null) {
      throw new WalletDomainError(W.RECIPIENT_NOT_FOUND, 'recipient user not found');
    }
    const nickname = (await this.ledger.readNickname(request.recipientUserId)) ?? `user-${request.recipientUserId}`;
    const coins = BigInt(request.coins);
    return createTransferQuote({
      recipientUserId: request.recipientUserId,
      recipientDisplayName: nickname,
      coins,
      feeRateBps: TRANSFER_FEE_BPS,
      quotedAt: this.clock.now(),
    });
  }

  /** 提交（单事务）：幂等抢键 → 报价/门禁/锁/余额 → 分录 + 快照 + outbox。 */
  async submit(ctx: WalletContext, input: TransferSubmitInput): Promise<WalletTransferResultDto> {
    const { request, tx, outbox } = input;
    if (!Value.Check(WalletTransferRequestSchema, request)) {
      throw new WalletDomainError(W.INVALID_TRANSFER_AMOUNT, 'transfer request schema failed');
    }
    const quote = request.quote;
    const coins = BigInt(quote.coins);
    const feeCoins = BigInt(quote.feeCoins);
    const totalCoins = coins + feeCoins;

    // 1) 报价校验（过期/变化 → 客户端重新报价，双资产文档 §2）。
    const quoteStatus = checkTransferQuote(quote, this.clock.now());
    if (quoteStatus !== 'OK') {
      throw new WalletDomainError(quoteStatus, 'transfer quote no longer valid');
    }

    // 2) 门禁：SELF / 收件人存在且 ACTIVE（quote 已校验，submit 复核，
    // 弱网重试窗口内账号可能已停用）。
    if (quote.recipientUserId === ctx.userId) {
      throw new WalletDomainError(W.SELF_TRANSFER, 'self transfer rejected');
    }
    const recipient = await this.ledger.readUser(quote.recipientUserId, tx);
    if (recipient === null || recipient.status !== 1 /* UserStatus.ACTIVE */) {
      throw new WalletDomainError(W.RECIPIENT_NOT_FOUND, 'recipient not found or inactive');
    }

    // 3) 流水门槛（双资产文档 §2 "未完成流水禁止转出"；读在锁前，
    // 锁内复核防并发结算释放——此处以读值判定，结算侧扣减同事务串行化）。
    const turnover = await this.ledger.getTurnover(ctx.userId, tx);
    if (turnover !== null && !turnover.canTransferOrWithdraw) {
      throw new WalletDomainError(W.TURNOVER_INCOMPLETE, 'gift turnover requirement not completed');
    }

    // 4) 幂等抢键（operation_key 唯一约束先抢；命中 committed = 重放原结果）。
    const operationKey = `transfer:${ctx.userId}:${request.idempotencyKey}`;
    const requestHash = requestHashOf({
      quote,
      recipientUserId: quote.recipientUserId,
      coins: quote.coins,
      feeRateBps: quote.feeRateBps,
      userId: ctx.userId,
    });
    const claimed = await this.ledger.claimOperation({
      operationKey,
      operationType: WalletOperationType.TRANSFER,
      requestHash,
      initiatedByUserId: ctx.userId,
      extra: {
        coins: quote.coins,
        feeCoins: quote.feeCoins,
        counterpartyUserId: quote.recipientUserId,
        counterpartyLabel: quote.recipientDisplayName,
        direction: 'SENT',
        feeRateBps: quote.feeRateBps,
      },
      reason: null,
      tx,
    });
    if (!claimed.inserted) {
      // 重放原结果（committed_at 非空，§4 "失败可重查原结果，不产生第二笔"）。
      const snapshot = await this.ledger.getOperationResultSnapshot(claimed.operation.id, tx);
      if (snapshot === null) {
        throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, 'transfer replay without result snapshot');
      }
      return toTransferResult(claimed.operation.id, quote, snapshot);
    }
    const operationId = claimed.operation.id;

    // 5) 锁账户（sender COI → receiver COI → 系统 COI；按 asset_account.id
    // 数值升序 SELECT FOR UPDATE，§4 锁顺序防死锁）。
    const senderCoin = await this.ledger.readAccount(ctx.userId, 1, 1, tx);
    const receiverCoin = await this.ledger.readAccount(quote.recipientUserId, 1, 1, tx);
    const systemCoin = await this.ledger.readAccount(this.systemIdentity.systemUserId, 1, 2, tx); // 系统账户行（SYSTEM 身份，全库唯一，双资产文档 §2 "系统为来源/归宿"）
    if (senderCoin === null || receiverCoin === null || systemCoin === null) {
      throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, 'asset account not provisioned');
    }
    const lockIds = [senderCoin.id, receiverCoin.id, systemCoin.id]
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    await this.ledger.lockAccountsByIds(lockIds, tx);

    // 6) 余额门禁（sender 可用余额 ≥ 本金 + 手续费，AGENTS.md 硬约束）。
    assertAvailableBalance(BigInt(senderCoin.amount), BigInt(senderCoin.frozenAmount), totalCoins);

    // 7) 分录（同一 operation；sender -total / receiver +coins / 系统 +fee；
    // 守恒：内部转移总额 = 0，手续费从玩家流到系统账户）。
    const intents: EntryIntent[] = [
      {
        accountId: senderCoin.id,
        delta: -totalCoins,
        frozenDelta: 0n,
        entryType: WalletEntryType.INTERNAL,
        memo: `transfer out to user ${quote.recipientUserId} (coins ${coins} + fee ${feeCoins})`,
      },
      {
        accountId: receiverCoin.id,
        delta: coins,
        frozenDelta: 0n,
        entryType: WalletEntryType.INTERNAL,
        memo: `transfer in from user ${ctx.userId} (coins ${coins})`,
      },
      {
        accountId: systemCoin.id,
        delta: feeCoins,
        frozenDelta: 0n,
        entryType: WalletEntryType.INTERNAL,
        memo: `transfer fee income from user ${ctx.userId} (${feeCoins} coins, ${quote.feeRateBps} bps)`,
      },
    ];
    const posts = await this.ledger.postEntries(operationId, intents, tx);
    assertConservation(posts, 0n); // 内部转移守恒：系统 +fee 不破坏"玩家侧净额=0"（系统侧边界分开核对，双资产文档 §2）

    // 8) 快照 + outbox 同事务（§6.3 "所有分录/outbox 同事务"）。
    const committedAt = this.clock.now();
    const result: WalletTransferResultDto = {
      operationId,
      recipientUserId: quote.recipientUserId,
      recipientDisplayName: quote.recipientDisplayName,
      coins: quote.coins,
      feeCoins: quote.feeCoins,
      totalCoins: quote.totalCoins,
      occurredAt: toDateIso(committedAt),
    };
    await this.ledger.setCommitted(operationId, committedAt, { ...result }, tx);
    await outbox.append({
      topic: 'wallet.transfer',
      userId: ctx.userId,
      assetOperationId: operationId,
      payload: {
        operationId,
        recipientUserId: quote.recipientUserId,
        coins: quote.coins,
        feeCoins: quote.feeCoins,
      },
    });

    return result;
  }
}

/** 重放原结果（result_snapshot 已是 wire DTO；缺字段兜底为当前报价值）。 */
function toTransferResult(operationId: string, quote: WalletTransferQuoteDto, snapshot: Record<string, unknown>): WalletTransferResultDto {
  const s = snapshot as Partial<WalletTransferResultDto>;
  return {
    operationId: typeof s.operationId === 'string' ? s.operationId : operationId,
    recipientUserId: typeof s.recipientUserId === 'string' ? s.recipientUserId : quote.recipientUserId,
    recipientDisplayName: typeof s.recipientDisplayName === 'string' ? s.recipientDisplayName : quote.recipientDisplayName,
    coins: typeof s.coins === 'string' ? s.coins : quote.coins,
    feeCoins: typeof s.feeCoins === 'string' ? s.feeCoins : quote.feeCoins,
    totalCoins: typeof s.totalCoins === 'string' ? s.totalCoins : quote.totalCoins,
    occurredAt: typeof s.occurredAt === 'string' ? s.occurredAt : toDateIso(new Date()),
  };
}
