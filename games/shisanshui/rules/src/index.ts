export const HAND_CATEGORY = {
  HIGH_CARD: 1,
  PAIR: 2,
  TWO_PAIR: 3,
  THREE_OF_A_KIND: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  STRAIGHT_FLUSH: 9,
} as const;

export type HandCategory = (typeof HAND_CATEGORY)[keyof typeof HAND_CATEGORY];
export type CardId = number;
export type PileName = 'front' | 'middle' | 'back';

export interface HandRank {
  readonly category: HandCategory;
  /** Five descending rank slots; zeroes pad shorter hands for cross-pile comparison. */
  readonly tieBreak: readonly [number, number, number, number, number];
}

export interface Arrangement {
  readonly front: readonly CardId[];
  readonly middle: readonly CardId[];
  readonly back: readonly CardId[];
}

export interface EvaluatedArrangement {
  readonly ranks: Readonly<Record<PileName, HandRank>>;
  readonly foul: boolean;
}

export type ArrangementValidation =
  | { readonly valid: true; readonly value: EvaluatedArrangement }
  | {
      readonly valid: false;
      readonly reason:
        | 'INVALID_HELD_CARDS'
        | 'INVALID_PILE_COUNTS'
        | 'DUPLICATE_CARDS'
        | 'CARDS_NOT_IN_HAND';
    };

export interface PlayerArrangement {
  readonly playerId: string;
  readonly heldCards: readonly CardId[];
  readonly arrangement: Arrangement;
}

export interface ScoringConfig {
  readonly features: {
    readonly frontThreeOfAKind: boolean;
    readonly middleFullHouse: boolean;
    readonly middleFourOfAKind: boolean;
    readonly middleStraightFlush: boolean;
    readonly backFourOfAKind: boolean;
    readonly backStraightFlush: boolean;
    readonly slam: boolean;
    readonly homeRun: boolean;
    readonly foulPayout: boolean;
  };
  readonly payouts: {
    readonly frontThreeOfAKind: number;
    readonly middleFullHouse: number;
    readonly middleFourOfAKind: number;
    readonly middleStraightFlush: number;
    readonly backFourOfAKind: number;
    readonly backStraightFlush: number;
    readonly foul: number;
  };
  readonly slamMultiplier: number;
  readonly homeRunMultiplier: number;
}

export const CLASSIC_V1_SCORING: ScoringConfig = {
  features: {
    frontThreeOfAKind: true,
    middleFullHouse: true,
    middleFourOfAKind: true,
    middleStraightFlush: true,
    backFourOfAKind: true,
    backStraightFlush: true,
    slam: true,
    homeRun: true,
    foulPayout: true,
  },
  payouts: {
    frontThreeOfAKind: 3,
    middleFullHouse: 2,
    middleFourOfAKind: 8,
    middleStraightFlush: 10,
    backFourOfAKind: 4,
    backStraightFlush: 5,
    foul: 6,
  },
  slamMultiplier: 2,
  homeRunMultiplier: 2,
};

export interface PileComparison {
  readonly pile: PileName;
  /** 1 means left wins, -1 means right wins, 0 means tie. */
  readonly result: -1 | 0 | 1;
  readonly water: number;
}

export interface PairSettlement {
  readonly leftPlayerId: string;
  readonly rightPlayerId: string;
  readonly piles: readonly PileComparison[];
  readonly baseWater: number;
  readonly slamMultiplier: number;
  readonly homeRunMultiplier: number;
  /** Positive is a left-player win; right-player score is its exact negative. */
  readonly leftWater: number;
}

export interface RoundSettlement {
  readonly players: readonly {
    readonly playerId: string;
    readonly foul: boolean;
    readonly water: number;
  }[];
  readonly pairs: readonly PairSettlement[];
}

export type AutoArrangeResult =
  | {
      readonly valid: true;
      readonly arrangement: Arrangement;
      readonly evaluation: EvaluatedArrangement;
      readonly candidatesChecked: number;
    }
  | { readonly valid: false; readonly reason: 'INVALID_HELD_CARDS' | 'NO_LEGAL_ARRANGEMENT' };

const PILE_COUNTS: Readonly<Record<PileName, number>> = {
  front: 3,
  middle: 5,
  back: 5,
};

