import { RoundPlayerStatus, RoundStatus } from '../../../infrastructure/database/models/game.js';
import type { RoundModel, RoundPlayerModel } from '../../../infrastructure/database/models/game.js';
import { RoomDomainError, R } from '../domain/errors.js';
import type { RoundEventRepo, RoundRepo, Tx } from '../ports/rooms-repository.js';

export interface RoundSnapshotPlayer {
  userId: string;
  roundPlayerId: string;
  seatNo: number;
  status: number;
  submissionSnapshot: Record<string, unknown> | null;
  netCoinDelta: string | null;
}

export interface RoundSnapshotDto {
  roundId: string;
  roomId: string;
  roundNo: string;
  status: number;
  handlerVersion: string;
  rulesSnapshot: Record<string, unknown>;
  fencingToken: string;
  players: RoundSnapshotPlayer[];
  events: Array<{ seq: string; eventKey: string; eventType: number; roundPlayerId: string | null }>;
  nextCursor: string;
}

export interface RoundSnapshotDeps {
  roundRepo: RoundRepo;
  roundEventRepo: RoundEventRepo;
}

const MAX_BIGINT = 18446744073709551615n;
const idPattern = /^[1-9][0-9]{0,19}$/;

function field<T extends object, K extends keyof T>(row: T, key: K): T[K] {
  const getter = (row as { getDataValue?: (name: string) => unknown }).getDataValue;
  if (typeof getter === 'function') return getter.call(row, String(key)) as T[K];
  if (Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null) throw new Error('non-plain snapshot row');
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new Error('invalid snapshot data field');
  }
  return descriptor.value as T[K];
}

function assertRound(round: RoundModel, requestedId: string): void {
  try {
    const id = field(round, 'id');
    const roomId = field(round, 'roomId');
    const roundNo = field(round, 'roundNo');
    const status = field(round, 'status');
    const handlerVersion = field(round, 'handlerVersion');
    const rulesSnapshot = field(round, 'rulesSnapshot');
    const fencingToken = field(round, 'fencingToken');
    if (
      id !== requestedId ||
      !idPattern.test(id) ||
      !idPattern.test(roomId) ||
      typeof roundNo !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(roundNo) ||
      BigInt(roundNo) > MAX_BIGINT ||
      !Object.values(RoundStatus).includes(status as never) ||
      typeof handlerVersion !== 'string' ||
      handlerVersion.length === 0 ||
      rulesSnapshot === null ||
      typeof rulesSnapshot !== 'object' ||
      Array.isArray(rulesSnapshot) ||
      typeof fencingToken !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(fencingToken)
    )
      throw new Error('invalid round snapshot');
  } catch {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round snapshot is malformed');
  }
}

function assertPlayers(rows: RoundPlayerModel[], roundId: string, callerId: string, roundStatus: number): RoundSnapshotPlayer[] {
  try {
    if (!Array.isArray(rows) || rows.length !== 4) throw new Error('invalid player count');
    const seen = new Set<string>();
    const players = rows.map((row) => {
      const id = field(row, 'id');
      const playerRoundId = field(row, 'roundId');
      const userId = field(row, 'userId');
      const seatNo = field(row, 'seatNo');
      const status = field(row, 'status');
      const submissionSnapshot = field(row, 'submissionSnapshot');
      const netCoinDelta = field(row, 'netCoinDelta');
      if (
        !idPattern.test(id) ||
        playerRoundId !== roundId ||
        !idPattern.test(userId) ||
        seen.has(userId) ||
        !Number.isSafeInteger(seatNo) ||
        seatNo < 1 ||
        seatNo > 4 ||
        !Object.values(RoundPlayerStatus).includes(status as never) ||
        (netCoinDelta !== null && (status !== RoundPlayerStatus.SETTLED || roundStatus !== RoundStatus.SETTLED)) ||
        (submissionSnapshot !== null && (typeof submissionSnapshot !== 'object' || Array.isArray(submissionSnapshot))) ||
        (netCoinDelta !== null && (typeof netCoinDelta !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(netCoinDelta)))
      )
        throw new Error('invalid player row');
      seen.add(userId);
      return {
        userId,
        roundPlayerId: id,
        seatNo,
        status,
        // Private cards/arrangement are visible only to the owning member.
        submissionSnapshot:
          userId === callerId && roundStatus === RoundStatus.SETTLED ? (submissionSnapshot as Record<string, unknown> | null) : null,
        netCoinDelta,
      };
    });
    if (!seen.has(callerId) || new Set(players.map((p) => p.seatNo)).size !== 4) throw new Error('caller or seats invalid');
    return players.sort((a, b) => a.seatNo - b.seatNo);
  } catch {
    throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round player snapshot is malformed');
  }
}

