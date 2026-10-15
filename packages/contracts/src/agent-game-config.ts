import { Type, type Static } from '@sinclair/typebox';
import { GameMathSimulationReportSchema } from './game-math.js';

export const AgentGameConfigSource = { LOCAL_DEMO: 'LOCAL_DEMO', SERVER: 'SERVER' } as const;
export const AgentShisanshuiScoringSchema = Type.Object({
  features: Type.Object({
    frontThreeOfAKind: Type.Boolean(), middleFullHouse: Type.Boolean(), middleFourOfAKind: Type.Boolean(),
    middleStraightFlush: Type.Boolean(), backFourOfAKind: Type.Boolean(), backStraightFlush: Type.Boolean(),
    slam: Type.Boolean(), homeRun: Type.Boolean(), foulPayout: Type.Boolean(),
  }, { additionalProperties: false }),
  payouts: Type.Object({
    frontThreeOfAKind: Type.Integer({ minimum: 1, maximum: 1000 }), middleFullHouse: Type.Integer({ minimum: 1, maximum: 1000 }),
    middleFourOfAKind: Type.Integer({ minimum: 1, maximum: 1000 }), middleStraightFlush: Type.Integer({ minimum: 1, maximum: 1000 }),
    backFourOfAKind: Type.Integer({ minimum: 1, maximum: 1000 }), backStraightFlush: Type.Integer({ minimum: 1, maximum: 1000 }),
    foul: Type.Integer({ minimum: 1, maximum: 1000 }),
  }, { additionalProperties: false }),
  slamMultiplier: Type.Integer({ minimum: 1, maximum: 1000 }), homeRunMultiplier: Type.Integer({ minimum: 1, maximum: 1000 }),
}, { additionalProperties: false });

const Uuid = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
const Timestamp = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });
export const AgentGameConfigTargetSchema = Type.Object({ gameKey: Type.String({ minLength: 1, maxLength: 64 }), difficultyKey: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false });
export const AgentGameConfigScopeSchema = Type.Object({ agentDomainId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), gameKey: Type.Literal('shisanshui'), difficultyKey: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false });
export const AgentGameConfigReadRequestSchema = Type.Object({ target: AgentGameConfigTargetSchema }, { additionalProperties: false });
export const AgentGameConfigWorkspaceSchema = Type.Object({
  scope: AgentGameConfigScopeSchema,
  platformConfig: AgentShisanshuiScoringSchema,
  effectiveConfig: AgentShisanshuiScoringSchema,
  configVersion: Type.String({ minLength: 1, maxLength: 64 }),
  modelVersion: Type.String({ minLength: 1, maxLength: 64 }),
  publishedAt: Type.Union([Timestamp, Type.Null()]),
  publishedBy: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  source: Type.Union([Type.Literal(AgentGameConfigSource.LOCAL_DEMO), Type.Literal(AgentGameConfigSource.SERVER)]),
}, { additionalProperties: false });
export const AgentGameConfigSimulationRequestSchema = Type.Object({
  target: AgentGameConfigTargetSchema, runs: Type.Union([Type.Literal(1000), Type.Literal(10000)]), seed: Type.String({ minLength: 1, maxLength: 128 }),
  config: AgentShisanshuiScoringSchema, reason: Type.String({ minLength: 3, maxLength: 240 }), requestKey: Uuid,
}, { additionalProperties: false });
export const AgentGameConfigSimulationResponseSchema = Type.Object({
  scope: AgentGameConfigScopeSchema, config: AgentShisanshuiScoringSchema, report: GameMathSimulationReportSchema,
  source: Type.Union([Type.Literal(AgentGameConfigSource.LOCAL_DEMO), Type.Literal(AgentGameConfigSource.SERVER)]),
}, { additionalProperties: false });
export const AgentGameConfigPublishRequestSchema = Type.Object({
  target: AgentGameConfigTargetSchema, config: AgentShisanshuiScoringSchema,
  simulation: AgentGameConfigSimulationResponseSchema, reason: Type.String({ minLength: 3, maxLength: 240 }), requestKey: Uuid,
}, { additionalProperties: false });
export const AgentGameConfigPublishResponseSchema = Type.Object({ workspace: AgentGameConfigWorkspaceSchema, auditId: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }), source: Type.Union([Type.Literal(AgentGameConfigSource.LOCAL_DEMO), Type.Literal(AgentGameConfigSource.SERVER)]) }, { additionalProperties: false });

export const AgentGameConfigEndpoints = {
  read: { method: 'GET', path: '/api/v1/agent/games/:gameKey/difficulties/:difficultyKey/config', params: AgentGameConfigTargetSchema, response: AgentGameConfigWorkspaceSchema, successStatus: 200 },
  simulate: { method: 'POST', path: '/api/v1/agent/games/:gameKey/difficulties/:difficultyKey/simulations', body: AgentGameConfigSimulationRequestSchema, response: AgentGameConfigSimulationResponseSchema, successStatus: 200 },
  publish: { method: 'POST', path: '/api/v1/agent/games/:gameKey/difficulties/:difficultyKey/config/publish', body: AgentGameConfigPublishRequestSchema, response: AgentGameConfigPublishResponseSchema, successStatus: 200 },
} as const;

export type AgentShisanshuiScoringDto = Static<typeof AgentShisanshuiScoringSchema>;
export type AgentGameConfigScopeDto = Static<typeof AgentGameConfigScopeSchema>;
export type AgentGameConfigTargetDto = Static<typeof AgentGameConfigTargetSchema>;
export type AgentGameConfigReadRequestDto = Static<typeof AgentGameConfigReadRequestSchema>;
export type AgentGameConfigWorkspaceDto = Static<typeof AgentGameConfigWorkspaceSchema>;
export type AgentGameConfigSimulationRequestDto = Static<typeof AgentGameConfigSimulationRequestSchema>;
export type AgentGameConfigSimulationResponseDto = Static<typeof AgentGameConfigSimulationResponseSchema>;
export type AgentGameConfigPublishRequestDto = Static<typeof AgentGameConfigPublishRequestSchema>;
export type AgentGameConfigPublishResponseDto = Static<typeof AgentGameConfigPublishResponseSchema>;