function assertValidCards(cards: readonly CardId[], expectedCount: number): void {
  if (cards.length !== expectedCount) {
    throw new RangeError(`Expected ${expectedCount} cards, received ${cards.length}`);
  }
  if (cards.some((card) => !Number.isInteger(card) || card < 0 || card >= 52)) {
    throw new RangeError('Card IDs must be integers in the range 0..51');
  }
  if (new Set(cards).size !== cards.length) {
    throw new RangeError('A hand cannot contain duplicate cards');
  }
}

function cardRank(card: CardId): number {
  return (card % 13) + 2;
}

function sortedRanks(cards: readonly CardId[]): number[] {
  return cards.map(cardRank).sort((left, right) => right - left);
}

function padded(values: readonly number[]): HandRank['tieBreak'] {
  const result = [...values, 0, 0, 0, 0, 0].slice(0, 5);
  return result as unknown as HandRank['tieBreak'];
}

function straightHigh(ranks: readonly number[]): number | undefined {
  const unique = [...new Set(ranks)].sort((left, right) => right - left);
  if (unique.length !== 5) return undefined;
  if (unique[0] === 14 && unique[1] === 5 && unique[4] === 2) return 5;
  if (unique[0]! - unique[4]! === 4) return unique[0];
  return undefined;
}

function evaluate(cards: readonly CardId[], allowFiveCardHands: boolean): HandRank {
  assertValidCards(cards, allowFiveCardHands ? 5 : 3);
  const ranks = sortedRanks(cards);
  const counts = new Map<number, number>();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  const groups = [...counts.entries()].sort((left, right) =>
    right[1] - left[1] || right[0] - left[0],
  );

  if (!allowFiveCardHands) {
    if (groups[0]?.[1] === 3) return { category: HAND_CATEGORY.THREE_OF_A_KIND, tieBreak: padded([groups[0][0]]) };
    if (groups[0]?.[1] === 2) return { category: HAND_CATEGORY.PAIR, tieBreak: padded([groups[0][0], groups[1]![0]]) };
    return { category: HAND_CATEGORY.HIGH_CARD, tieBreak: padded(ranks) };
  }

  const flush = cards.every((card) => Math.floor(card / 13) === Math.floor(cards[0]! / 13));
  const high = straightHigh(ranks);
  if (flush && high !== undefined) return { category: HAND_CATEGORY.STRAIGHT_FLUSH, tieBreak: padded([high]) };
  if (groups[0]?.[1] === 4) return { category: HAND_CATEGORY.FOUR_OF_A_KIND, tieBreak: padded([groups[0][0], groups[1]![0]]) };
  if (groups[0]?.[1] === 3 && groups[1]?.[1] === 2) {
    return { category: HAND_CATEGORY.FULL_HOUSE, tieBreak: padded([groups[0][0], groups[1][0]]) };
  }
  if (flush) return { category: HAND_CATEGORY.FLUSH, tieBreak: padded(ranks) };
  if (high !== undefined) return { category: HAND_CATEGORY.STRAIGHT, tieBreak: padded([high]) };
  if (groups[0]?.[1] === 3) {
    return { category: HAND_CATEGORY.THREE_OF_A_KIND, tieBreak: padded([groups[0][0], ...ranks.filter((rank) => rank !== groups[0]![0])]) };
  }
  if (groups[0]?.[1] === 2 && groups[1]?.[1] === 2) {
    const pairRanks = [groups[0][0], groups[1][0]].sort((left, right) => right - left);
    const kicker = groups[2]![0];
    return { category: HAND_CATEGORY.TWO_PAIR, tieBreak: padded([...pairRanks, kicker]) };
  }
  if (groups[0]?.[1] === 2) {
    return { category: HAND_CATEGORY.PAIR, tieBreak: padded([groups[0][0], ...ranks.filter((rank) => rank !== groups[0]![0])]) };
  }
  return { category: HAND_CATEGORY.HIGH_CARD, tieBreak: padded(ranks) };
}

export function evaluateFront(cards: readonly CardId[]): HandRank {
  return evaluate(cards, false);
}

export function evaluateFive(cards: readonly CardId[]): HandRank {
  return evaluate(cards, true);
}