export function createRoundSnapshotUseCase(deps: RoundSnapshotDeps) {
  return async function getRoundSnapshot(
    input: { userId: string; roundId: string; afterSeq?: string; limit?: number },
    tx?: Tx,
  ): Promise<RoundSnapshotDto> {
    if (!idPattern.test(input.userId) || !idPattern.test(input.roundId)) {
      throw new RoomDomainError(R.INVALID_SUBMISSION, 'invalid snapshot identity');
    }
    const afterSeq = input.afterSeq ?? '0';
    const limit = input.limit ?? 50;
    if (!/^(0|[1-9][0-9]{0,19})$/.test(afterSeq) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RoomDomainError(R.INVALID_SUBMISSION, 'invalid snapshot cursor or limit');
    }
    const afterSequence = BigInt(afterSeq);
    if (afterSequence > MAX_BIGINT) throw new RoomDomainError(R.INVALID_SUBMISSION, 'invalid snapshot cursor or limit');
    let round: RoundModel | null;
    try {
      if (tx === undefined) throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'snapshot requires transaction');
      round = await deps.roundRepo.lockRound(input.roundId, tx);
      if (!round) throw new RoomDomainError(R.ROUND_NOT_FOUND, 'round not found');
      assertRound(round, input.roundId);
      const rawPlayers = await deps.roundRepo.listRoundPlayers(input.roundId, tx);
      const roundStatus = field(round, 'status');
      const players = assertPlayers(rawPlayers, input.roundId, input.userId, roundStatus);
      const rawEvents = await deps.roundEventRepo.listRoundEventsAfterSeq(input.roundId, afterSeq, limit + 1, tx);
      if (!Array.isArray(rawEvents) || rawEvents.length > limit + 1 || (rawEvents.length > limit && rawEvents[limit] !== undefined))
        throw new Error('invalid event page');
      let previousSeq = afterSequence;
      const events = rawEvents.slice(0, limit).map((event) => {
        if (field(event, 'roundId') !== input.roundId) throw new Error('event belongs to another round');
        const seq = field(event, 'seq');
        const eventKey = field(event, 'eventKey');
        const eventType = field(event, 'eventType');
        const roundPlayerId = field(event, 'roundPlayerId');
        if (
          !/^([1-9][0-9]{0,19})$/.test(seq) ||
          BigInt(seq) <= previousSeq ||
          (previousSeq = BigInt(seq)) > MAX_BIGINT ||
          !/^[A-Za-z0-9:_-]{1,160}$/.test(eventKey) ||
          !Number.isSafeInteger(eventType) ||
          eventType < 1 ||
          (roundPlayerId !== null && !idPattern.test(roundPlayerId))
        )
          throw new Error('invalid event row');
        const eventRoundPlayerId = roundPlayerId === null ? null : players.find((player) => player.roundPlayerId === roundPlayerId)?.userId;
        if (roundPlayerId !== null && eventRoundPlayerId === undefined) throw new Error('event participant is unknown');
        const ownEvent = eventRoundPlayerId === input.userId;
        return {
          seq,
          eventKey,
          eventType,
          roundPlayerId: ownEvent ? roundPlayerId : null,
        };
      });
      const nextCursor = events.length === 0 ? afterSeq : events[events.length - 1]!.seq;
      return {
        roundId: field(round, 'id'),
        roomId: field(round, 'roomId'),
        roundNo: field(round, 'roundNo'),
        status: roundStatus,
        handlerVersion: field(round, 'handlerVersion'),
        rulesSnapshot: field(round, 'rulesSnapshot'),
        fencingToken: field(round, 'fencingToken'),
        players,
        events,
        nextCursor,
      };
    } catch (error) {
      if (error instanceof RoomDomainError) throw error;
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round snapshot could not be read');
    }
  };
}
