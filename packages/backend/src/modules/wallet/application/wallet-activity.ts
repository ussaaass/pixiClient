/**
 * GET /me/wallet/activity 用例（asset_entry 分页；游标 `created_at ISO~entry_id`）。
 *
 * 领域所有者：wallet 模块（auth wallet.activity）。
 * 对应 SDD 章节：后端实施 SDD §5.4（me/wallet/activity，契约已有 handler 新实现）、
 * 附录 A.3（asset_entry `entry_seq` 与 `U(asset_operation_id, entry_seq)`、
 * `ix_asset_entry_account_created` 索引）；双资产文档 §2（不可变分录投影，
 * deleted_at 恒 NULL，无软删路径）。
 *
 * 分页约定（cursor 契约 `WalletActivityCursorSchema`，§A.3 entry_seq 语义）：
 * - cursor = `${operation.created_at ISO 毫秒}~${entry.id}`；查询按
 *   `(asset_account_id IN 玩家账户, created_at < cursorTime OR (== 且 id < cursorId))`
 *   倒序；首页 cursor = null；页大小上限 50（contracts maxItems=50）。
 * - 只投影玩家本人两账户（COI/CNY）的分录；系统账户侧分录不在玩家活动流展示
 *   （守恒边界分开，双资产文档 §2；系统侧走 Admin 查询，登记决策点）。
 * - activityType 推导限定 1~3/5/12/14 类型（其余 operation_type 不进玩家流）。
 *
 * 错误码映射（contracts `WalletErrorCode` → 触发条件）：
 * - `WALLET_STORAGE_UNAVAILABLE`：Sequelize 故障 / 游标格式非法（cursor 解析
 *   失败 = 客户端状态异常，按存储不可用处理，客户端应丢弃游标重拉首页）。
 * - 成功 → WalletActivityResponseDto（200；空页 = items [] + nextCursor null）。
 */

import { Op, type Transaction } from 'sequelize';
import type { WalletActivityCursorDto, WalletActivityResponseDto } from '@gameing/contracts/wallet';
import { AssetEntryModel, AssetOperationModel, AssetAccountModel } from '../../../infrastructure/database/models/wallet.js';
import { ActiveStatus, RecordStatus } from '../../../infrastructure/database/models/wallet.js';
import type { AssetLedger, WalletContext } from '../ports/wallet-repository.js';
import type { Tx } from '../ports/wallet-repository.js';
import { toActivityPage, buildActivityCursor } from '../adapters/row-mappers.js';
import { WalletDomainError, W } from '../domain/errors.js';

const PAGE_SIZE = 50; // contracts `WalletActivityResponseSchema` items maxItems=50

/** 玩家活动流投影的操作类型（1~3 用户侧 + 5/12/14 待落地类型预留；
 * 其余 operation_type（2=兑换的 CNY 侧、系统侧分录）不在玩家流重复展示）。 */
const PROJECTED_OPERATION_TYPES: number[] = [1, 3, 5, 12, 14];

/** 游标解析（`created_at ISO~entry_id`；格式非法抛 WALLET_STORAGE_UNAVAILABLE）。 */
function parseCursor(cursor: WalletActivityCursorDto): { occurredBefore: Date; entryBeforeId: string } {
  const tilde = cursor.lastIndexOf('~');
  if (tilde <= 0) {
    throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, `invalid activity cursor: ${cursor}`);
  }
  const occurredIso = cursor.slice(0, tilde);
  const entryIdRaw = cursor.slice(tilde + 1);
  let entryId: bigint;
  try {
    entryId = BigInt(entryIdRaw);
  } catch {
    throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, `invalid activity cursor entry id: ${cursor}`);
  }
  const occurredBefore = new Date(occurredIso);
  if (Number.isNaN(occurredBefore.getTime())) {
    throw new WalletDomainError(W.WALLET_STORAGE_UNAVAILABLE, `invalid activity cursor time: ${cursor}`);
  }
  return { occurredBefore, entryBeforeId: entryId.toString() };
}

export class WalletActivityUseCase {
  constructor(private readonly ledger: AssetLedger) {}

  /** 读用例（无锁；分页按玩家两账户倒序；同事务调用时传 tx）。 */
  async run(ctx: WalletContext, cursor: WalletActivityCursorDto | null | undefined, tx?: Tx): Promise<WalletActivityResponseDto> {
    const txq = (tx?.transaction ?? undefined) as Transaction | undefined;

    // 玩家本人账户 id（未开户 = 空列表，活动流为空页，非存储故障）。
    const accounts = await AssetAccountModel.findAll({
      where: { userId: ctx.userId, accountType: 1 /* AccountType.PLAYER */, status: ActiveStatus.ACTIVE },
      attributes: ['id'],
      transaction: txq as never,
    });
    const accountIds = accounts.map((a) => a.id);
    if (accountIds.length === 0) {
      // 未开户 → 空页（与 summary 用例的 WALLET_STORAGE_UNAVAILABLE 区分，
      // 活动流对未开户用户展示空列表即可，登记决策点）。
      return toActivityPage([], null);
    }

    let where: Record<string, unknown> = {
      assetAccountId: { [Op.in]: accountIds },
      status: RecordStatus.RECORDED,
    };
    if (cursor !== null && cursor !== undefined) {
      const { occurredBefore, entryBeforeId } = parseCursor(cursor);
      where = {
        ...where,
        [Op.or]: [
          { createdAt: { [Op.lt]: occurredBefore } },
          {
            createdAt: occurredBefore,
            id: { [Op.lt]: entryBeforeId },
          },
        ],
      };
    }

    const entries = await AssetEntryModel.findAll({
      where,
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: PAGE_SIZE + 1, // 多取一条判定是否有下一页
      transaction: txq as never,
    });

    const hasMore = entries.length > PAGE_SIZE;
    const page = hasMore ? entries.slice(0, PAGE_SIZE) : entries;

    // 分录 → 所属操作（activityType/extra 快照推导；批量 IN 读，避免 N+1）。
    // 仅取玩家流投影类型（PROJECTED_OPERATION_TYPES），系统侧/兑换 CNY 侧不投影。
    const opIds = [...new Set(page.map((e) => e.assetOperationId))];
    let operations = new Map<string, AssetOperationModel>();
    if (opIds.length > 0) {
      const ops = await AssetOperationModel.findAll({
        where: {
          id: { [Op.in]: opIds },
          operationType: { [Op.in]: PROJECTED_OPERATION_TYPES },
          status: RecordStatus.RECORDED,
        },
        transaction: txq as never,
      });
      operations = new Map(ops.map((o) => [o.id, o]));
    }

    const items = page.flatMap((entry) => {
      const operation = operations.get(entry.assetOperationId);
      if (operation === undefined) return [];
      return [{ entry, operation }];
    });

    let nextCursor: WalletActivityCursorDto | null = null;
    if (hasMore) {
      const last = page[page.length - 1];
      if (last !== undefined) {
        const op = operations.get(last.assetOperationId);
        if (op !== undefined) {
          nextCursor = buildActivityCursor(last, op.createdAt);
        }
      }
    }

    return toActivityPage(items, nextCursor);
  }
}
