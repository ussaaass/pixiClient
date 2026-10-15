import { Type, type Static } from '@sinclair/typebox';

/** Shared request envelope for isolated, no-stakes game math previews. */
export const GameMathSimulationRequestSchema = Type.Object({
  gameKey: Type.String({ minLength: 1, maxLength: 64 }),
  difficultyKey: Type.String({ minLength: 1, maxLength: 64 }),
  runs: Type.Union([Type.Literal(1000), Type.Literal(10000)]),
  seed: Type.String({ minLength: 1, maxLength: 128 }),
  configVersion: Type.String({ minLength: 1, maxLength: 64 }),
  modelVersion: Type.String({ minLength: 1, maxLength: 64 }),
  config: Type.Record(Type.String(), Type.Union([Type.Boolean(), Type.Number(), Type.String()])),
}, { additionalProperties: false });

export const GameMathDistributionItemSchema = Type.Object({
  netScore: Type.Integer(),
  count: Type.Integer({ minimum: 0 }),
  share: Type.Number({ minimum: 0, maximum: 1 }),
}, { additionalProperties: false });

export const GameMathSimulationReportSchema = Type.Object({
  gameKey: Type.String(), difficultyKey: Type.String(), configVersion: Type.String(), modelVersion: Type.String(),
  rulesVersion: Type.String(), seed: Type.String(), runs: Type.Integer({ minimum: 1 }),
  strategyKey: Type.String(), theoreticalRtp: Type.Union([Type.Number(), Type.Null()]),
  winRate: Type.Number({ minimum: 0, maximum: 1 }), tieRate: Type.Number({ minimum: 0, maximum: 1 }),
  zeroNetRate: Type.Number({ minimum: 0, maximum: 1 }), foulRate: Type.Number({ minimum: 0, maximum: 1 }),
  slamRate: Type.Number({ minimum: 0, maximum: 1 }), homeRunRate: Type.Number({ minimum: 0, maximum: 1 }),
  meanNetScore: Type.Number(), variance: Type.Number({ minimum: 0 }), standardDeviation: Type.Number({ minimum: 0 }),
  winRate95Ci: Type.Tuple([Type.Number(), Type.Number()]),
  rate95Ci: Type.Object({
    win: Type.Tuple([Type.Number(), Type.Number()]),
    tie: Type.Tuple([Type.Number(), Type.Number()]),
    foul: Type.Tuple([Type.Number(), Type.Number()]),
    zeroNet: Type.Tuple([Type.Number(), Type.Number()]),
    slam: Type.Tuple([Type.Number(), Type.Number()]),
    homeRun: Type.Tuple([Type.Number(), Type.Number()]),
  }, { additionalProperties: false }),
  meanNetScore95Ci: Type.Tuple([Type.Number(), Type.Number()]),
  distribution: Type.Array(GameMathDistributionItemSchema), warnings: Type.Array(Type.String()),
}, { additionalProperties: false });

export type GameMathSimulationRequestDto = Static<typeof GameMathSimulationRequestSchema>;
export type GameMathSimulationReportDto = Static<typeof GameMathSimulationReportSchema>;
