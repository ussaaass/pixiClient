/**
 * 提现报价 + 申请用例：POST /me/wallet/withdrawals/quote + POST /me/wallet/withdrawals。
 *
 * 领域所有者：payments 模块（withdrawal / payout_account 写入 + 占款事务经
 * wallet `AssetLedger`；流水门禁经 wallet `TurnoverGateUseCase`；身份三选一经
 * identity user 行只读）。
 * 对应 SDD 章节：后端实施 SDD §5.4（withdrawalQuote/createWithdrawal 端点，
 * 契约 `WalletEndpoint` 既有 schema）、§9 第 3 步（支付与提现）、§10 红线
 * （占款原子、失败不占款）；双资产文档 §4（"提现申请金额表示净到账额；费率
 * 额外扣取向上取整到分；申请时一并占款净额+手续费；最低 1000 金币整数倍门槛；
 * 72 小时出款等待；状态九态"）、§5（"身份三选一：已验证邮箱、已验证手机、
 * 有效用户名+密码"；"未完成流水禁止提现"）、§5.1（"创建提现的原子事务再次
 * 校验有效流水；校验失败必须不冻结余额、不创建 withdrawal"）。
 *
 * quoteWithdrawal（纯报价，无事务）：
 * - 读收款账户（PayoutAccountRepository，缺失 → PAYOUT_ACCOUNT_NOT_FOUND）；
 * - 读汇率（cny_to_coin_ratio）+ 费率 5% + 门槛 1000 枚整数倍（domain/rules.ts
 *   `assertWithdrawalNetCny` / `withdrawalFeeOf`，`@gameing/domain/wallet`
 *   `createWithdrawalQuote` 构造）；
 * - 净到账 → 费（5% 向上取整到分，domain 包 calculateWithdrawalFee）→ 总扣额
 *   debitCnyFen = net + fee（双资产文档 §4 "账户共扣 110 元"示例口径）；
 * - 门槛：净到账折金币 ≥ 1000 且为 1000 整数倍（fee 不计入门槛，§4 "手续费
 *   不计入门槛"）；不满足 → WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID；
 * - 出款等待：payoutNotBeforeAt = quotedAt + 72h（§4 "申请后至少等待 72 小时"）。
 *
 * createWithdrawal（单事务，经 module.withTx 同事务 outbox）：
 * 1. 流水门禁（TurnoverGateUseCase.assertTransferAllowed；未过 → TURNOVER_
 *    INCOMPLETE，§5.1 "校验失败必须不冻结余额、不创建 withdrawal"）。
 * 2. 身份三选一（经 IdentityReader 读 user 行；未满足 → INVALID_PAYOUT_ACCOUNT——
 *    contracts 无"身份未验证"专码，P 表只映射既有码子集，errors.ts 头注释登记）。
 * 3. 占款事务（WITHDRAWAL_HOLD=6 操作 + 三分录 + asset_hold 行）：
 *    - 用户 CNY 账户：delta = -(净+费) 总额占用，frozenDelta = +(净+费)（冻结计入
 *      占用，AGENTS.md "校验本金加手续费的可用余额及冻结"；可用余额 ≥ 净+费，
 *      不足 → INSUFFICIENT_AVAILABLE_BALANCE）；
 *    - 系统 CNY 账户：delta = +(净+费)（系统为资产归宿，双资产文档 §2）；
 *    - asset_hold 行（HoldType WITHDRAWAL=2，amount=remaining=净+费，
 *      ledger.createHold U(hold_key) 幂等）；
 *    - withdrawal REQUESTED=1 + payout_not_before_at=+72h（U(withdrawal_key)）；
 *    - outbox('payments.withdrawal.requested') 同事务（§6.3）。
 *
 * 错误码映射（contracts `WalletErrorCode` 子集 → 触发条件）：
 * - `TURNOVER_INCOMPLETE`：流水未完成（remaining_coins > 0，§2/§5.1）。
 * - `INVALID_PAYOUT_ACCOUNT`：身份三选一未满足（contracts 无专码，语义映射登记）。
 * - `PAYOUT_ACCOUNT_NOT_FOUND`：收款账户缺失/软删/非本人（quote 读侧 + create 锁侧）。
 * - `WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID`：净到账 < 1000 枚等值或非 1000 整数倍。
 * - `WITHDRAWAL_QUOTE_EXPIRED` / `WITHDRAWAL_QUOTE_CHANGED`：提交时报价过期或
 *   费率/金额与当前配置不匹配（须重新报价，§2 "配置变化须重新报价"）。
 * - `INSUFFICIENT_AVAILABLE_BALANCE`：可用 CNY 余额 < 净+费（本金加费用，AGENTS.md）。
 * - `IDEMPOTENCY_KEY_REUSED` / `WALLET_STORAGE_UNAVAILABLE`：抢键冲突 / 存储故障。
 * - 成功 → WithdrawalDto（201；重放原结果 = 200 语义由路由层决定）。
 */