export function compareRanks(left: HandRank, right: HandRank): -1 | 0 | 1 {
  if (left.category !== right.category) return left.category > right.category ? 1 : -1;
  for (let index = 0; index < 5; index += 1) {
    const leftValue = left.tieBreak[index]!;
    const rightValue = right.tieBreak[index]!;
    if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
  }
  return 0;
}

export function validateArrangement(
  heldCards: readonly CardId[],
  arrangement: Arrangement,
): ArrangementValidation {
  if (heldCards.length !== 13 || heldCards.some((card) => !Number.isInteger(card) || card < 0 || card >= 52) || new Set(heldCards).size !== 13) {
    return { valid: false, reason: 'INVALID_HELD_CARDS' };
  }
  if (arrangement.front.length !== PILE_COUNTS.front || arrangement.middle.length !== PILE_COUNTS.middle || arrangement.back.length !== PILE_COUNTS.back) {
    return { valid: false, reason: 'INVALID_PILE_COUNTS' };
  }

  const arranged = [...arrangement.front, ...arrangement.middle, ...arrangement.back];
  if (arranged.some((card) => !Number.isInteger(card) || card < 0 || card >= 52)) {
    return { valid: false, reason: 'CARDS_NOT_IN_HAND' };
  }
  if (new Set(arranged).size !== 13) return { valid: false, reason: 'DUPLICATE_CARDS' };

  const held = new Set(heldCards);
  if (arranged.some((card) => !held.has(card))) return { valid: false, reason: 'CARDS_NOT_IN_HAND' };

  const ranks = {
    front: evaluateFront(arrangement.front),
    middle: evaluateFive(arrangement.middle),
    back: evaluateFive(arrangement.back),
  };
  return {
    valid: true,
    value: {
      ranks,
      foul: compareRanks(ranks.front, ranks.middle) > 0 || compareRanks(ranks.middle, ranks.back) > 0,
    },
  };
}

function masksOfSize(total: number, size: number): number[] {
  const masks: number[] = [];
  const visit = (next: number, selected: number, mask: number): void => {
    if (selected === size) {
      masks.push(mask);
      return;
    }
    for (let index = next; index <= total - (size - selected); index += 1) {
      visit(index + 1, selected + 1, mask | (1 << index));
    }
  };
  visit(0, 0, 0);
  return masks;
}

function compareMaskCardOrder(left: number, right: number): -1 | 0 | 1 {
  while (left !== 0 && right !== 0) {
    const leftBit = left & -left;
    const rightBit = right & -right;
    if (leftBit !== rightBit) return leftBit < rightBit ? -1 : 1;
    left ^= leftBit;
    right ^= rightBit;
  }
  return 0;
}

function cardsForMask(cards: readonly CardId[], mask: number): CardId[] {
  const selected: CardId[] = [];
  for (let index = 0; index < cards.length; index += 1) {
    if ((mask & (1 << index)) !== 0) selected.push(cards[index]!);
  }
  return selected;
}

function compareArrangementStrength(
  left: Readonly<Record<PileName, HandRank>>,
  right: Readonly<Record<PileName, HandRank>>,
): -1 | 0 | 1 {
  for (const pile of ['back', 'middle', 'front'] as const) {
    const result = compareRanks(left[pile], right[pile]);
    if (result !== 0) return result;
  }
  return 0;
}

/**
 * Deterministic local/timeout suggestion. This is a bounded heuristic, not an
 * optimal-win-rate solver: among legal layouts it maximizes back, then middle,
 * then front rank, with card IDs as the stable final tie-break.
 */
