/**
 * 金币兑余额用例：POST /me/wallet/exchanges/quote + POST /me/wallet/exchanges。
 *
 * 领域所有者：wallet 模块（auth wallet.exchangeQuote / wallet.exchange）。
 * 对应 SDD 章节：后端实施 SDD §5.4（exchanges/quote+submit，契约已有 handler
 * 新实现）、§4（锁顺序、幂等先抢 operation_key、分录/outbox 同事务）；
 * 双资产文档 §2（兑换只支持金币→余额；rate 读 `system_config.cny_to_coin_ratio`
 * 配置（"1:10" = 1 元兑 10 金币，按分子/分母解析为整数分）；兑入余额按人民币
 * 分向下取整，不足 1 分余数舍弃；`coin_exchange` 快照与分录同事务；配置变化
 * 须重新报价）。
 *
 * 报价（quote，无事务）：
 * - 读汇率（ConfigReader）；缺失/非法 → EXCHANGE_NOT_AVAILABLE。
 * - 读 sender 可用金币 + 系统 CNY 可用余额（双资产文档 §2 "兑换必须同时检查
 *   玩家可用金币及系统人民币可用余额"）；金币余额不足 = 报价阶段即可拒绝
 *   （INSUFFICIENT_EXCHANGE_BALANCE，双资产文档 §2 系统门禁；冻结计入占用）。
 * - domain 包 `calculateExchangeCashFen`（= coins × rateCashFen / rateCoinUnits，
 *   BigInt 整除 = 向下取整到分，余数舍弃，双资产文档 §2 "不足 1 分余数舍弃"）。
 * - 结果 0 分（金币太小）→ INVALID_EXCHANGE_AMOUNT。
 *
 * 提交（单事务）：
 * 1. 幂等抢键：operationKey = `exchange:{userId}:{idempotencyKey}`；
 *    命中 committed = 重放原结果。
 * 2. 报价校验：`checkExchangeQuote`（过期 → EXCHANGE_QUOTE_EXPIRED；汇率变化 →
 *    EXCHANGE_QUOTE_CHANGED，双资产文档 §2 "提交时若配置变化则要求重新报价"）。
 * 3. 锁账户：sender COI → sender CNY → 系统 COI → 系统 CNY，按 asset_account.id
 *    数值升序 SELECT FOR UPDATE（§4 锁顺序；兑换涉及四个账户行）。
 * 4. 余额/配置复核（锁内重读汇率与余额，防报价后窗口期配置/余额变化）。
 * 5. 分录（同一 operation；守恒：用户金币 -coins、用户 CNY +cashFen、
 *    系统 COI +coins、系统 CNY -cashFen——双资产文档 §2 "兑换同时把用户金币
 *    转给系统、系统余额转给用户"，双账本各自守恒，总额互换净值 0）。
 * 6. `coin_exchange` 快照（FLOOR_CREDIT=2，previewKey = 报价定位值）+
 *    committed_at + result_snapshot + outbox 同事务（§6.3）。
 *
 * 错误码映射（contracts `WalletErrorCode` → 触发条件）：
 * - `EXCHANGE_NOT_AVAILABLE`：`cny_to_coin_ratio` 配置缺失或格式非法
 *   （ConfigReader 返回 null；parser allowlist 见 domain/ledger-rules.ts
 *   `parseCnyToCoinRatio`，SDD §4 "parser allowlist + 范围校验"）。
 * - `INVALID_EXCHANGE_AMOUNT`：coins ≤ 0（schema 已挡）或折算结果 < 1 分
 *   （不足 1 分余数舍弃后无价值，双资产文档 §2）。
 * - `EXCHANGE_QUOTE_EXPIRED`：提交时报价已过 expiresAt。
 * - `EXCHANGE_QUOTE_CHANGED`：报价汇率/折算分与当前配置不匹配（须重新报价）。
 * - `INSUFFICIENT_EXCHANGE_BALANCE`：可用金币 < coins（玩家侧）或系统 CNY
 *   可用 < cashFen（系统门禁，双资产文档 §2）。
 * - `IDEMPOTENCY_KEY_REUSED`：同 operation_key 命中但 request_hash 不一致。
 * - `WALLET_STORAGE_UNAVAILABLE`：Sequelize 故障 / 账户未开户 / 乐观 version
 *   冲突（可重试）/ 未提交残留操作行。
 * - 成功 → WalletExchangeResultDto（201；重放原结果 = 200 语义由路由层决定）。
 *
 * 注（登记决策点）：双资产文档 §2 "直属上级为客损模式时不开放平台兑换"的
 * 上级模式门禁依赖 referral 模块（SDD §9 第 6 步），本步未闭环——兑换入口
 * 暂不校验上级客损模式，Lead 统一验证时补门禁（referral 模块落地后挂接）。
 */

