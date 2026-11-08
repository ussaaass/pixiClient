/**
 * WELCOME_GIFT 赠币用例（实现 identity 模块 `WelcomeGiftPort` 接口；注册 workflow
 * 幂等调用，按账号一次）。
 *
 * 领域所有者：wallet 模块（gift_grant / turnover_state / asset_account 写入）。
 * 对应 SDD 章节：后端实施 SDD §9 第 1 步遗留 TODO（"WelcomeGiftPort 未实现，
 * 赠币属 wallet 模块"）、§4（幂等先抢唯一约束；所有分录/outbox 同事务）；
 * 双资产文档 §5（"已确定新用户首次赠币 1000 枚（默认 5 倍有效下注流水）、
 * 未完成流水禁转出"）；AGENTS.md 赠币规则（赠币与普通金币同钱包、同一玩法，
 * 赠送按配置加流水要求）。
 *
 * 用例语义（任务硬约定 6）：
 * - `grant_key = welcome:{userId}`（按账号一次；`gift_grant.U(grant_key)` 唯一
 *   约束幂等兜底，identity 注册 workflow 重复调用只生效一次）；
 * - 赠币数默认 1000 枚（双资产文档 §5 "新用户首次赠币 1000 枚"；可经配置注入，
 *   首版固定常量，决策点登记）；
 * - `turnover_multiplier` 默认 5（双资产文档 §5 "默认 5 倍有效下注流水"）；
 * - `required_turnover_coins = grantCoins * multiplier`（BigInt 精确计算）；
 * - `turnover_state` upsert：remaining_coins 累加（同一用户多次赠币场景，
 *   本用例按账号一次故只累加一次），version 乐观锁（A.3 约定）；
 * - 分录：玩家 COI +grantCoins；系统 COI -grantCoins（系统账户为资产来源，
 *   双资产文档 §2 / AGENTS.md "赠币……有对应系统分录"；系统金币发行余额
 *   可为负，AGENTS.md 硬约束）。
 *
 * 错误码映射（contracts `WalletErrorCode` → 触发条件）：
 * - `WALLET_STORAGE_UNAVAILABLE`：Sequelize 故障 / 玩家账户未开户 / 乐观
 *   version 冲突（可重试）/ 系统账户行缺失。
 * - 成功（无返回值；`WelcomeGiftPort.grantWelcomeGift(userId): Promise<void>`；
 *   重复调用 = 幂等静默成功，不抛 IDEMPOTENCY_KEY_REUSED——按账号一次是
 *   业务语义而非幂等键冲突，重复调用直接命中 U(grant_key)/operation_key
 *   后静默返回，不重复入账、不二次出款）。
 *
 * 事务模型（任务硬约定 2 "用例调用 sequelize.transaction"）：`grantWelcomeGift`
 * 自管事务（SDD §4 语义；identity 注册流首版以独立事务调用本用例，outbox
 * 行随本事务提交后由 worker 幂等重放，至少一次）。外层已持 tx 时经
 * `runInTx` 变体并入外层事务（未来 identity 注册流同事务挂接点，决策点登记）。
 */

import type { WelcomeGiftPort } from '../../identity/ports/welcome-gift-port.js';
import { requestHashOf, assertConservation, TURN_MULTIPLIER_DEFAULT, WELCOME_GIFT_COINS_DEFAULT } from '../domain/ledger-rules.js';
import { WalletDomainError, W } from '../domain/errors.js';
import type { AssetLedger, Tx, SystemIdentityPort, EntryIntent } from '../ports/wallet-repository.js';
import { WalletOperationType, WalletEntryType } from '../ports/wallet-repository.js';
import type { OutboxPort } from '../ports/outbox-port.js';
import type { Clock } from '../ports/clock.js';
import type { Sequelize } from 'sequelize';

/**
 * 新用户欢迎赠币用例。实现 identity `WelcomeGiftPort`（`grantWelcomeGift(userId)`
 * 按账号一次幂等）；装配时替换 identity 的 `welcomeGift: null`，打通 SDD §4
 * "注册 workflow 幂等调用新用户赠币"。
 */
export class GrantWelcomeGiftUseCase implements WelcomeGiftPort {
  constructor(
    private readonly ledger: AssetLedger,
    private readonly systemIdentity: SystemIdentityPort,
    private readonly clock: Clock,
    /** 无事务 outbox（`grantWelcomeGift` 自管事务内绑定 tx 的版本由装配层
     * outboxFor 提供；本字段为用例外兜底路径，与 identity 模块同款约定）。 */
    private readonly outbox: OutboxPort,
    private readonly sequelize: Sequelize,
  ) {}

  /** `WelcomeGiftPort` 契约实现：按账号一次（U(grant_key) 幂等兜底）。 */
  async grantWelcomeGift(userId: string, outerTx?: Tx, outbox: OutboxPort = this.outbox): Promise<void> {
    if (outerTx !== undefined) {
      await this.runCore(userId, outerTx, outbox);
      return;
    }
    await this.sequelize.transaction(async (txRaw) => {
      const tx: Tx = { transaction: txRaw };
      await this.runCore(userId, tx, outbox);
    });
  }

