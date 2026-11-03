/**
 * wallet row-mappers（model 行 → contracts DTO；跨层 wire 格式化归本层）。
 *
 * 领域所有者：wallet 模块（SDD §2 第 2 条："DTO 映射层（adapter 的 row-mapper）
 * 把 ID/金额转十进制字符串，禁止 JS number 跨越 Number.MAX_SAFE_INTEGER"；
 * "金额、概率、时间、状态等业务转换归属领域"——本文件只做行→DTO 形状映射，
 * 业务判定（流水/门禁）在 application/domain 层，不在 mapper）。
 * 对应 SDD 章节：后端实施 SDD §5.4（wallet 端点响应 schema 一律引用
 * `@gameing/contracts/wallet`，不手写第二套 DTO）；附录 A.3（wallet 7 model）。
 *
 * 约定：
 * - 金额/ID 一律十进制字符串（Sequelize BIGINT 回读值已是 string，
 *   `toBigIntWire` 做归一 + 符号保留，BigInt 入参直接 `.toString()`）；
 * - 不可变分录 `createdAt` = 发生时间（updated_at 恒等于 created_at，
 *   A.12 第 3 条），wire 为 ISO 毫秒（contracts schema pattern 约束）；
 * - activityType 推导读 `asset_operation.extra.direction`（转账 SENT/RECEIVED
 *   分流；分录账户所属方向由用例写 extra 快照，§4 "幂等先抢操作键时落
 *   extra 不可变细节"）。
 */

import type {
  AssetAccountModel,
  AssetEntryModel,
  AssetOperationModel,
  TurnoverStateModel,
} from '../../../infrastructure/database/models/wallet.js';
import { AssetType } from '../../../infrastructure/database/models/wallet.js';
import type {
  WalletAssetSummaryDto,
  WalletActivityItemDto,
  WalletSummaryResponseDto,
  WalletActivityCursorDto,
  WalletActivityResponseDto,
} from '@gameing/contracts/wallet';
import { WalletActivityType } from '@gameing/contracts/wallet';
import type { TurnoverState } from '../ports/wallet-repository.js';

/** BIGINT wire 归一：Sequelize 回读值（string | number | null）→ 十进制字符串。 */
export function toBigIntWire(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '0';
  return BigInt(value).toString();
}

/** 账户行 → WalletAssetSummaryDto（amount/frozen/available/version 全字符串 wire）。 */
export function toAssetSummary(account: AssetAccountModel): WalletAssetSummaryDto {
  const amount = BigInt(account.amount);
  const frozen = BigInt(account.frozenAmount);
  // assetType：model 侧为 number，DTO 契约为字面量 1|2（WalletAssetType.COIN/CNY_BALANCE）。
  const assetType: 1 | 2 = account.assetType === AssetType.CNY_BALANCE ? 2 : 1;
  return {
    assetType,
    currency: assetType === 1 ? 'COIN' : 'CNY',
    amount: amount.toString(),
    frozenAmount: frozen.toString(),
    availableAmount: (amount - frozen).toString(),
    // version 为 BIGINT UNSIGNED（CHECK >=1）；summary schema 要求 Integer，
    // 账户生命周期内版本号不超 JS 安全整数（对账上限远小于 2^53，决策点登记）。
    version: Number(BigInt(account.version)),
  };
}

/**
 * 账户活动列表行（assets 两行 + turnover 判定 + 欢迎赠币段）。
 * `turnover` 入参为 `turnover_state` 判定结果（无行 = 无流水要求 = 可转可提）。
 */
export function toWalletSummary(
  accounts: Array<AssetAccountModel>,
  turnover: TurnoverState | null,
  welcomeGift: { coins: string; turnoverRequirement: string } | null,
): WalletSummaryResponseDto {
  return {
    assets: accounts.map(toAssetSummary),
    turnover:
      turnover === null
        ? { remainingCoins: '0', canTransferOrWithdraw: true }
        : { remainingCoins: turnover.remainingCoins, canTransferOrWithdraw: turnover.canTransferOrWithdraw },
    welcomeGift,
  };
}