import type {
  WalletExchangeQuoteRequestDto,
  WalletExchangeQuoteDto,
  WalletExchangeRequestDto,
  WalletExchangeResultDto,
} from '@gameing/contracts/wallet';
import { WalletExchangeQuoteRequestSchema, WalletExchangeRequestSchema, Value } from '@gameing/contracts/wallet';
// Value 经 @gameing/contracts/wallet 桥接导出（backend 不直接依赖 @sinclair/typebox，
// SDD §1 依赖清单纪律，与 transfer.ts 同款）。
import { createExchangeQuote, calculateExchangeCashFen } from '@gameing/domain/wallet';
import { checkExchangeQuote, requestHashOf, assertConservation } from '../domain/ledger-rules.js';
import { WalletDomainError, W } from '../domain/errors.js';
import type { AssetLedger, ConfigReader, Tx, WalletContext, EntryIntent, SystemIdentityPort } from '../ports/wallet-repository.js';
import { WalletOperationType, WalletEntryType, WalletRoundingMode } from '../ports/wallet-repository.js';
import type { OutboxPort } from '../ports/outbox-port.js';
import type { Clock } from '../ports/clock.js';
import { randomId } from '../../../infrastructure/jwt/jwt.js';
import { toDateIso } from '../adapters/row-mappers.js';

export interface ExchangeQuoteInput extends WalletContext {
  request: WalletExchangeQuoteRequestDto;
}

export interface ExchangeSubmitInput extends WalletContext {
  request: WalletExchangeRequestDto;
  tx: Tx;
  /** 同事务 outbox（§6.3；装配层经 module.withTx 传入）。 */
  outbox: OutboxPort;
}

/** 汇率解析后的配置缺失语义（ConfigReader 返回 null 时用例统一抛此码）。 */
function unavailableRate(): never {
  throw new WalletDomainError(W.EXCHANGE_NOT_AVAILABLE, 'exchange rate config missing or invalid');
}

export class CoinExchangeUseCase {
  constructor(
    private readonly ledger: AssetLedger,
    private readonly config: ConfigReader,
    private readonly clock: Clock,
    private readonly systemIdentity: SystemIdentityPort,
  ) {}

  /** 报价（无事务）：读汇率 + 双方余额门禁 + 向下取整到分。 */
  async quote(ctx: WalletContext, request: WalletExchangeQuoteRequestDto): Promise<WalletExchangeQuoteDto> {
    if (!Value.Check(WalletExchangeQuoteRequestSchema, request)) {
      throw new WalletDomainError(W.INVALID_EXCHANGE_AMOUNT, 'exchange quote request schema failed');
    }
    const rate = await this.config.readExchangeRate();
    if (rate === null) unavailableRate();
    const coins = BigInt(request.coins);
    if (coins <= 0n) throw new WalletDomainError(W.INVALID_EXCHANGE_AMOUNT, 'exchange coins must be positive');
    const cnyFen = calculateExchangeCashFen(coins, rate.rateCoinUnits, rate.rateCashFen);
    if (cnyFen <= 0n) {
      // 不足 1 分余数舍弃后无价值（双资产文档 §2 "兑入余额按人民币分向下取整"）。
      throw new WalletDomainError(W.INVALID_EXCHANGE_AMOUNT, 'exchange result rounds below 1 CNY fen');
    }
    // 系统 CNY 门禁（双资产文档 §2 "兑换必须同时检查系统人民币可用余额"）：
    // 报价阶段只读系统账户行（无锁），submit 锁内复核。
    const systemCny = await this.ledger.readAccount(this.systemIdentity.systemUserId, 2, 2);
    if (systemCny !== null) {
      const systemAvailable = BigInt(systemCny.amount) - BigInt(systemCny.frozenAmount);
      if (systemAvailable < cnyFen) {
        // 系统侧资金不足（发行/充值未完成）→ 兑换暂不可用（配置/库存语义）。
        throw new WalletDomainError(W.EXCHANGE_NOT_AVAILABLE, 'system CNY reserve insufficient');
      }
    }
    return createExchangeQuote({ coins, rateCoinUnits: rate.rateCoinUnits, rateCashFen: rate.rateCashFen, quotedAt: this.clock.now() });
  }