import type { WithdrawalQuoteRequestDto, WithdrawalQuoteDto, CreateWithdrawalRequestDto, WithdrawalDto } from '@gameing/contracts/wallet';
import { Value, WithdrawalQuoteRequestSchema, CreateWithdrawalRequestSchema } from '@gameing/contracts/wallet';
import { createWithdrawalQuote, withdrawalQuoteMatches } from '@gameing/domain/wallet';
import { AssetOperationType, HoldType, AssetType, AccountType } from '../../../infrastructure/database/models/wallet.js';
import { WithdrawalStatus } from '../../../infrastructure/database/models/payments.js';
import {
  assertWithdrawalNetCny,
  identitySatisfied,
  requestHashOf,
  withdrawalFeeOf,
  WITHDRAWAL_DELAY_HOURS,
  WITHDRAWAL_FEE_BPS,
} from '../domain/rules.js';
import { PaymentDomainError, P } from '../domain/errors.js';
import type {
  PayoutAccountRepository,
  WithdrawalRepository,
  IdentityReader,
  Tx,
  AssetLedger,
  ConfigReader,
  Clock,
  EntryIntent,
  OutboxPort,
  SystemIdentityPort,
} from '../ports/payments-repository.js';
import type { TurnoverGateUseCase } from '../../wallet/application/turnover.js';
import { WalletEntryType } from '../../wallet/ports/wallet-repository.js';
import { toDateIso } from '../../wallet/adapters/row-mappers.js';

export interface QuoteWithdrawalInput {
  userId: string;
  request: WithdrawalQuoteRequestDto;
}

export interface CreateWithdrawalInput {
  userId: string;
  request: CreateWithdrawalRequestDto;
  tx: Tx;
  outbox: OutboxPort;
}

export interface CreateWithdrawalResult {
  dto: WithdrawalDto;
  inserted: boolean;
}

export class WithdrawalUseCase {
  constructor(
    private readonly withdrawals: WithdrawalRepository,
    private readonly payoutAccounts: PayoutAccountRepository,
    private readonly ledger: AssetLedger,
    private readonly config: ConfigReader,
    private readonly turnoverGate: TurnoverGateUseCase,
    private readonly identity: IdentityReader,
    private readonly systemIdentity: SystemIdentityPort,
    private readonly clock: Clock,
  ) {}

