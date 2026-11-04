/**
 * 收款账户管理用例：GET/POST/DELETE /me/wallet/payout-accounts。
 *
 * 领域所有者：payments 模块（payout_account 版本行 CRUD；敏感字段受控存储）。
 * 对应 SDD 章节：后端实施 SDD §5.4（payoutAccounts 端点，契约
 * `WalletEndpoint.payoutAccounts/createPayoutAccount/deletePayoutAccount`）、
 * §9 第 3 步（支付与提现）、§10（金额/ID wire 十进制字符串）；双资产文档
 * §4（"payout_account 保存用户提交的收款账户和渠道信息，敏感字段受控存储
 * 并在界面脱敏；提现固定所选账户版本，处理中修改账户不更改当前出款目标"）、
 * §5.1（"持久化收款方式名称和末四位，不采集或保存真实支付账号"——离线
 * 切片口径，服务端首版 KMS 未闭环）。
 *
 * 用例语义：
 * - list（无事务）：用户有效收款账户版本（ActiveStatus=ACTIVE=1；按 version
 *   降序，§4 "资料变化新增版本，不覆盖处理中出款目标"）。
 * - create（单事务）：
 *   1. 账户规范化（`normalizePayoutAccount`：methodType + 收款引用字符串）；
 *   2. 生成 account_key UUID（CHAR(36) 稳定定位值）+ version=1（首版）；
 *   3. lookup_hash = sha256(normalizedCiphertext)（BINARY(32)，供查询和
 *      去重，双资产文档 §4 "同资料不重复建版本"——create 幂等去重经
 *      PayoutAccountRepository.lookupHash）；
 *   4. masked_label = 末 4 位脱敏（§5.1 "持久化收款方式名称和末四位"）；
 *   5. 敏感字段明文存 account_ciphertext 列（VARBINARY(8192)；KMS 加密
 *      未闭环，首版存规范化明文的 base64，登记决策点——真实 KMS 落地后
 *      本列改存密文，model 保持二进制原样口径不变）。
 * - delete（单事务）：软删（status → RETIRED=3；§4 "处理中出款目标不受影响
 *   ——withdrawal 已固定 payout_account.id 版本行"，不物理删除，登记
 *   decision point：deleted_at 与 status 双标记，迁移 CHECK 约束）。
 *
 * 错误码映射（contracts `WalletErrorCode` 子集 → 触发条件）：
 * - `PAYOUT_ACCOUNT_NOT_FOUND`：delete 目标行缺失/软删/非本人。
 * - `INVALID_PAYOUT_ACCOUNT`：create 请求 schema 校验失败（methodType 不在
 *   PayoutChannelType 值集 / accountReference 空 / 长度越界）。
 * - `WALLET_STORAGE_UNAVAILABLE`：Sequelize 故障（可重试）。
 * - 成功 → PayoutAccountDto（create 201；list 200；delete 200 `{deleted:true}`）。
 */

import type { PayoutAccountDto, CreatePayoutAccountRequestDto } from '@gameing/contracts/wallet';
import { PayoutChannelType, Value, CreatePayoutAccountRequestSchema } from '@gameing/contracts/wallet';
import { PaymentDomainError, P } from '../domain/errors.js';
import type { PayoutAccountRepository, Tx } from '../ports/payments-repository.js';
import { toDateIso } from '../../wallet/adapters/row-mappers.js';
import { createHash, randomUUID } from 'node:crypto';

export interface PayoutAccountCreateInput {
  userId: string;
  request: CreatePayoutAccountRequestDto;
  tx: Tx;
}

export interface PayoutAccountDeleteInput {
  userId: string;
  payoutAccountId: string;
  tx: Tx;
}

/** 收款账户规范化视图（create 入参归一 + lookup_hash 派生源）。 */
export function normalizePayoutAccount(input: { channelType: number; accountLabel: string; accountReference: string }): {
  normalized: string;
  methodType: number;
  maskedLabel: string;
} {
  // 规范化：channelType + 大写去空格账号引用（lookup_hash 派生源；同资料
  // 不同大小写/空白视为同一账户，双资产文档 §4 "资料变化新增版本"语义边界）。
  const methodType = input.channelType;
  const normalized = `${methodType}:${input.accountReference.trim().toUpperCase()}`;
  // 末 4 位脱敏（§5.1 "持久化收款方式名称和末四位"；accountLabel 承载渠道
  // 名称，maskedLabel = 渠道名 + 末 4 位，界面脱敏口径）。
  const ref = input.accountReference.trim();
  const suffix = ref.slice(-4);
  const maskedLabel = `${input.accountLabel} ${suffix}`.slice(0, 48);
  return { normalized, methodType, maskedLabel };
}

