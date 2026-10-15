import {
  CLASSIC_V1_SCORING,
  settleRound,
  type PlayerArrangement,
  type ScoringConfig,
} from './index.js';

export const SHISANSHUI_MATH_MODEL_VERSION = 'classic_v1_rank_partition_1';
export const SHISANSHUI_SIMULATION_STRATEGY = 'rank_sorted_partition_v1';

export interface ShisanshuiSimulationReport {
  readonly runs: number;
  readonly seed: string;
  readonly strategyKey: string;
  readonly modelVersion: string;
  readonly rulesVersion: 'classic_v1';
  readonly theoreticalRtp: null;
  readonly winRate: number;
  readonly tieRate: number;
  readonly zeroNetRate: number;
  readonly foulRate: number;
  readonly slamRate: number;
  readonly homeRunRate: number;
  readonly meanNetScore: number;
  readonly variance: number;
  readonly standardDeviation: number;
  readonly winRate95Ci: readonly [number, number];
  readonly rate95Ci: {
    readonly win: readonly [number, number];
    readonly tie: readonly [number, number];
    readonly foul: readonly [number, number];
    readonly zeroNet: readonly [number, number];
    readonly slam: readonly [number, number];
    readonly homeRun: readonly [number, number];
  };
  readonly meanNetScore95Ci: readonly [number, number];
  readonly distribution: readonly { readonly netScore: number; readonly count: number; readonly share: number }[];
  readonly warnings: readonly string[];
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function wilson95(successes: number, total: number): readonly [number, number] {
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const radius = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

function arrangeByRank(heldCards: readonly number[]): PlayerArrangement {
  const ordered = [...heldCards].sort((left, right) => left % 13 - right % 13 || left - right);
  return {
    playerId: 'seat-0', heldCards,
    arrangement: { front: ordered.slice(0, 3), middle: ordered.slice(3, 8), back: ordered.slice(8, 13) },
  };
}

/**
 * Deterministic strategy-based table simulation. It intentionally reports no RTP:
 * this is a player-vs-player scoring model, not a single-player return game.
 */
export async function simulateShisanshui(input: {
  readonly runs: 1000 | 10000;
  readonly seed: string;
  readonly scoring?: ScoringConfig;
  readonly onProgress?: (completed: number, total: number) => void;
  readonly yieldControl?: () => Promise<void>;
}): Promise<ShisanshuiSimulationReport> {
  if (!input.seed.trim() || input.seed.length > 128) throw new RangeError('INVALID_SEED');
  const random = seededRandom(input.seed);
  const scoring = input.scoring ?? CLASSIC_V1_SCORING;
  const scores: number[] = [];
  let wins = 0; let ties = 0; let fouls = 0; let slams = 0; let homeRuns = 0;

  for (let run = 0; run < input.runs; run += 1) {
    const deck = Array.from({ length: 52 }, (_, card) => card);
    for (let index = deck.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [deck[index], deck[swap]] = [deck[swap]!, deck[index]!];
    }
    const players = Array.from({ length: 4 }, (_, seat) => {
      const player = arrangeByRank(deck.slice(seat * 13, seat * 13 + 13));
      return { ...player, playerId: `seat-${seat}` };
    });
    const settled = settleRound(players, scoring);
    const score = settled.players[0]!.water;
    scores.push(score);
    if (score > 0) wins += 1;
    else if (score === 0) ties += 1;
    if (settled.players[0]!.foul) fouls += 1;
    const targetPairs = settled.pairs.filter((pair) => pair.leftPlayerId === 'seat-0' || pair.rightPlayerId === 'seat-0');
    if (targetPairs.some((pair) => pair.piles.every((pile) => pile.result === (pair.leftPlayerId === 'seat-0' ? 1 : -1)))) slams += 1;
    const targetSweptTheTable = targetPairs.length === 3
      && !settled.players[0]!.foul
      && targetPairs.every((pair) => pair.piles.every((pile) => pile.result === (pair.leftPlayerId === 'seat-0' ? 1 : -1)));
    if (targetSweptTheTable) homeRuns += 1;
    if ((run + 1) % 100 === 0) {
      input.onProgress?.(run + 1, input.runs);
      await (input.yieldControl?.() ?? Promise.resolve());
    }
  }

  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const variance = scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / (scores.length - 1);
  const buckets = new Map<number, number>();
  for (const score of scores) buckets.set(score, (buckets.get(score) ?? 0) + 1);
  const winRate = wins / input.runs;
  const tieRate = ties / input.runs;
  const zeroNetRate = scores.filter((score) => score === 0).length / input.runs;
  const foulRate = fouls / input.runs;
  const slamRate = slams / input.runs;
  const homeRunRate = homeRuns / input.runs;
  const standardDeviation = Math.sqrt(variance);
  const meanMargin = 1.959963984540054 * standardDeviation / Math.sqrt(input.runs);
  return {
    runs: input.runs, seed: input.seed, strategyKey: SHISANSHUI_SIMULATION_STRATEGY,
    modelVersion: SHISANSHUI_MATH_MODEL_VERSION, rulesVersion: 'classic_v1', theoreticalRtp: null,
    winRate, tieRate, zeroNetRate, foulRate, slamRate, homeRunRate,
    meanNetScore: mean, variance, standardDeviation, winRate95Ci: wilson95(wins, input.runs),
    rate95Ci: {
      win: wilson95(wins, input.runs), tie: wilson95(ties, input.runs),
      foul: wilson95(fouls, input.runs), zeroNet: wilson95(scores.filter((score) => score === 0).length, input.runs),
      slam: wilson95(slams, input.runs), homeRun: wilson95(homeRuns, input.runs),
    },
    meanNetScore95Ci: [mean - meanMargin, mean + meanMargin],
    distribution: [...buckets].sort(([left], [right]) => left - right).map(([netScore, count]) => ({ netScore, count, share: count / input.runs })),
    warnings: [
      '这是固定排序策略对阵三个同策略样本的演示，不代表生产机器人或真实玩家策略分布。',
      '十三张为玩家对战模型，RTP 不适用；净分以水计，不含金币档位、手续费或账户记账。',
      ...(input.runs === 1000 ? ['1000 局只能快速检查；罕见的打枪/全垒打事件可能无法可靠估计。'] : []),
    ],
  };
}
