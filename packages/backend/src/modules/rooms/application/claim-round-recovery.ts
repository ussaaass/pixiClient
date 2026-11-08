import { RoomStatus, RoundStatus } from '../../../infrastructure/database/models/game.js';
import { RoomDomainError, R } from '../domain/errors.js';
import type { RoomRepo, RoundRepo, Tx } from '../ports/rooms-repository.js';

const MAX_BIGINT = 18_446_744_073_709_551_615n;
const fencingPattern = /^[1-9][0-9]{0,19}$/;

export interface ClaimRoundRecoveryDeps {
  roomRepo: Pick<RoomRepo, 'lockRoom' | 'claimRoomRecovery'>;
  roundRepo: Pick<RoundRepo, 'findRoundRoomId' | 'lockRound' | 'recoverRound'>;
}

export interface ClaimRoundRecoveryResult {
  roomId: string;
  roundId: string;
  status: typeof RoundStatus.RECOVERING;
  fencingToken: string;
}

/**
 * Internal recovery-worker primitive. It only fences the prior owner and moves an
 * ACTIVE round into RECOVERING. It deliberately does not inspect handler secrets,
 * replay events, apply timeouts, or perform settlement/ledger side effects.
 */
export function createClaimRoundRecoveryUseCase(deps: ClaimRoundRecoveryDeps) {
  return async function claimRoundRecovery(input: {
    roundId: string;
    expectedFencingToken: string;
    tx: Tx;
  }): Promise<ClaimRoundRecoveryResult> {
    if (
      typeof input.roundId !== 'string' ||
      !fencingPattern.test(input.roundId) ||
      BigInt(input.roundId) > MAX_BIGINT ||
      typeof input.expectedFencingToken !== 'string' ||
      !fencingPattern.test(input.expectedFencingToken) ||
      BigInt(input.expectedFencingToken) > MAX_BIGINT
    ) {
      throw new RoomDomainError(R.INVALID_SUBMISSION, 'invalid recovery identity or fencing token');
    }
    if (input.tx?.transaction == null) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'recovery claim requires transaction');
    }

    // Read the immutable room_id without a row lock, then take locks in the
    // documented parent-to-child order (room → round) for this claim.
    const reference = await deps.roundRepo.findRoundRoomId(input.roundId, input.tx);
    if (reference === null) throw new RoomDomainError(R.ROUND_NOT_FOUND, 'round not found');
    if (typeof reference.roomId !== 'string' || !fencingPattern.test(reference.roomId)) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round recovery room reference is malformed');
    }
    const room = await deps.roomRepo.lockRoom(reference.roomId, input.tx);
    if (room === null) throw new RoomDomainError(R.ROOM_NOT_FOUND, 'round room not found');
    if (room.status !== RoomStatus.ACTIVE || room.fencingToken !== input.expectedFencingToken) {
      throw new RoomDomainError(R.FENCING_CONFLICT, 'room recovery fencing token mismatch');
    }
    const round = await deps.roundRepo.lockRound(input.roundId, input.tx);
    if (round === null) throw new RoomDomainError(R.ROUND_NOT_FOUND, 'round not found');
    if (round.status !== RoundStatus.ACTIVE) {
      // SETTLING must never be retried here: the transaction outcome/ledger must
      // be inspected separately. PREPARING and existing RECOVERING also fail closed.
      throw new RoomDomainError(R.ROUND_NOT_ACTIVE, 'only ACTIVE rounds may be claimed for recovery');
    }
    if (
      typeof round.roomId !== 'string' ||
      round.roomId !== room.id ||
      typeof round.fencingToken !== 'string' ||
      !fencingPattern.test(round.fencingToken) ||
      BigInt(round.fencingToken) > MAX_BIGINT
    ) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'round recovery fencing state is malformed');
    }
    if (round.fencingToken !== input.expectedFencingToken) {
      throw new RoomDomainError(R.FENCING_CONFLICT, 'round recovery fencing token mismatch');
    }
    const roomToken = room.fencingToken;
    if (typeof roomToken !== 'string' || !fencingPattern.test(roomToken) || BigInt(roomToken) >= MAX_BIGINT) {
      throw new RoomDomainError(R.STORAGE_UNAVAILABLE, 'room recovery fencing token is malformed or exhausted');
    }
    const newFencingToken = (BigInt(roomToken) + 1n).toString();

    // CAS both rows in the same caller-owned SQL transaction. A failed second CAS
    // must roll back the room claim; do not catch/convert storage failures here.
    await deps.roomRepo.claimRoomRecovery({
      roomId: room.id,
      expectedFencingToken: roomToken,
      newFencingToken,
      tx: input.tx,
    });
    await deps.roundRepo.recoverRound({
      roundId: round.id,
      expectedFencingToken: input.expectedFencingToken,
      newFencingToken,
      tx: input.tx,
    });

    return { roomId: room.id, roundId: round.id, status: RoundStatus.RECOVERING, fencingToken: newFencingToken };
  };
}