  /** 纯报价（无事务）：净到账 + 费率 5% 向上取整到分 + 1000 枚整数倍门槛校验。 */
  async quote(userId: string, request: WithdrawalQuoteRequestDto): Promise<WithdrawalQuoteDto> {
    if (!Value.Check(WithdrawalQuoteRequestSchema, request)) {
      throw new PaymentDomainError(P.WITHDRAWAL_MINIMUM_OR_MULTIPLE_INVALID, 'quote request schema failed');
    }
    // 读收款账户（归属校验：非本人/软删 → NOT_FOUND；首版经 listByUser 过滤）。
    const accounts = await this.payoutAccounts.listByUser(userId);
    const account = accounts.find((a) => a.id === request.payoutAccountId);
    if (account === undefined) {
      throw new PaymentDomainError(P.PAYOUT_ACCOUNT_NOT_FOUND, `payout account not found: ${request.payoutAccountId}`);
    }
    const rate = await this.config.readExchangeRate();
    if (rate === null) {
      // 汇率缺失 → 报价不可构造（WITHDRAWAL_CONFIG_INVALID，§2 配置缺失语义）。
      throw new PaymentDomainError(P.WITHDRAWAL_CONFIG_INVALID, 'exchange rate config missing');
    }
    const net = BigInt(request.netCnyFen);
    // 门槛纯函数（domain/rules.ts；折金币 ≥ 1000 且整数倍，fee 不计入门槛）。
    assertWithdrawalNetCny(net, rate);
    const feeRateBps = WITHDRAWAL_FEE_BPS;
    const minimumNetCnyFen = this.minimumNetCnyFen(rate);
    return createWithdrawalQuote({
      payoutAccountId: account.id,
      payoutAccountLabel: account.maskedLabel,
      maskedAccount: account.maskedLabel,
      netCnyFen: net,
      feeRateBps,
      minimumNetCnyFen,
      quotedAt: this.clock.now(),
    });
  }

