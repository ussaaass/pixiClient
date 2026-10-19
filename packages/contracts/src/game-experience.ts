import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { GameCatalogDtoSchema } from './game-catalog.js';

const PositiveIntegerString = Type.String({ pattern: '^[1-9][0-9]{0,17}$' });
const RuleSectionSchema = Type.Object({ title: Type.String({ minLength: 1, maxLength: 32 }), body: Type.String({ minLength: 1, maxLength: 240 }) }, { additionalProperties: false });
const ReferenceSchema = Type.Object({ title: Type.String({ minLength: 1, maxLength: 80 }), url: Type.String({ pattern: '^https://[^\\s/]+(?:/[^\\s]*)?$', maxLength: 2048 }) }, { additionalProperties: false });
export const GameDifficultyHallSchema = Type.Object({
  difficultyKey: Type.String({ pattern: '^[a-z][a-z0-9_-]{1,47}$' }),
  title: Type.String({ minLength: 1, maxLength: 40 }),
  summary: Type.String({ minLength: 1, maxLength: 120 }),
  minBetCoins: PositiveIntegerString,
  currentMultiplier: Type.Integer({ minimum: 1, maximum: 1000000 }),
  maxMultiplier: Type.Integer({ minimum: 1, maximum: 1000000 }),
  sortOrder: Type.Integer({ minimum: 1, maximum: 1000000 }),
  enabled: Type.Boolean(),
}, { additionalProperties: false });
export const GameExperienceDtoSchema = Type.Object({
  source: Type.Union([Type.Literal('LOCAL_DEMO'), Type.Literal('SERVER')]),
  game: GameCatalogDtoSchema,
  title: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.String({ minLength: 1, maxLength: 240 }),
  gameplay: Type.Array(RuleSectionSchema, { minItems: 1, maxItems: 12 }),
  subhallBackgroundAssetId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
  subhallBackgroundUrl: Type.String({ minLength: 1, maxLength: 2048 }),
  difficultyHalls: Type.Array(GameDifficultyHallSchema, { minItems: 1, maxItems: 20 }),
  entryMode: Type.Union([Type.Literal('LOCAL_PRACTICE'), Type.Literal('MODULE_STUB')]),
  attribution: Type.String({ minLength: 1, maxLength: 240 }),
  references: Type.Array(ReferenceSchema, { maxItems: 4 }),
}, { additionalProperties: false });
export const GameExperienceListResponseSchema = Type.Array(GameExperienceDtoSchema, { maxItems: 100 });
export const GamePreflightResponseSchema = Type.Object({
  gameKey: Type.String({ minLength: 2, maxLength: 64 }),
  difficultyKey: Type.String({ minLength: 2, maxLength: 48 }),
  availability: Type.Union([Type.Literal('READY'), Type.Literal('MODULE_UNAVAILABLE')]),
  source: Type.Union([Type.Literal('LOCAL_DEMO'), Type.Literal('SERVER')]),
  message: Type.String({ minLength: 1, maxLength: 240 }),
}, { additionalProperties: false });

export const GameExperienceEndpoint = {
  list: { method: 'GET', path: '/api/v1/games/experience', response: GameExperienceListResponseSchema, successStatus: 200 },
  detail: { method: 'GET', path: '/api/v1/games/:gameKey/experience', response: GameExperienceDtoSchema, successStatus: 200 },
  preflight: { method: 'GET', path: '/api/v1/games/:gameKey/difficulties/:difficultyKey/preflight', response: GamePreflightResponseSchema, successStatus: 200 },
} as const;
export type GameDifficultyHallDto = Static<typeof GameDifficultyHallSchema>;
export type GameExperienceDto = Static<typeof GameExperienceDtoSchema>;
export type GamePreflightResponseDto = Static<typeof GamePreflightResponseSchema>;