export function autoArrange(heldCards: readonly CardId[]): AutoArrangeResult {
  if (heldCards.length !== 13 || heldCards.some((card) => !Number.isInteger(card) || card < 0 || card >= 52) || new Set(heldCards).size !== 13) {
    return { valid: false, reason: 'INVALID_HELD_CARDS' };
  }

  const cards = [...heldCards].sort((left, right) => left - right);
  const fiveCardRanks = new Map<number, HandRank>();
  const evaluateFiveCached = (mask: number): HandRank => {
    let rank = fiveCardRanks.get(mask);
    if (!rank) {
      rank = evaluateFive(cardsForMask(cards, mask));
      fiveCardRanks.set(mask, rank);
    }
    return rank;
  };
  const frontMasks = masksOfSize(13, 3);
  const middleMasks = masksOfSize(10, 5);
  const fullMask = (1 << 13) - 1;

  let bestMasks: { readonly front: number; readonly middle: number; readonly back: number } | undefined;
  let bestRanks: EvaluatedArrangement['ranks'] | undefined;
  let candidatesChecked = 0;

  for (const frontMask of frontMasks) {
    const remainingIndices: number[] = [];
    for (let index = 0; index < cards.length; index += 1) {
      if ((frontMask & (1 << index)) === 0) remainingIndices.push(index);
    }
    const frontRank = evaluateFront(cardsForMask(cards, frontMask));

    for (const localMiddleMask of middleMasks) {
      candidatesChecked += 1;
      let middleMask = 0;
      for (let localIndex = 0; localIndex < remainingIndices.length; localIndex += 1) {
        if ((localMiddleMask & (1 << localIndex)) !== 0) middleMask |= 1 << remainingIndices[localIndex]!;
      }
      const middleRank = evaluateFiveCached(middleMask);
      if (compareRanks(frontRank, middleRank) > 0) continue;

      const backMask = fullMask ^ frontMask ^ middleMask;
      const backRank = evaluateFiveCached(backMask);
      if (compareRanks(middleRank, backRank) > 0) continue;

      const candidateRanks = { front: frontRank, middle: middleRank, back: backRank };
      const strength = bestRanks ? compareArrangementStrength(candidateRanks, bestRanks) : 1;
      const tieBreak = bestMasks && strength === 0
        ? compareMaskCardOrder(frontMask, bestMasks.front)
          || compareMaskCardOrder(middleMask, bestMasks.middle)
          || compareMaskCardOrder(backMask, bestMasks.back)
        : 0;
      if (strength > 0 || (strength === 0 && tieBreak < 0)) {
        bestMasks = { front: frontMask, middle: middleMask, back: backMask };
        bestRanks = candidateRanks;
      }
    }
  }

  if (!bestMasks || !bestRanks) return { valid: false, reason: 'NO_LEGAL_ARRANGEMENT' };
  return {
    valid: true,
    arrangement: {
      front: cardsForMask(cards, bestMasks.front),
      middle: cardsForMask(cards, bestMasks.middle),
      back: cardsForMask(cards, bestMasks.back),
    },
    evaluation: { ranks: bestRanks, foul: false },
    candidatesChecked,
  };
}

function payoutFor(pile: PileName, rank: HandRank, config: ScoringConfig): number {
  if (pile === 'front' && rank.category === HAND_CATEGORY.THREE_OF_A_KIND && config.features.frontThreeOfAKind) return config.payouts.frontThreeOfAKind;
  if (pile === 'middle' && rank.category === HAND_CATEGORY.FULL_HOUSE && config.features.middleFullHouse) return config.payouts.middleFullHouse;
  if (pile === 'middle' && rank.category === HAND_CATEGORY.FOUR_OF_A_KIND && config.features.middleFourOfAKind) return config.payouts.middleFourOfAKind;
  if (pile === 'middle' && rank.category === HAND_CATEGORY.STRAIGHT_FLUSH && config.features.middleStraightFlush) return config.payouts.middleStraightFlush;
  if (pile === 'back' && rank.category === HAND_CATEGORY.FOUR_OF_A_KIND && config.features.backFourOfAKind) return config.payouts.backFourOfAKind;
  if (pile === 'back' && rank.category === HAND_CATEGORY.STRAIGHT_FLUSH && config.features.backStraightFlush) return config.payouts.backStraightFlush;
  return 1;
}

