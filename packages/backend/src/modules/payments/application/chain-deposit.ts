/**
 * 链到账扫描用例（worker 入口；首版 Mock 空实现，真实 TRON RPC 扫描未闭环）。
 *
 * 领域所有者：payments 模块（chain_deposit_event 读侧 + 订单匹配履约，复用
 * payment-event 履约路径）。
 * 对应 SDD 章节：后端实施 SDD §9 第 3 步（"链到账 worker"）、附录 A.4
 * （chain_deposit_event `U(chain_code,tx_hash,event_index)` 去重）、§6.3
 * （outbox worker 同批落地）；双资产文档 §3（"经服务端验证的支付通知……
 * 持久化 payment_event 去重，再在受控事务内发放金币"）、§5（"USDT 自建
 * TRON/TRC-20"）。
 *
 * 用例语义（worker 单事务循环，首版 Mock 返回空数组）：
 * 1. 扫描候选（`ChainScannerPort.listPendingDeposits(chainCode, sinceHeight, tx)`
 *    → chain_deposit_event SEEN=1/CONFIRMING=2 行；Mock 恒返回 []，真实 TRON
 *    扫描（区块轮询 + TRC-20 Transfer 解码 + 确认数判定 + reorg REORGED=7）
 *    未闭环，登记）。
 * 2. 逐条匹配订单（U(chain_code,tx_hash,event_index) 去重——链上事实不重复
 *    履约，§10 红线）：
 *    - chain_address.order_id 定位订单（地址与订单一对一，models/chain.ts
 *      "超时/金额不符/无法唯一匹配时保留归属并转客服，不自动发币"）；
 *    - 金额换算（amountAtomic 按 tokenDecimals + 订单锁定 USDT 汇率折算
 *      CNY 分，双资产文档 §3 "跨币种实际支付先固定计价汇率版本"；首版
 *      无汇率采样任务，候选不触发履约，登记未闭环）。
 * 3. 复用 payment-event 履约路径（`PaymentEventUseCase.handle`，event_type
 *    记 CHAIN_DEPOSIT=4——constants 未注册，与 models/payments.ts
 *    PaymentEventType 注释值集对齐（CALLBACK=1/QUERY=2/RECONCILIATION=3，
 *    首版用 4 待 contracts 补，登记 decision point）；三分录 + external_
 *    settlement + outbox 同事务，"重复回调只发一次金币"红线经
 *    U(provider_id,event_key) + asset_operation claim 双兜底）。
 *
 * 错误码映射（复用 payment-event 用例 P 表；worker 自身无新码）：
 * - 候选缺失/订单未匹配 → 跳过不履约（转客服，不自动发币，models/chain.ts）；
 * - 履约阶段错误码 = payment-event.ts 头注释全表（NOT_FOUND / NOT_PAYABLE /
 *   EXPIRED / AMOUNT_MISMATCH / IDEMPOTENCY / W 码）。
 *
 * 注（任务登记）：本用例 + outbox worker + 真实 TRON 扫描同批落地（SDD §9
 * 第 3 步验收"链到账 worker"，§6.3 outbox worker 同批）；首版仅 Mock 空
 * 实现使模块可编译、可测试（测试 fixture 注入候选行验证匹配路径），Lead
 * 统一门禁时登记未闭环。
 *
 * outbox 注：本用例经 `module.withTx` 同事务版本调用（装配层 `outbox` 字段
 * 为无事务兜底；worker 调用方须先经 `outboxFor(module, tx)` 取同事务
 * outbox 传入，与 wallet submitInTx 同款约定，登记）。
 */

import type { OutboxPort, Tx } from '../ports/payments-repository.js';
import type { ChainDepositCandidate, ChainScannerPort } from '../ports/chain-scan-port.js';
import type { PaymentEventUseCase } from './payment-event.js';
export interface ScanChainDepositsInput {
  /** 链标识（TRON mainnet / testnet；chain_deposit_event.chain_code）。 */
  chainCode: string;
  /** 扫描起点高度（chain_scan_cursor.last_finalized_height，BIGINT wire）。 */
  sinceHeight: string;
  /** 同事务句柄（worker 经 sequelize.transaction 开启；outbox 经 outboxFor 绑定）。 */
  tx: Tx;
  /** 同事务 outbox（装配层 `outboxFor(module, tx)` 取得；§6.3 同事务）。 */
  outbox: OutboxPort;
}

