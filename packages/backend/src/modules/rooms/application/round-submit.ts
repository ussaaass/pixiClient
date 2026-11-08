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
 * - 新提交仅限 ACTIVE=2（非 ACTIVE → ROUND_NOT_ACTIVE）；SETTLING 只允许仓储确认同键同摘要的精确重放，其他状态全部拒绝；
 * - 成功校验后在保存快照时复制 arrangement，避免客户端调用方保留的数组引用修改提交内容；
 * - fencing token 校验（旧 token → FENCING_CONFLICT 拒绝）；
 * - submission_key 幂等（`sub:{roundKey}:{userId}:{attempt}`，
 *   仅当同键重放且请求内容哈希与原提交一致时返回既有结果；同键异内容拒绝）；
 * - round_player SUBMITTED=2（submission_snapshot JSON 存 arrangement，
 *   playerStateCiphertext 存 handler 私有状态密文——首版占位，加密层待闭环）；
 * - round_event SUBMIT=2（不可变 append，fencing_token 当前值）；
 * - 全部玩家 SUBMITTED 后 round → SETTLING=3（触发结算路径，
 *   GET /rounds/:roundId/settlement 用例读全量快照后调 ShisanshuiAdapterPort）；
 * - round_player 成员资格在任何提交写入前由用例显式检查；锁顺序：round → round_player → round_event（SDD §4）。
 *
 * 错误码映射（R → 触发条件）：
 * - `ROUND_NOT_FOUND`：round 不存在。
 * - `ROUND_NOT_ACTIVE`：round.status ≠ ACTIVE=2（SETTLING/SETTLED/CANCELLED/
 *   RECOVERING 均拒绝提交）。
 * - `ROUND_PLAYER_NOT_FOUND`：round 下无对应用户参与人行（非成员/未开局即提交）。
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