  /** 提交（单事务）：幂等抢键 → 报价/汇率复核 → 锁四账户 → 分录 + 快照 + outbox。 */
  async submit(ctx: WalletContext, input: ExchangeSubmitInput): Promise<WalletExchangeResultDto> {
    const { request, tx, outbox } = input;
    if (!Value.Check(WalletExchangeRequestSchema, request)) {
      throw new WalletDomainError(W.INVALID_EXCHANGE_AMOUNT, 'exchange request schema failed');
    }
    const quote = request.quote;
    const coins = BigInt(quote.coins);

    // 1) 汇率 + 报价校验（锁外先读；锁内再复核防窗口期配置变化）。
    const rate = await this.config.readExchangeRate();
    if (rate === null) unavailableRate();
    const quoteStatus = checkExchangeQuote(quote, rate, this.clock.now());
    if (quoteStatus !== 'OK') {
      throw new WalletDomainError(quoteStatus, 'exchange quote no longer valid');
    }
    const cnyFen = calculateExchangeCashFen(coins, rate.rateCoinUnits, rate.rateCashFen);
    if (cnyFen <= 0n) throw new WalletDomainError(W.INVALID_EXCHANGE_AMOUNT, 'exchange result rounds below 1 CNY fen');

    // 2) 幂等抢键（命中 committed = 重放原结果，§4 "失败可重查原结果"）。
    const operationKey = `exchange:${ctx.userId}:${request.idempotencyKey}`;
    const requestHash = requestHashOf({ quote, userId: ctx.userId });
    const claimed = await this.ledger.claimOperation({
      operationKey,
      operationType: WalletOperationType.COIN_EXCHANGE,
      requestHash,
      initiatedByUserId: ctx.userId,
      extra: { coins: quote.coins, cnyFen: quote.cnyFen, rate: { coinUnits: quote.rateCoinUnits, cashFen: quote.rateCashFen } },
      reason: null,
      tx,
    });
    if (!claimed.inserted) {
      const snapshot = await this.ledger.getOperationResultSnapshot(claimed.operation.id, tx);
      if (snapshot === null) {
        throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, 'exchange replay without result snapshot');
      }
      return toExchangeResult(claimed.operation.id, quote, snapshot);
    }
    const operationId = claimed.operation.id;

