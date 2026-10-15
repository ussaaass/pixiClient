import { describe, expect, it } from 'vitest';
import {
  CLASSIC_V1_SCORING,
  HAND_CATEGORY,
  autoArrange,
  compareRanks,
  evaluateFive,
  evaluateFront,
  settleRound,
  validateArrangement,
} from './index';
import type { Arrangement, CardId } from './index';

function card(rank: number, suit: number): CardId {
  return suit * 13 + rank - 2;
}

function arrangementFrom(cards: readonly CardId[]): Arrangement {
  return {
    front: cards.slice(0, 3),
    middle: cards.slice(3, 8),
    back: cards.slice(8, 13),
  };
}

function* combinations(
  cards: readonly CardId[],
  size: number,
  start = 0,
  chosen: CardId[] = [],
): Generator<readonly CardId[]> {
  if (chosen.length === size) {
    yield [...chosen];
    return;
  }
  for (let index = start; index <= cards.length - (size - chosen.length); index += 1) {
    chosen.push(cards[index]!);
    yield* combinations(cards, size, index + 1, chosen);
    chosen.pop();
  }
}

function findLegalArrangement(cards: readonly CardId[]): Arrangement {
  for (const front of combinations(cards, 3)) {
    const frontSet = new Set(front);
    const afterFront = cards.filter((value) => !frontSet.has(value));
    for (const middle of combinations(afterFront, 5)) {
      const used = new Set([...front, ...middle]);
      const back = cards.filter((value) => !used.has(value));
      const candidate = { front, middle, back };
      const validation = validateArrangement(cards, candidate);
      if (validation.valid && !validation.value.foul) return candidate;
    }
  }
  throw new Error('Expected a legal arrangement to exist for test fixture');
}

describe('classic-v1 hand evaluation', () => {
  it('recognizes five-card categories from straight flush through high card', () => {
    const cases: readonly [readonly CardId[], number][] = [
      [[card(10, 1), card(11, 1), card(12, 1), card(13, 1), card(14, 1)], HAND_CATEGORY.STRAIGHT_FLUSH],
      [[card(9, 0), card(9, 1), card(9, 2), card(9, 3), card(2, 0)], HAND_CATEGORY.FOUR_OF_A_KIND],
      [[card(12, 0), card(12, 1), card(12, 2), card(4, 0), card(4, 1)], HAND_CATEGORY.FULL_HOUSE],
      [[card(2, 2), card(5, 2), card(8, 2), card(11, 2), card(14, 2)], HAND_CATEGORY.FLUSH],
      [[card(2, 0), card(3, 1), card(4, 2), card(5, 0), card(6, 1)], HAND_CATEGORY.STRAIGHT],
      [[card(7, 0), card(7, 1), card(7, 2), card(3, 0), card(2, 1)], HAND_CATEGORY.THREE_OF_A_KIND],
      [[card(8, 0), card(8, 1), card(3, 2), card(3, 3), card(14, 0)], HAND_CATEGORY.TWO_PAIR],
      [[card(10, 0), card(10, 1), card(14, 2), card(8, 3), card(3, 0)], HAND_CATEGORY.PAIR],
      [[card(14, 0), card(11, 1), card(8, 2), card(5, 3), card(2, 0)], HAND_CATEGORY.HIGH_CARD],
    ];

    for (const [cards, expected] of cases) expect(evaluateFive(cards).category).toBe(expected);
  });

  it('treats A-2-3-4-5 as the lowest straight and ignores wraparound sequences', () => {
    const wheel = evaluateFive([card(14, 0), card(2, 1), card(3, 2), card(4, 0), card(5, 1)]);
    const sixHigh = evaluateFive([card(2, 0), card(3, 1), card(4, 2), card(5, 0), card(6, 1)]);
    const wrap = evaluateFive([card(12, 0), card(13, 1), card(14, 2), card(2, 0), card(3, 1)]);

    expect(wheel.category).toBe(HAND_CATEGORY.STRAIGHT);
    expect(compareRanks(wheel, sixHigh)).toBe(-1);
    expect(wrap.category).toBe(HAND_CATEGORY.HIGH_CARD);
  });

  it('limits the front pile to high card, pair, and trips', () => {
    const suitedRun = evaluateFront([card(4, 0), card(5, 0), card(6, 0)]);
    const trips = evaluateFront([card(8, 0), card(8, 1), card(8, 2)]);

    expect(suitedRun.category).toBe(HAND_CATEGORY.HIGH_CARD);
    expect(trips.category).toBe(HAND_CATEGORY.THREE_OF_A_KIND);
  });

  it('uses rank tie-breaks and pads front-pile comparisons consistently', () => {
    const frontPairA = evaluateFront([card(14, 0), card(14, 1), card(12, 2)]);
    const middlePairK = evaluateFive([card(13, 0), card(13, 1), card(11, 2), card(9, 3), card(7, 0)]);
    const sameHandDifferentSuits = evaluateFive([card(14, 0), card(14, 1), card(12, 2), card(9, 3), card(7, 0)]);
    const sameHandOtherSuits = evaluateFive([card(14, 2), card(14, 3), card(12, 0), card(9, 1), card(7, 2)]);

    expect(compareRanks(frontPairA, middlePairK)).toBe(1);
    expect(compareRanks(sameHandDifferentSuits, sameHandOtherSuits)).toBe(0);
  });
});