function normalizeArrangement(value: unknown): { front: number[]; middle: number[]; back: number[] } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  let rootDescriptors: PropertyDescriptorMap;
  let ownKeys: (string | symbol)[];
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    rootDescriptors = Object.getOwnPropertyDescriptors(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  const piles = ['front', 'middle', 'back'] as const;
  let rootDescriptorKeys: (string | symbol)[];
  let capturedRootKeys: (string | symbol)[];
  let verifiedRootKeys: (string | symbol)[];
  let verifiedDescriptors: PropertyDescriptorMap;
  try {
    rootDescriptorKeys = Reflect.ownKeys(rootDescriptors);
    capturedRootKeys = Reflect.ownKeys(value);
    verifiedRootKeys = Reflect.ownKeys(value);
    verifiedDescriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  if (
    ownKeys.length !== piles.length ||
    capturedRootKeys.length !== ownKeys.length ||
    ownKeys.some((key) => !capturedRootKeys.includes(key)) ||
    rootDescriptorKeys.length !== ownKeys.length ||
    ownKeys.some((key) => !rootDescriptorKeys.includes(key)) ||
    Reflect.ownKeys(verifiedDescriptors).length !== ownKeys.length ||
    ownKeys.some((key) => !Object.prototype.hasOwnProperty.call(verifiedDescriptors, key)) ||
    piles.some((pile) => {
      const initial = rootDescriptors[pile];
      const verified = verifiedDescriptors[pile];
      return (
        initial === undefined ||
        verified === undefined ||
        !('value' in initial) ||
        !('value' in verified) ||
        initial.value !== verified.value ||
        initial.enumerable !== verified.enumerable ||
        initial.configurable !== verified.configurable ||
        initial.writable !== verified.writable
      );
    }) ||
    verifiedRootKeys.length !== ownKeys.length ||
    ownKeys.some((key) => !verifiedRootKeys.includes(key)) ||
    !ownKeys.every((key) => typeof key === 'string' && piles.includes(key as (typeof piles)[number]))
  )
    return null;

  const expectedLengths = { front: 3, middle: 5, back: 5 } as const;
  const arrangement: { front: number[]; middle: number[]; back: number[] } = { front: [], middle: [], back: [] };
  const cards: number[] = [];
  for (const pile of piles) {
    const descriptor = rootDescriptors[pile];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable || !Array.isArray(descriptor.value)) return null;
    let pileOwnKeys: (string | symbol)[];
    let pileLengthDescriptor: PropertyDescriptor | undefined;
    try {
      if (Object.getPrototypeOf(descriptor.value) !== Array.prototype) return null;
      pileLengthDescriptor = Object.getOwnPropertyDescriptor(descriptor.value, 'length');
      pileOwnKeys = Reflect.ownKeys(descriptor.value);
    } catch {
      return null;
    }
    if (pileLengthDescriptor === undefined || !('value' in pileLengthDescriptor) || pileLengthDescriptor.value !== expectedLengths[pile])
      return null;
    let pilePropertyDescriptors: ReturnType<typeof Object.getOwnPropertyDescriptors>;
    let pileDescriptorKeys: (string | symbol)[];
    let verifiedPileKeys: (string | symbol)[];
    try {
      pilePropertyDescriptors = Object.getOwnPropertyDescriptors(descriptor.value);
      pileDescriptorKeys = Reflect.ownKeys(pilePropertyDescriptors);
      verifiedPileKeys = Reflect.ownKeys(descriptor.value);
    } catch {
      return null;
    }
    if (
      pileDescriptorKeys.length !== pileOwnKeys.length ||
      pileOwnKeys.some((key) => !pileDescriptorKeys.includes(key)) ||
      verifiedPileKeys.length !== pileOwnKeys.length ||
      pileOwnKeys.some((key) => !verifiedPileKeys.includes(key)) ||
      pileOwnKeys.length !== expectedLengths[pile] + 1 ||
      !pileOwnKeys.includes('length') ||
      !pileOwnKeys.every(
        (key) => key === 'length' || (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < expectedLengths[pile]),
      )
    )
      return null;
    if (pileOwnKeys.some((key) => !Object.prototype.hasOwnProperty.call(pilePropertyDescriptors, key))) return null;
    const cardDescriptors: PropertyDescriptor[] = [];
    let finalPileKeys: (string | symbol)[];
    try {
      for (let index = 0; index < expectedLengths[pile]; index += 1) {
        const cardDescriptor = Object.getOwnPropertyDescriptor(descriptor.value, String(index));
        if (cardDescriptor === undefined || !('value' in cardDescriptor) || !cardDescriptor.enumerable) return null;
        cardDescriptors.push(cardDescriptor);
      }
      finalPileKeys = Reflect.ownKeys(descriptor.value);
    } catch {
      return null;
    }
    if (finalPileKeys.length !== pileOwnKeys.length || finalPileKeys.some((key) => !pileOwnKeys.includes(key))) return null;
    for (const cardDescriptor of cardDescriptors) {
      const card = cardDescriptor.value;
      if (typeof card !== 'number' || !Number.isSafeInteger(card) || card < 0 || card >= 52) return null;
      cards.push(card);
      arrangement[pile].push(card);
    }
  }
  let finalRootKeys: (string | symbol)[];
  let finalRootDescriptors: PropertyDescriptorMap;
  try {
    finalRootKeys = Reflect.ownKeys(value);
    finalRootDescriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  if (
    finalRootKeys.length !== ownKeys.length ||
    ownKeys.some((key) => !finalRootKeys.includes(key)) ||
    Reflect.ownKeys(finalRootDescriptors).length !== ownKeys.length ||
    ownKeys.some((key) => !Object.prototype.hasOwnProperty.call(finalRootDescriptors, key)) ||
    piles.some((pile) => {
      const initial = rootDescriptors[pile];
      const final = finalRootDescriptors[pile];
      return (
        initial === undefined ||
        final === undefined ||
        !('value' in initial) ||
        !('value' in final) ||
        initial.value !== final.value ||
        initial.enumerable !== final.enumerable ||
        initial.configurable !== final.configurable ||
        initial.writable !== final.writable
      );
    })
  )
    return null;
  return new Set(cards).size === cards.length ? arrangement : null;
}

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

function normalizeRoundPlayerSnapshot(roundPlayer: unknown): { id: string; submittedAt: string } {
  if (roundPlayer === null || typeof roundPlayer !== 'object') {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'persisted round player submission snapshot is malformed');
  }
  let descriptors: PropertyDescriptorMap;
  try {
    if (Object.getPrototypeOf(roundPlayer) !== Object.prototype) throw new Error('non-plain snapshot');
    descriptors = Object.getOwnPropertyDescriptors(roundPlayer);
    if (Reflect.ownKeys(descriptors).length !== 2) throw new Error('unexpected snapshot shape');
  } catch {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'persisted round player submission snapshot is malformed');
  }
  const idDescriptor = descriptors.id;
  const submittedAtDescriptor = descriptors.submittedAt;
  if (
    idDescriptor === undefined ||
    submittedAtDescriptor === undefined ||
    !('value' in idDescriptor) ||
    !idDescriptor.enumerable ||
    !('value' in submittedAtDescriptor) ||
    !submittedAtDescriptor.enumerable
  ) {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'persisted round player submission snapshot is malformed');
  }
  const id = idDescriptor.value;
  const submittedAt = submittedAtDescriptor.value;
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'persisted round player submission snapshot is malformed');
  }
  let submittedAtDate: Date;
  if (typeof submittedAt === 'string') {
    submittedAtDate = new Date(submittedAt);
  } else if (submittedAt instanceof Date) {
    let timestamp: number;
    try {
      timestamp = Date.prototype.getTime.call(submittedAt);
    } catch {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'persisted round player submission snapshot is malformed');
    }
    submittedAtDate = new Date(timestamp);
  } else {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'persisted round player submission snapshot is malformed');
  }
  if (!Number.isFinite(submittedAtDate.getTime())) {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'persisted round player submission snapshot is malformed');
  }
  return { id, submittedAt: submittedAtDate.toISOString() };
}

