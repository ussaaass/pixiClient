/**
 * 链到账扫描端口（chain_deposit_event 发现/确认/匹配；首版 Mock 空实现）。
 *
 * 领域所有者：payments 模块（models/chain.ts 3 model 的扫描读侧；
 * 出款/履约写侧经 payment-event 用例，本端口只读候选行）。
 * 对应 SDD 章节：后端实施 SDD §9 第 3 步（"链到账 worker"）、附录 A.4
 * （chain_deposit_event `U(chain_code,tx_hash,event_index)` 去重）；
 * 双资产文档 §5 "USDT 自建 TRON/TRC-20"。
 *
 * 未闭环登记（首版 Mock 空实现，真实 TRON RPC 扫描未闭环）：
 * - `listPendingDeposits` 返回 `chain_deposit_event` 中 status = SEEN(1) /
 *   CONFIRMING(2) 的候选行（确认数/区块固化判定由真实扫描器写入）；
 * - 真实 TRON 网络扫描（区块轮询、TRC-20 Transfer 事件解码、确认数判定、
 *   reorg REORGED=7 回滚）待 §6.3 outbox worker 同批落地（worker 入口
 *   处理对账、失败恢复，SDD §9 第 3 步验收项）；
 * - 本端口出参 `ChainDepositCandidate` 与 models/chain.ts
 *   ChainDepositEventModel 行同构（wire 十进制字符串），适配器
 *   `sequelize-payments.ts` 实现读侧，`mock-chain-scanner.ts` 返回空数组。
 */

import type { Tx } from './payments-repository.js';

/** 链到账候选（chain_deposit_event SEEN/CONFIRMING 行；U(chain_code,tx_hash,event_index)）。 */
export interface ChainDepositCandidate {
  /** chain_deposit_event.id（十进制字符串 wire）。 */
  id: string;
  /** chain_address.id（十进制字符串 wire）。 */
  chainAddressId: string;
  /** 已匹配订单（MATCHED=4 时非空；SEEN/CONFIRMING 行 = null，待匹配）。 */
  orderId: string | null;
  chainCode: string;
  txHash: string;
  eventIndex: number;
  contractAddress: string;
  senderAddress: string;
  /** DECIMAL(36,0) wire：代币最小单位整数（USDT 分位 = 10^-18 缩放整数）。 */
  amountAtomic: string;
  tokenDecimals: number;
  blockHeight: string;
  blockHash: string;
  /** ChainDepositStatus：SEEN=1/CONFIRMING=2。 */
  status: number;
}

export interface ChainScannerPort {
  /**
   * 列出指定链码自 givenHeight 起待处理的到账候选（SEEN/CONFIRMING 行；
   * 首版 Mock 返回空数组——真实 TRON 扫描未闭环，注释登记）。
   * `tx` 可选：worker 同事务读取时传入，避免扫描与履约跨事务窗口。
   */
  listPendingDeposits(chainCode: string, sinceHeight: string, tx?: Tx): Promise<ChainDepositCandidate[]>;
}