export interface ScanChainDepositsResult {
  /** 本轮扫描到的候选行数（Mock 恒 0）。 */
  scanned: number;
  /** 成功履约行数（Mock 恒 0）。 */
  fulfilled: number;
  /** 未匹配/跳过行数（转客服不自动发币，models/chain.ts 语义）。 */
  unmatched: number;
}

/**
 * 链到账 worker 用例（首版 Mock 空实现；真实 TRON RPC 扫描未闭环，登记）。
 * 复用 payment-event 履约路径（三分录 + settlement + outbox 同事务，§6.3）。
 * 无独立状态（无锁、无时钟依赖），Mock 路径下 candidates 恒空，直接返回全 0。
 */
export class ScanChainDepositsUseCase {
  constructor(
    private readonly scanner: ChainScannerPort,
    private readonly paymentEvent: PaymentEventUseCase,
  ) {}

  /**
   * 扫描一轮（worker 定时调用）：listPendingDeposits → 逐条匹配 → 履约。
   * Mock scanner 返回空数组，本方法恒返回全 0（登记"真实 TRON 扫描未闭环"）。
   */
  async scan(input: ScanChainDepositsInput): Promise<ScanChainDepositsResult> {
    const candidates = await this.scanner.listPendingDeposits(input.chainCode, input.sinceHeight, input.tx);
    let fulfilled = 0;
    let unmatched = 0;

    for (const candidate of candidates) {
      // U(chain_code,tx_hash,event_index) 去重：已履约候选（MATCHED=4 行）
      // 由 scanner 过滤（listPendingDeposits 只返回 SEEN/CONFIRMING），此处
      // 二次确认 orderId 非空才履约（"无法唯一匹配时保留归属并转客服"）。
      const orderId = candidate.orderId;
      if (orderId === null) {
        // 未匹配订单（地址归属用户/订单缺失）→ 跳过不履约（转客服，登记）。
        unmatched += 1;
        continue;
      }

      // 金额换算（amountAtomic × 订单锁定 USDT 汇率 → CNY 分；首版无汇率
      // 采样任务，toCnyFen 返回 0 → payment-event 四匹配拒绝（实付 < 请求），
      // 不产生账本分录，"错额请求拒绝且不产生账本分录"，双资产文档 §5.2）。
      const paidCnyFen = this.toCnyFen(candidate);

      // 复用 payment-event 履约路径（event_type CHAIN_DEPOSIT=4 首版登记；
      // 三分录 + external_settlement + outbox 同事务，§6.3 同事务 outbox）。
      const result = await this.paymentEvent.handle({
        providerId: `chain:${input.chainCode}`, // 链事件 provider 定位（SELF_TRON=2 语义，登记）
        eventKey: `chain:${input.chainCode}:${candidate.txHash}:${candidate.eventIndex}`,
        eventType: 4, // CHAIN_DEPOSIT=4（constants 未注册，与 model 注释值集对齐，登记）
        orderId,
        paidCnyFen,
        currency: 'USDT',
        occurredAt: new Date(), // 首版 Mock 无候选时间戳，登记真实扫描器落地后补
        tx: input.tx,
        outbox: input.outbox,
      });
      if (result.fulfilled) fulfilled += 1;
    }

    return { scanned: candidates.length, fulfilled, unmatched };
  }

  /**
   * amountAtomic → CNY 分（USDT 10^-18 缩放；首版 Mock 无汇率采样任务，
   * 返回 0 使候选在四匹配阶段被拒绝——不触发履约，登记"真实 USDT 折算
   * 未闭环，随日更汇率采样任务 + 链确认数落地"）。
   */
  private toCnyFen(_candidate: ChainDepositCandidate): bigint {
    // 真实实现：usdtUsd = amountAtomic / 10^tokenDecimals；
    // cnyFen = usdtUsd × fx.usdt_cny_rate × 100（订单锁定汇率版本，§3）。
    // 首版 Mock：返回 0（候选不履约，防御性）。
    return 0n;
  }
}