  /** 提交（单事务）：流水/身份门禁 → 报价复核 → 占款三分录 + hold + withdrawal + outbox。 */
  async create(userId: string, input: CreateWithdrawalInput): Promise<CreateWithdrawalResult> {
    const { request, tx, outbox } = input;
    if (!Value.Check(CreateWithdrawalRequestSchema, request)) {
      throw new PaymentDomainError(P.WITHDRAWAL_CONFIG_INVALID, 'create withdrawal request schema failed');
    }
    const quote = request.quote;
    const rate = await this.config.readExchangeRate(tx);
    if (rate === null) {
      throw new PaymentDomainError(P.WITHDRAWAL_CONFIG_INVALID, 'exchange rate config missing at commit');
    }
    const net = BigInt(quote.netCnyFen);
    const fee = withdrawalFeeOf(net);
    const debit = net + fee;

    // 1) 流水门禁（§5.1 "最后一步服务端校验"；未过 → 不占款、不建 withdrawal）。
    await this.turnoverGate.assertTransferAllowed(userId, tx);

    // 2) 身份三选一（双资产文档 §5；未满足 → INVALID_PAYOUT_ACCOUNT 语义映射，
    // 登记决策点：contracts 无身份未验证专码）。
    const user = await this.identity.readUser(userId, tx);
    if (user === null || user.status !== 1) {
      throw new PaymentDomainError(P.INVALID_PAYOUT_ACCOUNT, 'user not found or inactive');
    }
    if (!identitySatisfied(user)) {
      throw new PaymentDomainError(P.INVALID_PAYOUT_ACCOUNT, 'identity verification not satisfied (email/phone/username+password)');
    }

    // 3) 锁定收款账户版本（§4 "提现固定所选账户版本"；缺失/非本人 → NOT_FOUND）。
    const account = await this.payoutAccounts.lockByPk(quote.payoutAccountId, tx);
    if (account.userId !== userId) {
      throw new PaymentDomainError(P.PAYOUT_ACCOUNT_NOT_FOUND, 'payout account not owned by user');
    }

    // 4) 报价复核（过期/费率变化 → 重新报价，§2 "配置变化须重新报价"；
    // domain `withdrawalQuoteMatches` 纯函数校验费率/门槛/金额一致性）。
    const minimumNetCnyFen = this.minimumNetCnyFen(rate);
    if (new Date(quote.expiresAt).getTime() <= this.clock.now().getTime()) {
      throw new PaymentDomainError(P.WITHDRAWAL_QUOTE_EXPIRED, 'withdrawal quote expired');
    }
    if (!withdrawalQuoteMatches(quote, WITHDRAWAL_FEE_BPS, minimumNetCnyFen)) {
      throw new PaymentDomainError(P.WITHDRAWAL_QUOTE_CHANGED, 'withdrawal quote changed; re-quote required');
    }
    // 门槛复核（净到账折金币 ≥ 1000 且整数倍，锁内重读汇率，防报价后配置变化；
    // 双资产文档 §5.1 "创建提现的原子事务再次校验"同款纪律）。
    assertWithdrawalNetCny(net, rate);

    // 5) 幂等抢键（WITHDRAWAL_HOLD=6；U(withdrawal_key) + operation_key 双兜底）。
    const withdrawalKey = `wd:${userId}:${request.idempotencyKey}`;
    const requestHash = requestHashOf({
      userId,
      payoutAccountId: quote.payoutAccountId,
      net: quote.netCnyFen,
      fee: fee.toString(),
      rate: { coinUnits: rate.rateCoinUnits.toString(), cashFen: rate.rateCashFen.toString() },
    });
    const claimed = await this.ledger.claimOperation({
      operationKey: withdrawalKey,
      operationType: AssetOperationType.WITHDRAWAL_HOLD,
      requestHash,
      initiatedByUserId: userId,
      extra: {
        netCnyFen: net.toString(),
        feeCnyFen: fee.toString(),
        debitCnyFen: debit.toString(),
        payoutAccountId: quote.payoutAccountId,
        rate: { coinUnits: rate.rateCoinUnits.toString(), cashFen: rate.rateCashFen.toString() },
        coinEquivalent: quote.minimumNetCnyFen,
      },
      reason: 'withdrawal request hold',
      tx,
    });
    if (!claimed.inserted) {
      // 重放既有占款（U(withdrawal_key) 命中 = 同键同内容重放，静默返回原结果）。
      const snapshot = await this.ledger.getOperationResultSnapshot(claimed.operation.id, tx);
      if (snapshot === null) {
        throw new PaymentDomainError(P.WALLET_STORAGE_UNAVAILABLE, 'withdrawal replay without result snapshot');
      }
      const s = snapshot as Partial<WithdrawalDto> & { withdrawalId: string };
      const dto: WithdrawalDto = {
        withdrawalId: s.withdrawalId ?? '0',
        payoutAccountId: quote.payoutAccountId,
        payoutAccountLabel: (s.payoutAccountLabel as string | undefined) ?? account.maskedLabel,
        maskedAccount: (s.maskedAccount as string | undefined) ?? account.maskedLabel,
        netCnyFen: net.toString(),
        feeCnyFen: fee.toString(),
        debitCnyFen: debit.toString(),
        status: ((s.status as number | undefined) ?? WithdrawalStatus.REQUESTED) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
        payoutNotBeforeAt: (s.payoutNotBeforeAt as string | undefined) ?? toDateIso(this.clock.now()),
        createdAt: (s.createdAt as string | undefined) ?? toDateIso(this.clock.now()),
      };
      return { dto, inserted: false };
    }
    const operationId = claimed.operation.id;

    // 6) 锁账户（用户 CNY → 系统 CNY；asset_account.id 升序，§4 锁顺序）。
    const userCny = await this.ledger.readAccount(userId, AssetType.CNY_BALANCE, AccountType.PLAYER, tx);
    const systemCny = await this.ledger.readAccount(this.systemIdentity.systemUserId, AssetType.CNY_BALANCE, AccountType.SYSTEM, tx);
    if (userCny === null || systemCny === null) {
      throw new PaymentDomainError(P.WALLET_STORAGE_UNAVAILABLE, 'asset account not provisioned for withdrawal');
    }
    const lockIds = [userCny.id, systemCny.id].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    await this.ledger.lockAccountsByIds(lockIds, tx);

    // 7) 余额门禁（用户 CNY 可用 ≥ 净+费；AGENTS.md "玩家资产不可透支"，
    // 冻结计入占用——此处占款即将把 debit 从 available 转入 frozen）。
    const userAvailable = BigInt(userCny.amount) - BigInt(userCny.frozenAmount);
    if (userAvailable < debit) {
      throw new PaymentDomainError(P.INSUFFICIENT_AVAILABLE_BALANCE, 'insufficient available CNY for withdrawal');
    }

    // 8) 占款三分录 + asset_hold（WITHDRAWAL_HOLD=6；用户 CNY -debit/frozen+debit，
    // 系统 CNY +debit，hold 行 amount=remaining=debit；双资产文档 §4 "申请时原子
    // 占款 净到账额 + 手续费"）。
    const holdKey = `hold:withdrawal:${withdrawalKey}`;
    const intents: EntryIntent[] = [
      {
        accountId: userCny.id,
        delta: 0n,
        frozenDelta: debit,
        entryType: WalletEntryType.HOLD, // 占款分录（HOLD=3，models/wallet.ts EntryType；
        // 冻结计入占用，总额不变——双资产文档 §5.1 "冻结仅反映在 frozenAmount"）
        memo: `withdrawal hold: +${debit} fen frozen (net ${net} + fee ${fee})`,
      },
      {
        accountId: systemCny.id,
        delta: debit,
        frozenDelta: 0n,
        entryType: WalletEntryType.EXTERNAL, // 系统 CNY 接收占款（外部资金归宿，§2）
        memo: `withdrawal hold in: +${debit} fen reserved for user ${userId}`,
      },
    ];
    await this.ledger.postEntries(operationId, intents, tx);

    const hold = await this.ledger.createHold({
      assetOperationId: operationId,
      assetAccountId: userCny.id,
      holdKey,
      holdType: HoldType.WITHDRAWAL,
      amount: debit.toString(),
      tx,
    });

    // 9) withdrawal 行（REQUESTED=1 + payout_not_before_at=+72h，U(withdrawal_key)）。
    const payoutNotBeforeAt = new Date(this.clock.now().getTime() + WITHDRAWAL_DELAY_HOURS * 3_600_000);
    const minimumCoins = '1000'; // 最小金币等值快照（DEFAULT_MINIMUM_WITHDRAWAL_COINS）
    const coinEquivalent = assertWithdrawalNetCny(net, rate).coinEquivalent; // 净到账折金币等值（门槛校验产物）
    const created = await this.withdrawals.createWithdrawal({
      userId,
      withdrawalKey,
      payoutAccountId: account.id,
      assetOperationId: operationId,
      assetHoldId: hold.hold.id,
      cashCents: net.toString(),
      feeCents: fee.toString(),
      coinEquivalent: coinEquivalent.toString(),
      minimumCoins: minimumCoins,
      policySnapshot: {
        identity: 'satisfied',
        turnover: 'complete',
        feeRateBps: WITHDRAWAL_FEE_BPS,
        rate: { coinUnits: rate.rateCoinUnits.toString(), cashFen: rate.rateCashFen.toString() },
      },
      payoutNotBeforeAt,
      tx,
    });
    if (!created.inserted) {
      throw new PaymentDomainError(P.IDEMPOTENCY_KEY_REUSED, 'withdrawal_key conflict within new operation');
    }

    // 10) 快照回填 + outbox 同事务（§6.3）。
    const result: WithdrawalDto = {
      withdrawalId: created.withdrawal.id,
      payoutAccountId: account.id,
      payoutAccountLabel: account.maskedLabel,
      maskedAccount: account.maskedLabel,
      netCnyFen: net.toString(),
      feeCnyFen: fee.toString(),
      debitCnyFen: debit.toString(),
      status: WithdrawalStatus.REQUESTED,
      payoutNotBeforeAt: toDateIso(payoutNotBeforeAt),
      createdAt: toDateIso(this.clock.now()),
    };
    await this.ledger.setCommitted(operationId, this.clock.now(), { ...result }, tx);
    await outbox.append({
      topic: 'payments.withdrawal.requested',
      userId,
      assetOperationId: operationId,
      payload: {
        withdrawalId: created.withdrawal.id,
        netCnyFen: net.toString(),
        feeCnyFen: fee.toString(),
        debitCnyFen: debit.toString(),
      },
    });

    return { dto: result, inserted: true };
  }

  /** 门槛折算最低净到账分（1000 枚等值；双资产文档 §4 "默认 1000 金币按配置比例
   * 折为最低人民币净到账额"，fee 不计入门槛）。 */
  private minimumNetCnyFen(rate: { rateCoinUnits: bigint; rateCashFen: bigint }): bigint {
    const minCoins = 1_000n;
    const numerator = minCoins * rate.rateCashFen;
    return numerator / rate.rateCoinUnits;
  }
}