function comparePlayerPair(
  left: PlayerArrangement,
  right: PlayerArrangement,
  leftEval: EvaluatedArrangement,
  rightEval: EvaluatedArrangement,
  config: ScoringConfig,
): PairSettlement {
  const pileNames: readonly PileName[] = ['front', 'middle', 'back'];
  const piles: PileComparison[] = pileNames.map((pile) => {
    if (leftEval.foul || rightEval.foul) return { pile, result: 0, water: 0 };
    const result = compareRanks(leftEval.ranks[pile], rightEval.ranks[pile]);
    const water = result === 1
      ? payoutFor(pile, leftEval.ranks[pile], config)
      : result === -1
        ? -payoutFor(pile, rightEval.ranks[pile], config)
        : 0;
    return { pile, result, water };
  });

  let leftWater: number;
  let slamMultiplier = 1;
  if (leftEval.foul && rightEval.foul) {
    leftWater = 0;
  } else if (leftEval.foul || rightEval.foul) {
    leftWater = config.features.foulPayout ? (leftEval.foul ? -config.payouts.foul : config.payouts.foul) : 0;
  } else {
    const baseWater = piles.reduce((total, pile) => total + pile.water, 0);
    const leftSwept = piles.every((pile) => pile.result === 1);
    const rightSwept = piles.every((pile) => pile.result === -1);
    slamMultiplier = config.features.slam && (leftSwept || rightSwept) ? config.slamMultiplier : 1;
    leftWater = baseWater * slamMultiplier;
  }

  const baseWater = piles.reduce((total, pile) => total + pile.water, 0);
  return {
    leftPlayerId: left.playerId,
    rightPlayerId: right.playerId,
    piles,
    baseWater,
    slamMultiplier,
    homeRunMultiplier: 1,
    leftWater,
  };
}

export function settleRound(
  players: readonly PlayerArrangement[],
  config: ScoringConfig = CLASSIC_V1_SCORING,
): RoundSettlement {
  if (players.length !== 4 || new Set(players.map((player) => player.playerId)).size !== 4) {
    throw new RangeError('A classic-v1 round requires four distinct players');
  }
  const allHeldCards = players.flatMap((player) => player.heldCards);
  if (allHeldCards.length !== 52 || new Set(allHeldCards).size !== 52) {
    throw new RangeError('The four players must hold one complete, non-overlapping 52-card deck');
  }

  const evaluated = players.map((player) => {
    const result = validateArrangement(player.heldCards, player.arrangement);
    if (!result.valid) throw new RangeError(`Invalid arrangement for player ${player.playerId}: ${result.reason}`);
    return result.value;
  });
  const pairs: PairSettlement[] = [];
  const scores = new Map(players.map((player) => [player.playerId, 0]));

  for (let leftIndex = 0; leftIndex < players.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < players.length; rightIndex += 1) {
      const left = players[leftIndex]!;
      const right = players[rightIndex]!;
      const pair = comparePlayerPair(left, right, evaluated[leftIndex]!, evaluated[rightIndex]!, config);
      pairs.push(pair);
      scores.set(left.playerId, scores.get(left.playerId)! + pair.leftWater);
      scores.set(right.playerId, scores.get(right.playerId)! - pair.leftWater);
    }
  }

  if (config.features.homeRun && !evaluated.some((entry) => entry.foul)) {
    const sweeper = players.find((player) => pairs
      .filter((pair) => pair.leftPlayerId === player.playerId || pair.rightPlayerId === player.playerId)
      .every((pair) => pair.piles.every((pile) =>
        pile.result === (pair.leftPlayerId === player.playerId ? 1 : -1),
      )),
    );
    if (sweeper) {
      for (let index = 0; index < pairs.length; index += 1) {
        const pair = pairs[index]!;
        if (pair.leftPlayerId !== sweeper.playerId && pair.rightPlayerId !== sweeper.playerId) continue;
        const multiplier = config.homeRunMultiplier;
        const adjustment = pair.leftWater * (multiplier - 1);
        pairs[index] = { ...pair, homeRunMultiplier: multiplier, leftWater: pair.leftWater * multiplier };
        scores.set(pair.leftPlayerId, scores.get(pair.leftPlayerId)! + adjustment);
        scores.set(pair.rightPlayerId, scores.get(pair.rightPlayerId)! - adjustment);
      }
    }
  }

  return {
    players: players.map((player, index) => ({ playerId: player.playerId, foul: evaluated[index]!.foul, water: scores.get(player.playerId)! })),
    pairs,
  };
}

export { simulateShisanshui, SHISANSHUI_MATH_MODEL_VERSION, SHISANSHUI_SIMULATION_STRATEGY } from './simulation.js';
export type { ShisanshuiSimulationReport } from './simulation.js';
