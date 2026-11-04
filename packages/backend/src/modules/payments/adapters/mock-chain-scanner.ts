/**
 * 链到账扫描端口 Mock 实现（首版返回空数组，真实 TRON RPC 扫描未闭环）。
 *
 * 领域所有者：payments 模块（worker 入口注入；测试可替换为 fixture 实现）。
 * 对应 SDD 章节：后端实施 SDD §9 第 3 步（"链到账 worker"）、附录 A.4
 * （chain_deposit_event SEEN/CONFIRMING 行读取）；双资产文档 §5 "USDT 自建
 * TRON/TRC-20"。
 *
 * 未闭环登记（完成报告给 Lead）：
 * - 真实 TRON 扫描器（区块轮询 + TRC-20 Transfer 事件解码 + 确认数判定 +
 *   reorg 回滚 REORGED=7）随 §6.3 outbox worker 同批落地；本 Mock 保持
 *   空实现使 worker 入口可编译、可测试（fixture 注入候选行验证匹配路径）。
 * - 扫描租约（chain_scan_cursor fencing_token 接管）本首版不使用，真实
 *   扫描器落地时经本端口 `tx` 参数同事务读候选（防扫描/履约窗口错账）。
 */

import type { ChainScannerPort, ChainDepositCandidate } from '../ports/chain-scan-port.js';

export class MockChainScanner implements ChainScannerPort {
  async listPendingDeposits(_chainCode: string, _sinceHeight: string, _tx?: unknown): Promise<ChainDepositCandidate[]> {
    // 首版 Mock：无真实链上事实，返回空数组（登记"真实 TRON 扫描未闭环"）。
    return [];
  }
}