  /** 同事务变体（外层已持 tx 时调用；identity 注册流未来同事务挂接点）。 */
  async runInTx(userId: string, tx: Tx, outbox: OutboxPort = this.outbox): Promise<void> {
    await this.runCore(userId, tx, outbox);
  }

  private async runCore(userId: string, tx: Tx, outbox: OutboxPort = this.outbox): Promise<void> {
    const grantKey = `welcome:${userId}`;

    // 幂等前置（U(grant_key) 双保险；命中 = 已赠，静默返回，不重复入账）。
    const existing = await this.ledger.readWelcomeGift(userId, tx);
    if (existing !== null) return;

    // 系统/玩家账户定位（玩家 COI + 系统 COI；SYSTEM 行 user_id = 系统身份，
    // 全库唯一，0002 迁移 system_marker 约束）。
    const playerCoin = await this.ledger.readAccount(userId, 1, 1, tx);
    const systemCoin = await this.ledger.readAccount(this.systemIdentity.systemUserId, 1, 2, tx);
    if (playerCoin === null || systemCoin === null) {
      throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, 'asset account not provisioned for gift grant');
    }

    // 流水门槛与赠币入账无关（双资产文档 §5 "赠币与普通金币统一使用"；
    // 流水只限制转出/提现，见 turnover.ts 判定）。
    const coins = WELCOME_GIFT_COINS_DEFAULT;
    const multiplier = TURN_MULTIPLIER_DEFAULT;
    const requiredTurnoverCoins = coins * BigInt(multiplier);

    // 幂等抢键（operation_key 先抢；gift 无客户端幂等键，语义键 = grant_key）。
    const operationKey = `gift:${grantKey}`;
    const requestHash = requestHashOf({ grantKey, userId, coins: coins.toString(), multiplier: multiplier.toString() });
    const claimed = await this.ledger.claimOperation({
      operationKey,
      operationType: WalletOperationType.GIFT_GRANT,
      requestHash,
      initiatedByUserId: userId,
      extra: { grantKey, coins: coins.toString(), turnoverMultiplier: multiplier.toString() },
      reason: 'welcome gift grant (registration workflow, once per account)',
      tx,
    });
    if (!claimed.inserted) {
      // 命中已提交赠币操作 = 幂等静默成功（按账号一次；重查原结果不产生第二笔）。
      return;
    }
    const operationId = claimed.operation.id;

    // 锁账户（玩家 COI → 系统 COI；按 asset_account.id 数值升序，§4 锁顺序）。
    const lockIds = [playerCoin.id, systemCoin.id].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    await this.ledger.lockAccountsByIds(lockIds, tx);

    // 分录（玩家 +coins / 系统 -coins；系统金币发行余额可为负，AGENTS.md）。
    const intents: EntryIntent[] = [
      {
        accountId: playerCoin.id,
        delta: coins,
        frozenDelta: 0n,
        entryType: WalletEntryType.INTERNAL,
        memo: `welcome gift grant: +${coins} coins (grant_key ${grantKey})`,
      },
      {
        accountId: systemCoin.id,
        delta: -coins,
        frozenDelta: 0n,
        entryType: WalletEntryType.INTERNAL,
        memo: `welcome gift issue: -${coins} coins to user ${userId} (system issuance, may go negative)`,
      },
    ];
    const posts = await this.ledger.postEntries(operationId, intents, tx);
    assertConservation(posts, 0n);

    // gift_grant 快照（不可变；U(grant_key) 兜底由 adapter `appendGiftGrant`
    // 处理：并发同键命中时返回既有行，用例静默成功）。
    await this.ledger.appendGiftGrant({
      userId,
      assetOperationId: operationId,
      orderId: null, // WELCOME_GIFT 非商品附赠（order_id NULL；双资产文档 §5 注册赠币）
      grantKey,
      coins,
      turnoverMultiplier: multiplier.toString(),
      requiredTurnoverCoins,
      tx,
    });

    // turnover_state upsert（remaining_coins 累加 required，version 乐观锁；
    // 任务硬约定 6）。
    const prior = await this.ledger.readTurnoverState(userId, tx);
    const expectedVersion = prior === null ? null : BigInt(prior.version);
    await this.ledger.upsertTurnoverState(userId, requiredTurnoverCoins, expectedVersion, tx);

    // 快照回填 + outbox 同事务（§6.3 "所有分录/outbox 同事务"；赠币事件通知玩家）。
    const committedAt = this.clock.now();
    await this.ledger.setCommitted(
      operationId,
      committedAt,
      {
        grantKey,
        coins: coins.toString(),
        turnoverMultiplier: multiplier.toString(),
        requiredTurnoverCoins: requiredTurnoverCoins.toString(),
      },
      tx,
    );
    await outbox.append({
      topic: 'wallet.gift-grant',
      userId,
      assetOperationId: operationId,
      payload: {
        operationId,
        grantKey,
        coins: coins.toString(),
        requiredTurnoverCoins: requiredTurnoverCoins.toString(),
      },
    });
  }
}