export class PayoutAccountUseCase {
  constructor(private readonly payoutAccounts: PayoutAccountRepository) {}

  /** 列出用户有效收款账户版本（version 降序；list 端点 200）。 */
  async list(userId: string): Promise<PayoutAccountDto[]> {
    const rows = await this.payoutAccounts.listByUser(userId);
    return rows.map((r) => this.toDto(r));
  }

  /**
   * 创建收款账户（account_key UUID + version 1 + lookup_hash sha256 去重；
   * 敏感字段明文存 account_ciphertext，KMS 未闭环登记）。
   */
  async create(input: PayoutAccountCreateInput): Promise<{ dto: PayoutAccountDto; inserted: boolean }> {
    const { userId, request, tx } = input;
    if (!Value.Check(CreatePayoutAccountRequestSchema, request)) {
      throw new PaymentDomainError(P.INVALID_PAYOUT_ACCOUNT, 'create payout account request schema failed');
    }
    const methodType = request.channelType as 1 | 2 | 3 | 4 | 5;
    // methodType 值集校验（PayoutChannelType 常量 1~5，contracts 单一来源）。
    const validMethods = Object.values(PayoutChannelType) as number[];
    if (!validMethods.includes(methodType)) {
      throw new PaymentDomainError(P.INVALID_PAYOUT_ACCOUNT, `unsupported payout channel type: ${methodType}`);
    }
    const norm = normalizePayoutAccount({
      channelType: methodType,
      accountLabel: request.accountLabel,
      accountReference: request.accountReference,
    });

    // lookup_hash = sha256(规范化资料)（BINARY(32)；同资料不重复建版本，§4）。
    const lookupHash = createHash('sha256').update(norm.normalized).digest();
    // 敏感字段首版明文 base64（KMS 未闭环，登记决策点；model 保持二进制原样）。
    const ciphertext = new Uint8Array(Buffer.from(request.accountReference.trim(), 'utf-8'));
    // account_key UUID（CHAR(36) 稳定定位值；用例层生成，adapter 落库）。
    const accountKey = randomUUID();

    const created = await this.payoutAccounts.create({
      userId,
      accountKey,
      methodType,
      accountCiphertext: ciphertext,
      lookupHash,
      maskedLabel: norm.maskedLabel,
      tx,
    });

    return { dto: this.toDto(created.account), inserted: created.inserted };
  }

  /** 软删收款账户（status → RETIRED=3；处理中出款目标不受影响，§4）。 */
  async remove(input: PayoutAccountDeleteInput): Promise<{ deleted: boolean }> {
    const { userId, payoutAccountId, tx } = input;
    const affected = await this.payoutAccounts.softDelete(payoutAccountId, userId, tx);
    if (affected === 0) {
      // 行缺失 / 已软删 / 非本人 → NOT_FOUND（幂等：已删重放 = deleted false，
      // 路由层 404 vs 200 语义登记 decision point）。
      throw new PaymentDomainError(P.PAYOUT_ACCOUNT_NOT_FOUND, `payout account not found or already deleted: ${payoutAccountId}`);
    }
    return { deleted: true };
  }

  private toDto(row: { id: string; methodType: number; maskedLabel: string; status: number; createdAt: Date | string }): PayoutAccountDto {
    return {
      payoutAccountId: row.id,
      channelType: row.methodType as PayoutAccountDto['channelType'],
      accountLabel: row.maskedLabel,
      maskedAccount: row.maskedLabel,
      isDefault: false, // 首版无默认账户概念（contracts schema 保留字段，登记）
      status: 1, // PayoutAccountSchema.status 字面量 1（ACTIVE），软删行不进入 list
      createdAt: toDateIso(row.createdAt),
    };
  }
}