/** 分录行 → WalletActivityItemDto（activityType 由 operation.operation_type + extra.direction 推导）。 */
export function toActivityItem(entry: AssetEntryModel, operation: AssetOperationModel): WalletActivityItemDto {
  const assetType = operation.operationType === 2 ? AssetType.CNY_BALANCE : AssetType.COIN;
  // 注：operation_type 1=TRANSFER / 3=GIFT_GRANT 的 COI 分录；2=COIN_EXCHANGE
  // 在用户 CNY 侧分录投影为 CURRENCY_EXCHANGE（金币侧同 operation，由金币分录
  // 行承载 CURRENCY_EXCHANGE，CNY 侧行同 operation 同事件，仅展示一条——
  // 用例层按 operation 去重时取金币侧，登记决策点）。
  const currency = assetType === AssetType.COIN ? 'COIN' : 'CNY';
  const item: WalletActivityItemDto = {
    entryId: toBigIntWire(entry.id),
    operationId: toBigIntWire(entry.assetOperationId),
    activityType: operationToActivityType(operation),
    assetType,
    currency,
    delta: entry.delta,
    balanceAfter: entry.amountAfter,
    occurredAt: toDateIso(entry.createdAt),
  };
  const optional: Partial<WalletActivityItemDto> = {};
  if (entry.frozenDelta !== '0') {
    optional.frozenDelta = entry.frozenDelta;
  }
  const extra: Record<string, unknown> = operation.extra ?? {};
  if (operation.operationType === 1) {
    // TRANSFER=1：extra 快照 { coins, feeCoins, counterpartyLabel, direction }
    optional.transferCoins = toBigIntWire((extra.coins as string | number | null | undefined) ?? '0');
    optional.feeCoins = toBigIntWire((extra.feeCoins as string | number | null | undefined) ?? '0');
    const label = extra.counterpartyLabel;
    if (typeof label === 'string') optional.counterpartyLabel = label;
  }
  if (operation.operationType === 2) {
    optional.exchangeCoins = toBigIntWire((extra.coins as string | number | null | undefined) ?? '0');
    optional.exchangeCnyFen = toBigIntWire((extra.cnyFen as string | number | null | undefined) ?? '0');
  }
  return { ...item, ...optional };
}

/** operation_type → WalletActivityType（constants/枚举非零，0 不占位）：
 * 1=TRANSFER→按 extra.direction 分 SENT=2/RECEIVED=3；2=COIN_EXCHANGE→4；
 * 3=GIFT_GRANT→WELCOME_GIFT=1；5=ORDER_FULFILLMENT→PAYMENT_PURCHASE=5；
 * 12=COIN_MARKET_HOLD→6；14=COIN_MARKET_RELEASE→7（model 文件
 * AssetOperationType 常量，SDD §3 "常量随 model 文件本地登记"）。 */
function operationToActivityType(operation: AssetOperationModel): WalletActivityItemDto['activityType'] {
  const direction = (operation.extra as { direction?: 'SENT' | 'RECEIVED' } | null)?.direction;
  switch (operation.operationType) {
    case 1:
      return direction === 'RECEIVED' ? WalletActivityType.TRANSFER_RECEIVED : WalletActivityType.TRANSFER_SENT;
    case 2:
      return WalletActivityType.CURRENCY_EXCHANGE;
    case 3:
      return WalletActivityType.WELCOME_GIFT;
    case 5:
      return WalletActivityType.PAYMENT_PURCHASE;
    case 12:
      return WalletActivityType.COIN_MARKET_HOLD;
    case 14:
      return WalletActivityType.COIN_MARKET_RELEASE;
    default:
      // 未知/后续 operation_type 不投影到玩家活动流（activity 用例 WHERE
      // 只取 1~3 类型；本兜底返回 TRANSFER_SENT 仅为类型封闭，实际不可达）。
      return WalletActivityType.TRANSFER_SENT;
  }
}

/** 游标构造（`created_at ISO 毫秒~entry_id`，contracts `WalletActivityCursorSchema`）。 */
export function buildActivityCursor(entry: AssetEntryModel, occurredAt: Date | string): WalletActivityCursorDto {
  return `${toDateIso(occurredAt)}~${toBigIntWire(entry.id)}`;
}

/** 分页响应（nextCursor = 本批最后一条；末页 null，§5.4 activity 分页）。 */
export function toActivityPage(
  items: Array<{ entry: AssetEntryModel; operation: AssetOperationModel }>,
  nextCursor: WalletActivityCursorDto | null,
): WalletActivityResponseDto {
  return {
    items: items.map(({ entry, operation }) => toActivityItem(entry, operation)),
    nextCursor,
  };
}

/** DATETIME(3) → ISO 毫秒 wire（`yyyy-MM-ddTHH:mm:ss.sssZ`，schema pattern 约束）。 */
export function toDateIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

/** 流水行 → summary.turnover 段（remainingCoins wire + 门禁判定；无行 = 可转可提）。 */
export function toTurnoverView(state: TurnoverStateModel | null): TurnoverState {
  if (state === null) return { remainingCoins: '0', canTransferOrWithdraw: true };
  const remaining = BigInt(state.remainingCoins);
  return {
    remainingCoins: remaining.toString(),
    // remaining_coins > 0 → 未完成流水，禁止提现/转出（双资产文档 §2 / AGENTS.md）；
    // status COMPLETE=2 时也放行（已完成，remaining 应为 0，防御性双条件）。
    canTransferOrWithdraw: remaining === 0n || state.status === 2,
  };
}