function isValidRoundPlayerSet(
  players: unknown,
  requireFour: boolean,
  allowedStatuses: readonly number[],
): Array<{ userId: string; status: number }> | null {
  try {
    if (!Array.isArray(players) || Object.getPrototypeOf(players) !== Array.prototype) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(players, 'length');
    if (lengthDescriptor === undefined || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) return null;
    const playerCount = lengthDescriptor.value as number;
    const playerKeys = Reflect.ownKeys(players);
    if (
      (requireFour && playerCount !== 4) ||
      playerKeys.length !== playerCount + 1 ||
      !playerKeys.includes('length') ||
      !playerKeys.every(
        (key) => key === 'length' || (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < playerCount),
      )
    )
      return null;
    const expectedPlayerKeys = new Set<PropertyKey>(['length', ...Array.from({ length: playerCount }, (_, index) => String(index))]);
    if (playerKeys.some((key) => !expectedPlayerKeys.has(key))) return null;
    const playerDescriptors: PropertyDescriptor[] = [];
    for (let index = 0; index < playerCount; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(players, String(index));
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) return null;
      playerDescriptors.push(descriptor);
    }
    const finalPlayerKeys = Reflect.ownKeys(players);
    const initialPlayerKeys = new Set(playerKeys);
    if (finalPlayerKeys.length !== initialPlayerKeys.size || finalPlayerKeys.some((key) => !initialPlayerKeys.has(key))) return null;
    const normalizedPlayers: Array<{ userId: string; status: number }> = [];
    for (const playerDescriptor of playerDescriptors) {
      const player = playerDescriptor.value;
      if (player === null || typeof player !== 'object') return null;
      if (Object.getPrototypeOf(player) !== Object.prototype) return null;
      const descriptors = Object.getOwnPropertyDescriptors(player);
      if (Reflect.ownKeys(descriptors).length !== 2) return null;
      const userIdDescriptor = descriptors.userId;
      const statusDescriptor = descriptors.status;
      if (
        userIdDescriptor === undefined ||
        statusDescriptor === undefined ||
        !('value' in userIdDescriptor) ||
        !userIdDescriptor.enumerable ||
        !('value' in statusDescriptor) ||
        !statusDescriptor.enumerable ||
        typeof userIdDescriptor.value !== 'string' ||
        !/^[1-9][0-9]{0,19}$/.test(userIdDescriptor.value) ||
        typeof statusDescriptor.value !== 'number' ||
        !allowedStatuses.includes(statusDescriptor.value)
      ) {
        return null;
      }
      normalizedPlayers.push({ userId: userIdDescriptor.value, status: statusDescriptor.value });
    }
    return new Set(normalizedPlayers.map((player) => player.userId)).size === normalizedPlayers.length ? normalizedPlayers : null;
  } catch {
    return null;
  }
}

