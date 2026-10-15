import { Value } from '@sinclair/typebox/value';
import {
  AgentGameConfigPublishRequestSchema, AgentGameConfigPublishResponseSchema,
  AgentGameConfigReadRequestSchema, AgentGameConfigSimulationRequestSchema, AgentGameConfigSimulationResponseSchema,
  AgentGameConfigWorkspaceSchema, type AgentGameConfigPublishRequestDto,
  type AgentGameConfigPublishResponseDto, type AgentGameConfigScopeDto,
  type AgentGameConfigSimulationRequestDto, type AgentGameConfigSimulationResponseDto, type AgentGameConfigTargetDto, type AgentGameConfigReadRequestDto,
  type AgentGameConfigWorkspaceDto, type AgentShisanshuiScoringDto,
} from '@gameing/contracts/agent-game-config';
import { GameMathSimulationReportSchema, type GameMathSimulationReportDto } from '@gameing/contracts/game-math';
import { AgentCapabilityCode, type AgentCapabilityCodeValue } from '@gameing/contracts/invite-agent';

export interface AgentGameConfigRepositoryPort {
  read(scope: AgentGameConfigScopeDto): Promise<AgentGameConfigWorkspaceDto>;
  publish(scope: AgentGameConfigScopeDto, config: AgentShisanshuiScoringDto, reason: string, requestKey: string, report: AgentGameConfigSimulationResponseDto['report']): Promise<AgentGameConfigPublishResponseDto>;
}
export interface AgentShisanshuiSimulationPort {
  run(input: { scope: AgentGameConfigScopeDto; runs: 1000 | 10000; seed: string; scoring: AgentShisanshuiScoringDto; onProgress?: (completed: number, total: number) => void; yieldControl?: () => Promise<void> }): Promise<GameMathSimulationReportDto>;
}
export interface AgentGameConfigScopeResolverPort { resolve(target: AgentGameConfigTargetDto, capability: AgentCapabilityCodeValue): AgentGameConfigScopeDto | null; }
export type AgentGameConfigResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: 'INVALID_REQUEST' | 'SCOPE_UNAVAILABLE' | 'MODEL_FAILED' | 'INVALID_RESPONSE' | 'PUBLISH_REJECTED' };

export function createAgentGameConfigApplication(repository: AgentGameConfigRepositoryPort, simulator: AgentShisanshuiSimulationPort, scopeResolver: AgentGameConfigScopeResolverPort) {
  return {
    async read(request: AgentGameConfigReadRequestDto): Promise<AgentGameConfigResult<AgentGameConfigWorkspaceDto>> {
      if (!Value.Check(AgentGameConfigReadRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
      const scope = scopeResolver.resolve(request.target, AgentCapabilityCode.GAME_CONFIG_READ);
      if (!scope) return { ok: false, code: 'SCOPE_UNAVAILABLE' };
      try {
        const workspace = await repository.read(scope);
        return Value.Check(AgentGameConfigWorkspaceSchema, workspace) && sameScope(scope, workspace.scope) ? { ok: true, value: workspace } : { ok: false, code: 'INVALID_RESPONSE' };
      } catch { return { ok: false, code: 'SCOPE_UNAVAILABLE' }; }
    },
    async simulate(request: AgentGameConfigSimulationRequestDto, onProgress?: (completed: number, total: number) => void, yieldControl?: () => Promise<void>): Promise<AgentGameConfigResult<AgentGameConfigSimulationResponseDto>> {
      if (!Value.Check(AgentGameConfigSimulationRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
      const scope = scopeResolver.resolve(request.target, AgentCapabilityCode.GAME_CONFIG_SIMULATE);
      if (!scope) return { ok: false, code: 'SCOPE_UNAVAILABLE' };
      try {
        const workspaceResult = await readWorkspace(scope);
        if (!workspaceResult.ok) return workspaceResult;
        const report = await simulator.run({ scope, runs: request.runs, seed: request.seed, scoring: request.config, ...(onProgress ? { onProgress } : {}), ...(yieldControl ? { yieldControl } : {}) });
        if (report.gameKey !== scope.gameKey || report.difficultyKey !== scope.difficultyKey || report.runs !== request.runs || report.seed !== request.seed) return { ok: false, code: 'INVALID_RESPONSE' };
        const response: AgentGameConfigSimulationResponseDto = { scope, config: request.config, report, source: 'LOCAL_DEMO' };
        return Value.Check(GameMathSimulationReportSchema, report) && Value.Check(AgentGameConfigSimulationResponseSchema, response)
          ? { ok: true, value: response } : { ok: false, code: 'INVALID_RESPONSE' };
      } catch { return { ok: false, code: 'MODEL_FAILED' }; }
    },
    async publish(request: AgentGameConfigPublishRequestDto): Promise<AgentGameConfigResult<AgentGameConfigPublishResponseDto>> {
      if (!Value.Check(AgentGameConfigPublishRequestSchema, request)) return { ok: false, code: 'INVALID_REQUEST' };
      const scope = scopeResolver.resolve(request.target, AgentCapabilityCode.GAME_CONFIG_PUBLISH);
      if (!scope) return { ok: false, code: 'SCOPE_UNAVAILABLE' };
      const simulation = request.simulation;
      if (!sameScope(scope, simulation.scope) || !sameConfig(request.config, simulation.config)
        || (simulation.report.runs !== 1000 && simulation.report.runs !== 10000)
        || simulation.report.gameKey !== scope.gameKey || simulation.report.difficultyKey !== scope.difficultyKey
        || simulation.report.modelVersion !== 'classic_v1_rank_partition_1') return { ok: false, code: 'PUBLISH_REJECTED' };
      try {
        const verifiedReport = await simulator.run({ scope, runs: simulation.report.runs, seed: simulation.report.seed, scoring: request.config });
        if (stableSerialize(verifiedReport) !== stableSerialize(simulation.report)) return { ok: false, code: 'PUBLISH_REJECTED' };
        const result = await repository.publish(scope, request.config, request.reason.trim(), request.requestKey, simulation.report);
        return Value.Check(AgentGameConfigPublishResponseSchema, result) && sameScope(scope, result.workspace.scope)
          && sameConfig(request.config, result.workspace.effectiveConfig) ? { ok: true, value: result } : { ok: false, code: 'INVALID_RESPONSE' };
      } catch { return { ok: false, code: 'PUBLISH_REJECTED' }; }
    },
  };

  async function readWorkspace(scope: AgentGameConfigScopeDto): Promise<AgentGameConfigResult<AgentGameConfigWorkspaceDto>> {
    if (!Value.Check(AgentGameConfigWorkspaceSchema.properties.scope, scope)) return { ok: false, code: 'INVALID_REQUEST' };
    try {
      const workspace = await repository.read(scope);
      return Value.Check(AgentGameConfigWorkspaceSchema, workspace) && sameScope(scope, workspace.scope) ? { ok: true, value: workspace } : { ok: false, code: 'INVALID_RESPONSE' };
    } catch { return { ok: false, code: 'SCOPE_UNAVAILABLE' }; }
  }
}

function sameScope(left: AgentGameConfigScopeDto, right: AgentGameConfigScopeDto): boolean {
  return left.agentDomainId === right.agentDomainId && left.gameKey === right.gameKey && left.difficultyKey === right.difficultyKey;
}
function sameConfig(left: AgentShisanshuiScoringDto, right: AgentShisanshuiScoringDto): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