describe('arrangement and round settlement', () => {
  it('validates exact card ownership, 3/5/5 pile counts, and foul ordering', () => {
    const heldCards = Array.from({ length: 13 }, (_, index) => index);
    const arrangement = arrangementFrom(heldCards);
    const valid = validateArrangement(heldCards, arrangement);
    const wrongCount = validateArrangement(heldCards, { ...arrangement, front: [0, 1] });
    const duplicate = validateArrangement(heldCards, { ...arrangement, back: [8, 9, 10, 11, 11] });
    const foreign = validateArrangement(heldCards, { ...arrangement, back: [8, 9, 10, 11, 51] });
    const tripAces = [card(14, 0), card(14, 1), card(14, 2)];
    const weakMiddle = [card(2, 0), card(3, 1), card(4, 2), card(6, 3), card(8, 0)];
    const alreadyUsed = new Set([...tripAces, ...weakMiddle]);
    const remainingCards = Array.from({ length: 52 }, (_, index) => index).filter((value) => !alreadyUsed.has(value));
    const foulCards = [...tripAces, ...weakMiddle, ...remainingCards.slice(0, 5)];
    const foulArrangement = {
      front: foulCards.slice(0, 3),
      middle: foulCards.slice(3, 8),
      back: foulCards.slice(8, 13),
    };

    expect(valid.valid).toBe(true);
    expect(wrongCount).toEqual({ valid: false, reason: 'INVALID_PILE_COUNTS' });
    expect(duplicate).toEqual({ valid: false, reason: 'DUPLICATE_CARDS' });
    expect(foreign).toEqual({ valid: false, reason: 'CARDS_NOT_IN_HAND' });
    expect(validateArrangement(foulCards, foulArrangement)).toMatchObject({ valid: true, value: { foul: true } });
  });

  it('settles a full 52-card round with exactly zero-sum pair transfers', () => {
    const deck = Array.from({ length: 52 }, (_, index) => index);
    const players = Array.from({ length: 4 }, (_, index) => {
      const heldCards = deck.slice(index * 13, (index + 1) * 13);
      return { playerId: `p${index + 1}`, heldCards, arrangement: arrangementFrom(heldCards) };
    });
    const result = settleRound(players, CLASSIC_V1_SCORING);

    expect(result.pairs).toHaveLength(6);
    expect(result.players.reduce((total, player) => total + player.water, 0)).toBe(0);
    for (const pair of result.pairs) {
      const left = result.players.find((player) => player.playerId === pair.leftPlayerId)!;
      const right = result.players.find((player) => player.playerId === pair.rightPlayerId)!;
      expect(left.foul || right.foul ? pair.leftWater === 0 || Math.abs(pair.leftWater) === CLASSIC_V1_SCORING.payouts.foul : true).toBe(true);
    }
  });

  it('applies special-pile payouts, slam, and home-run multipliers as configured', () => {
    const winningCards = [
      card(9, 0), card(9, 1), card(9, 2),
      card(10, 0), card(11, 0), card(12, 0), card(13, 0), card(14, 0),
      card(10, 1), card(11, 1), card(12, 1), card(13, 1), card(14, 1),
    ];
    const winners = new Set(winningCards);
    const remaining = Array.from({ length: 52 }, (_, index) => index).filter((value) => !winners.has(value));
    const opponents: CardId[][] = [[], [], []];
    remaining.forEach((value, index) => opponents[index % opponents.length]!.push(value));
    const players = [
      { playerId: 'winner', heldCards: winningCards, arrangement: { front: winningCards.slice(0, 3), middle: winningCards.slice(3, 8), back: winningCards.slice(8, 13) } },
      ...opponents.map((heldCards, index) => ({ playerId: `opponent-${index + 1}`, heldCards, arrangement: findLegalArrangement(heldCards) })),
    ];

    const result = settleRound(players, CLASSIC_V1_SCORING);
    const winner = result.players.find((player) => player.playerId === 'winner')!;
    const winnerPairs = result.pairs.filter((pair) => pair.leftPlayerId === 'winner' || pair.rightPlayerId === 'winner');

    expect(winner.foul).toBe(false);
    expect(winner.water).toBe(216);
    expect(winnerPairs).toHaveLength(3);
    expect(winnerPairs.every((pair) => pair.homeRunMultiplier === 2 && Math.abs(pair.leftWater) === 72)).toBe(true);
    expect(result.players.reduce((total, player) => total + player.water, 0)).toBe(0);
  });

  it('finds a legal deterministic arrangement from all 72,072 candidates', () => {
    const heldCards = Array.from({ length: 13 }, (_, index) => index);
    const result = autoArrange(heldCards);
    const sameResultFromDifferentInputOrder = autoArrange([...heldCards].reverse());

    expect(result.valid).toBe(true);
    if (!result.valid || !sameResultFromDifferentInputOrder.valid) return;
    expect(result.candidatesChecked).toBe(72_072);
    expect(result.evaluation.foul).toBe(false);
    expect(validateArrangement(heldCards, result.arrangement)).toMatchObject({ valid: true, value: { foul: false } });
    expect(sameResultFromDifferentInputOrder.arrangement).toEqual(result.arrangement);
    expect(autoArrange([0, 0, ...heldCards.slice(2)])).toEqual({ valid: false, reason: 'INVALID_HELD_CARDS' });
  });
});