function assertRoundSnapshot(round: unknown): asserts round is { id: string; roundKey: string; status: number; fencingToken: string } {
  if (round === null || typeof round !== 'object') {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'persisted round snapshot is malformed');
  }
  let descriptors: PropertyDescriptorMap;
  try {
    if (Object.getPrototypeOf(round) !== Object.prototype) throw new Error('non-plain snapshot');
    descriptors = Object.getOwnPropertyDescriptors(round);
    if (Reflect.ownKeys(descriptors).length !== 4) throw new Error('unexpected snapshot shape');
  } catch {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'persisted round snapshot is malformed');
  }
  const id = descriptors.id;
  const roundKey = descriptors.roundKey;
  const status = descriptors.status;
  const fencingToken = descriptors.fencingToken;
  if (
    id === undefined ||
    roundKey === undefined ||
    status === undefined ||
    fencingToken === undefined ||
    !('value' in id) ||
    !id.enumerable ||
    !('value' in roundKey) ||
    !roundKey.enumerable ||
    !('value' in status) ||
    !status.enumerable ||
    !('value' in fencingToken) ||
    !fencingToken.enumerable ||
    typeof id.value !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(id.value) ||
    typeof roundKey.value !== 'string' ||
    roundKey.value.length === 0 ||
    typeof status.value !== 'number' ||
    !Object.values(RoundStatus).includes(status.value as (typeof RoundStatus)[keyof typeof RoundStatus]) ||
    typeof fencingToken.value !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(fencingToken.value)
  ) {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'persisted round snapshot is malformed');
  }
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
    /** 客户端提交的 arrangement；结构规范化不代表牌归属或状态权威已验证。 */
    arrangement: Record<string, unknown>;
    /** 客户端幂等尝试号（首次 = 1；重试同 attempt 命中 U 约束静默重放）。 */
    attempt: number;
    tx: Tx;
  }): Promise<RoundSubmitResultDto> {
    if (input === null || typeof input !== 'object') {
      throw new RoomDomainError(R.INVALID_SUBMISSION, 'invalid round submission');
    }
    let inputDescriptors: PropertyDescriptorMap;
    let inputKeys: (string | symbol)[];
    try {
      if (Object.getPrototypeOf(input) !== Object.prototype) {
        throw new RoomDomainError(R.INVALID_SUBMISSION, 'invalid round submission');
      }
      inputDescriptors = Object.getOwnPropertyDescriptors(input);
      inputKeys = Reflect.ownKeys(input);
    } catch {
      throw new RoomDomainError(R.INVALID_SUBMISSION, 'invalid round submission');
    }
    const requiredInputKeys = ['userId', 'roundId', 'fencingToken', 'arrangement', 'attempt', 'tx'] as const;
    if (
      inputKeys.length !== requiredInputKeys.length ||
      !inputKeys.every((key) => typeof key === 'string' && requiredInputKeys.includes(key as (typeof requiredInputKeys)[number])) ||
      !requiredInputKeys.every((key) => {
        const descriptor = inputDescriptors[key];
        return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable === true;
      })
    ) {
      throw new RoomDomainError(R.INVALID_SUBMISSION, 'invalid round submission');
    }
    const userIdDescriptor = inputDescriptors.userId;
    const roundIdDescriptor = inputDescriptors.roundId;
    const fencingTokenDescriptor = inputDescriptors.fencingToken;
    const arrangementDescriptor = inputDescriptors.arrangement;
    const attemptDescriptor = inputDescriptors.attempt;
    const txDescriptor = inputDescriptors.tx;
    if (
      userIdDescriptor === undefined ||
      !('value' in userIdDescriptor) ||
      roundIdDescriptor === undefined ||
      !('value' in roundIdDescriptor) ||
      fencingTokenDescriptor === undefined ||
      !('value' in fencingTokenDescriptor) ||
      arrangementDescriptor === undefined ||
      !('value' in arrangementDescriptor) ||
      attemptDescriptor === undefined ||
      !('value' in attemptDescriptor) ||
      txDescriptor === undefined ||
      !('value' in txDescriptor)
    )
      throw new RoomDomainError(R.INVALID_SUBMISSION, 'invalid round submission');
    const userId = userIdDescriptor.value as string;
    const roundId = roundIdDescriptor.value as string;
    const fencingToken = fencingTokenDescriptor.value as string;
    const untrustedArrangement = arrangementDescriptor.value;
    const attempt = attemptDescriptor.value as number;
    const tx = txDescriptor.value as Tx;
    if (
      typeof userId !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(userId) ||
      typeof roundId !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(roundId) ||
      typeof fencingToken !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(fencingToken) ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      attempt > 1_000_000
    ) {
      throw new RoomDomainError(R.INVALID_SUBMISSION, 'invalid round submission');
    }
    let normalizedArrangement: { front: number[]; middle: number[]; back: number[] } | null;
    try {
      normalizedArrangement = normalizeArrangement(untrustedArrangement);
    } catch {
      throw new RoomDomainError(R.INVALID_SUBMISSION, 'invalid round submission');
    }
    if (normalizedArrangement === null) throw new RoomDomainError(R.INVALID_SUBMISSION, 'invalid round submission');
    const arrangement: Record<string, unknown> = normalizedArrangement;
    // 1) 锁读 round（行锁；fencing 校验前置）。
    const round = await this.roundRepo.lockRound(roundId, tx);
    if (round === null) {
      throw new RoomDomainError(R.ROUND_NOT_FOUND, 'round not found');
    }
    assertRoundSnapshot(round);
    // 新提交仅允许 ACTIVE=2；SETTLING=3 仅开放下方 same-key/same-hash 精确重放。
    if (round.status !== RoundStatus.ACTIVE && round.status !== RoundStatus.SETTLING) {
      throw new RoomDomainError(R.ROUND_NOT_ACTIVE, 'round not in submittable state');
    }
    // fencing token 校验（旧 token → FENCING_CONFLICT 拒绝）。
    if (round.fencingToken !== fencingToken) {
      throw new RoomDomainError(R.FENCING_CONFLICT, 'fencing token mismatch');
    }

    // Require round membership before calculating submission state or mutating the player row.
    const players = await this.roundRepo.listRoundPlayers(roundId, tx);
    const normalizedPlayers = isValidRoundPlayerSet(players, false, Object.values(RoundPlayerStatus));
    if (normalizedPlayers === null) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'pre-submit round-player snapshot is malformed');
    }
    if (!normalizedPlayers.some((player) => player.userId === userId)) {
      throw new RoomDomainError(R.ROUND_PLAYER_NOT_FOUND, 'user is not a player in this round');
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

    let submitResultDescriptors: PropertyDescriptorMap;
    try {
      if (submitResult === null || typeof submitResult !== 'object') {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round submission result is malformed');
      }
      if (Object.getPrototypeOf(submitResult) !== Object.prototype) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round submission result is malformed');
      }
      submitResultDescriptors = Object.getOwnPropertyDescriptors(submitResult);
    } catch {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round submission result is malformed');
    }
    const insertedDescriptor = submitResultDescriptors.inserted;
    const roundPlayerDescriptor = submitResultDescriptors.roundPlayer;
    if (
      Reflect.ownKeys(submitResultDescriptors).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(submitResultDescriptors, 'inserted') ||
      !Object.prototype.hasOwnProperty.call(submitResultDescriptors, 'roundPlayer') ||
      insertedDescriptor === undefined ||
      !('value' in insertedDescriptor) ||
      !insertedDescriptor.enumerable ||
      typeof insertedDescriptor.value !== 'boolean' ||
      roundPlayerDescriptor === undefined ||
      !('value' in roundPlayerDescriptor) ||
      !roundPlayerDescriptor.enumerable
    ) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round submission result is malformed');
    }
    const roundPlayer = normalizeRoundPlayerSnapshot(roundPlayerDescriptor.value);
    const replay = !insertedDescriptor.value;
    if (replay && round.status !== RoundStatus.SETTLING) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'submission replay returned outside SETTLING round state');
    }
    if (!replay && round.status !== RoundStatus.ACTIVE) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'new submission returned outside ACTIVE round state');
    }

    // 4) round_event SUBMIT=2（不可变 append；fencing_token 当前值；
    //    幂等：U(event_key) 命中时静默跳过，不产生第二事件行）。
    if (!replay) {
      if (!(submissionHash instanceof Uint8Array) || submissionHash.length !== 32) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'submission hash is malformed before event append');
      }
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
      // Re-read after the row transition: `players` was loaded before this user
      // submitted, so checking that snapshot misses the final player's update.
      const playersAfterSubmit = await this.roundRepo.listRoundPlayers(roundId, tx);
      const normalizedPlayersAfterSubmit = isValidRoundPlayerSet(playersAfterSubmit, true, Object.values(RoundPlayerStatus));
      if (normalizedPlayersAfterSubmit === null) {
        throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'post-submit round-player snapshot is malformed');
      }
      allSubmitted = normalizedPlayersAfterSubmit.every(
        (player) => player.status === RoundPlayerStatus.SUBMITTED || player.status === RoundPlayerStatus.SETTLED,
      );
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