    // 3) 锁四账户（用户 COI/CNY + 系统 COI/CNY；按 asset_account.id 数值升序，
    // §4 锁顺序；兑换涉及双资产两个账本，双资产文档 §2 "同一数据库事务内完成"）。
    const userCoin = await this.ledger.readAccount(ctx.userId, 1, 1, tx);
    const userCny = await this.ledger.readAccount(ctx.userId, 2, 1, tx);
    // 系统账户行 user_id = SYSTEM 身份（role_type 8，全库唯一，0002 迁移）；
    // 本步装配注入系统 user id（decision point：ConfigReader 扩展或独立常量端口）。
    const systemCoin = await this.ledger.readAccount(this.systemIdentity.systemUserId, 1, 2, tx);
    const systemCny = await this.ledger.readAccount(this.systemIdentity.systemUserId, 2, 2, tx);
    if (userCoin === null || userCny === null || systemCoin === null || systemCny === null) {
      throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, 'asset account not provisioned');
    }
    const lockIds = [userCoin.id, userCny.id, systemCoin.id, systemCny.id]
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    await this.ledger.lockAccountsByIds(lockIds, tx);

    // 4) 锁内复核：可用金币（玩家）+ 系统 CNY 可用（双资产文档 §2 系统门禁）。
    const userAvailable = BigInt(userCoin.amount) - BigInt(userCoin.frozenAmount);
    if (userAvailable < coins) {
      throw new WalletDomainError(W.INSUFFICIENT_EXCHANGE_BALANCE, 'insufficient available coins for exchange');
    }
    const systemCnyAvailable = BigInt(systemCny.amount) - BigInt(systemCny.frozenAmount);
    if (systemCnyAvailable < cnyFen) {
      throw new WalletDomainError(W.EXCHANGE_NOT_AVAILABLE, 'system CNY reserve insufficient at commit');
    }

    // 5) 分录（同一 operation；双账本互换，各自守恒）：
    // 用户 COI -coins → 系统 COI +coins；系统 CNY -cashFen → 用户 CNY +cashFen。
    const intents: EntryIntent[] = [
      {
        accountId: userCoin.id,
        delta: -coins,
        frozenDelta: 0n,
        entryType: WalletEntryType.INTERNAL,
        memo: `coin exchange out: -${coins} coins -> CNY ${cnyFen} fen (rate ${rate.rateCoinUnits} coins / ${rate.rateCashFen} fen)`,
      },
      {
        accountId: systemCoin.id,
        delta: coins,
        frozenDelta: 0n,
        entryType: WalletEntryType.INTERNAL,
        memo: `coin exchange in from user ${ctx.userId}: +${coins} coins`,
      },
      {
        accountId: systemCny.id,
        delta: -cnyFen,
        frozenDelta: 0n,
        entryType: WalletEntryType.INTERNAL,
        memo: `coin exchange CNY out to user ${ctx.userId}: -${cnyFen} fen`,
      },
      {
        accountId: userCny.id,
        delta: cnyFen,
        frozenDelta: 0n,
        entryType: WalletEntryType.INTERNAL,
        memo: `coin exchange in to user ${ctx.userId}: +${cnyFen} fen CNY balance`,
      },
    ];
    const posts = await this.ledger.postEntries(operationId, intents, tx);
    assertConservation(posts, 0n); // 四账户总额互换净值 0（双资产文档 §2 "任意失败回滚，两种资产均不部分提交"）

    // 6) coin_exchange 快照（FLOOR_CREDIT=2，双资产文档 §2 "不足 1 分余数舍弃"；
    // previewKey = 报价定位值，CHAR(36) UUID 风格）。
    const previewKey = randomId(18);
    await this.ledger.appendCoinExchange({
      userId: ctx.userId,
      assetOperationId: operationId,
      coins: -coins,
      cashCents: cnyFen,
      feeCents: 0n,
      rateCoinUnits: rate.rateCoinUnits,
      rateCashFen: rate.rateCashFen,
      roundingType: WalletRoundingMode.FLOOR_CREDIT,
      previewKey,
      tx,
    });

    // 7) 快照回填 + outbox 同事务（§6.3）。
    const committedAt = this.clock.now();
    const result: WalletExchangeResultDto = {
      operationId,
      coins: quote.coins,
      cnyFen: cnyFen.toString(),
      occurredAt: toDateIso(committedAt),
    };
    await this.ledger.setCommitted(operationId, committedAt, { ...result }, tx);
    await outbox.append({
      topic: 'wallet.exchange',
      userId: ctx.userId,
      assetOperationId: operationId,
      payload: { operationId, coins: quote.coins, cnyFen: cnyFen.toString(), previewKey },
    });

    return result;
  }
}

/** 重放原结果（result_snapshot 已是 wire DTO；缺字段兜底为当前报价值）。 */
function toExchangeResult(operationId: string, quote: WalletExchangeQuoteDto, snapshot: Record<string, unknown>): WalletExchangeResultDto {
  const s = snapshot as Partial<WalletExchangeResultDto>;
  return {
    operationId: typeof s.operationId === 'string' ? s.operationId : operationId,
    coins: typeof s.coins === 'string' ? s.coins : quote.coins,
    cnyFen: typeof s.cnyFen === 'string' ? s.cnyFen : quote.cnyFen,
    occurredAt: typeof s.occurredAt === 'string' ? s.occurredAt : toDateIso(new Date()),
  };
}
