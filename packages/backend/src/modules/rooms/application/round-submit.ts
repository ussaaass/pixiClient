/**
 * 玩家出牌提交用例：POST /rounds/:roundId/submit。
 *
 * 领域所有者：rooms 模块（round / round_player / round_event 写入）。
 * 对应 SDD 章节：后端实施 SDD §5.4（rounds/:roundId/submit，契约已有
 * handler 新实现）、§9 第 4 步（开局 → 提交 → 结算验收路径：round ACTIVE=2
 * + submission_key 幂等 + round_player SUBMITTED=2 + 全部玩家提交后
 * round → SETTLING=3）；任务硬约定（submission_key = `sub:{roundKey}:
 * {userId}:{attempt}`，U(round_id, submission_key) 幂等；arrangement JSON
 * 存 playerStateCiphertext 密文列，submission_snapshot 存明文快照）。
 *
 * 用例语义：
 * - round ACTIVE=2 校验（非 ACTIVE → ROUND_NOT_ACTIVE；SETTLING/SETTLED
 *   → 拒绝提交）；
 * - fencing token 校验（旧 token → FENCING_CONFLICT 拒绝）；
 * - submission_key 幂等（`sub:{roundKey}:{userId}:{attempt}`，
 *   U(round_id, submission_key) 重放 → 返回既有 round_player，不产生第二提交）；
 * - round_player SUBMITTED=2（submission_snapshot JSON 存 arrangement，
 *   playerStateCiphertext 存 handler 私有状态密文——首版占位，加密层待闭环）；
 * - round_event SUBMIT=2（不可变 append，fencing_token 当前值）；
 * - 全部玩家 SUBMITTED 后 round → SETTLING=3（触发结算路径，
 *   GET /rounds/:roundId/settlement 用例读全量快照后调 ShisanshuiAdapterPort）；
 * - 锁顺序：round → round_player → round_event（SDD §4）。
 *
 * 错误码映射（R → 触发条件）：
 * - `ROUND_NOT_FOUND`：round 不存在。
 * - `ROUND_NOT_ACTIVE`：round.status ≠ ACTIVE=2（SETTLING/SETTLED/CANCELLED/
 *   RECOVERING 均拒绝提交）。
 * - `ROUND_PLAYER_NOT_FOUND`：round 下无对应用户参与人行（未开局即提交）。
 * - `FENCING_CONFLICT`：携带的 fencing_token 与 round 当前值不一致。
 * - `INVALID_SUBMISSION`：arrangement 格式非法（schema 校验失败，防御性门禁）。
 * - `STORAGE_UNAVAILABLE`：Sequelize 故障 / 行缺失（可重试）。
 * - 成功 → RoundSubmitResultDto（200；重放 submission_key 命中 = 200 语义，
 *   重复提交返回原结果，不产生第二提交，登记决策点）。
 */

import { RoundStatus, RoundPlayerStatus, RoundEventType, RoundSubmissionType } from '../../../infrastructure/database/models/game.js';
import { RoomDomainError, R } from '../domain/errors.js';
import { submissionKeyOf } from '../domain/round-rules.js';
import type { RoundRepo, RoundEventRepo, Tx } from '../ports/rooms-repository.js';
import { requestHashOf } from '../../wallet/domain/ledger-rules.js';

/** 提交结果（wire DTO；金额/ID 十进制字符串）。 */
export interface RoundSubmitResultDto {
  roundId: string;
  roundPlayerId: string;
  submittedAt: string;
  /** 幂等重放标志（true = 命中既有 submission_key，非新提交）。 */
  replay: boolean;
  /** 全部玩家提交完成后 round 已推进到 SETTLING=3。 */
  allSubmitted: boolean;
}

export class RoundSubmitUseCase {
  constructor(
    private readonly roundRepo: RoundRepo,
    private readonly roundEventRepo: RoundEventRepo,
  ) {}

  /**
   * POST /rounds/:roundId/submit：玩家出牌提交（同事务）。
   * 调用方（路由层）负责开事务，传入 `tx`。
   */
  async run(input: {
    userId: string;
    roundId: string;
    fencingToken: string;
    /** 出牌 arrangement（handler 私有格式；平台不解释内部字段，
     *  存入 submission_snapshot JSON + playerStateCiphertext 密文列）。 */
    arrangement: Record<string, unknown>;
    /** 客户端幂等尝试号（首次 = 1；重试同 attempt 命中 U 约束静默重放）。 */
    attempt: number;
    tx: Tx;
  }): Promise<RoundSubmitResultDto> {
    const { userId, roundId, fencingToken, arrangement, attempt, tx } = input;

    // 1) 锁读 round（行锁；fencing 校验前置）。
    const round = await this.roundRepo.lockRound(roundId, tx);
    if (round === null) {
      throw new RoomDomainError(R.ROUND_NOT_FOUND, 'round not found');
    }
    // round 须 ACTIVE=2 才允许提交（SETTLING/SETTLED/CANCELLED/RECOVERING 拒绝）。
    if (round.status !== RoundStatus.ACTIVE) {
      throw new RoomDomainError(R.ROUND_NOT_ACTIVE, 'round not in submittable state');
    }
    // fencing token 校验（旧 token → FENCING_CONFLICT 拒绝）。
    if (round.fencingToken !== fencingToken) {
      throw new RoomDomainError(R.FENCING_CONFLICT, 'fencing token mismatch');
    }

    // 2) 生成 submission_key（`sub:{roundKey}:{userId}:{attempt}`，
    //    U(round_id, submission_key) 幂等兜底）。
    const submissionKey = submissionKeyOf(round.roundKey, userId, attempt);
    const submissionSnapshot: Record<string, unknown> = {
      arrangement,
      submissionKey,
      attempt,
      userId,
    };
    const submissionHash = requestHashOf(submissionSnapshot);

    // 3) 提交（round_player SUBMITTED=2；幂等：U(round_id, submission_key) 命中 → 重放）。
    const submitResult = await this.roundRepo.submitRound({
      roundId,
      userId,
      submissionKey,
      submissionSnapshot,
      submissionHash,
      submissionType: RoundSubmissionType.MANUAL,
      tx,
    });

    const roundPlayer = submitResult.roundPlayer;
    const replay = !submitResult.inserted;

    // 4) round_event SUBMIT=2（不可变 append；fencing_token 当前值；
    //    幂等：U(event_key) 命中时静默跳过，不产生第二事件行）。
    if (!replay) {
      const eventKey = `ev:submit:${round.roundKey}:${userId}:${attempt}`;
      await this.roundEventRepo.appendRoundEvent({
        roundId,
        roundPlayerId: roundPlayer.id,
        seq: '2',
        eventKey,
        eventType: RoundEventType.SUBMIT,
        fencingToken: round.fencingToken,
        payloadCiphertext: submissionHash, // 首版占位：用提交哈希代替密文（加密层待闭环，决策点登记）
        tx,
      });
    }

    // 5) 全部玩家 SUBMITTED → round SETTLING=3（触发结算路径）。
    let allSubmitted = false;
    if (!replay) {
      const players = await this.roundRepo.listRoundPlayers(roundId, tx);
      allSubmitted = players.every((p) => p.status === RoundPlayerStatus.SUBMITTED || p.status === RoundPlayerStatus.SETTLED);
      if (allSubmitted) {
        await this.roundRepo.markRoundSettling(roundId, tx);
      }
    }

    return {
      roundId,
      roundPlayerId: roundPlayer.id,
      submittedAt: (roundPlayer.submittedAt as string | null) ?? '',
      replay,
      allSubmitted,
    };
  }
}
