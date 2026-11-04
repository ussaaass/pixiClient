import { CLASSIC_V1_SCORING, SHISANSHUI_MATH_MODEL_VERSION, simulateShisanshui } from '@gameing/shisanshui-rules';
import type { AgentShisanshuiScoringDto } from '@gameing/contracts/agent-game-config';
import type { GameMathSimulationReportDto } from '@gameing/contracts/game-math';
import { AgentCapabilityCode, type AgentCapabilityCodeValue } from '@gameing/contracts/invite-agent';
import type { AgentGameConfigScopeDto, AgentGameConfigTargetDto } from '@gameing/contracts/agent-game-config';
import { createAgentGameConfigApplication, type AgentGameConfigScopeResolverPort, type AgentShisanshuiSimulationPort } from './agent-game-config-application';
import { IndexedDbAgentGameConfigAdapter } from './indexeddb-agent-game-config-adapter';
import { RemoteAgentGameConfigAdapter } from './remote-agent-game-config-adapter.js';
import { AdminApiClient } from '../admin-api-client.js';

const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE;
const localCapabilities = new Set<string>([AgentCapabilityCode.GAME_CONFIG_READ, AgentCapabilityCode.GAME_CONFIG_SIMULATE, AgentCapabilityCode.GAME_CONFIG_PUBLISH]);

const simulator: AgentShisanshuiSimulationPort = {
  async run(input: { scope: AgentGameConfigScopeDto; runs: 1000 | 10000; seed: string; scoring: AgentShisanshuiScoringDto; onProgress?: (completed: number, total: number) => void; yieldControl?: () => Promise<void> }): Promise<GameMathSimulationReportDto> {
    const result = await simulateShisanshui({
      runs: input.runs,
      seed: input.seed,
      scoring: input.scoring,
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.yieldControl ? { yieldControl: input.yieldControl } : {}),
    });
    return {
      gameKey: input.scope.gameKey,
      difficultyKey: input.scope.difficultyKey,
      configVersion: 'LOCAL_CANDIDATE',
      modelVersion: result.modelVersion || SHISANSHUI_MATH_MODEL_VERSION,
      rulesVersion: result.rulesVersion,
      seed: result.seed,
      runs: result.runs,
      strategyKey: result.strategyKey,
      theoreticalRtp: null,
      winRate: result.winRate,
      tieRate: result.tieRate,
      zeroNetRate: result.zeroNetRate,
      foulRate: result.foulRate,
      slamRate: result.slamRate,
      homeRunRate: result.homeRunRate,
      meanNetScore: result.meanNetScore,
      variance: result.variance,
      standardDeviation: result.standardDeviation,
      winRate95Ci: [...result.winRate95Ci] as [number, number],
      rate95Ci: {
        win: [...result.rate95Ci.win] as [number, number],
        tie: [...result.rate95Ci.tie] as [number, number],
        foul: [...result.rate95Ci.foul] as [number, number],
        zeroNet: [...result.rate95Ci.zeroNet] as [number, number],
        slam: [...result.rate95Ci.slam] as [number, number],
        homeRun: [...result.rate95Ci.homeRun] as [number, number],
      },
      meanNetScore95Ci: [...result.meanNetScore95Ci] as [number, number],
      distribution: [...result.distribution],
      warnings: [...result.warnings],
    };
  },
};

const scopeResolver: AgentGameConfigScopeResolverPort = {
  resolve: (target: AgentGameConfigTargetDto, capability: AgentCapabilityCodeValue): AgentGameConfigScopeDto | null =>
    target.gameKey === 'shisanshui' && target.difficultyKey === 'practice' && localCapabilities.has(capability)
      ? { agentDomainId: '92001', gameKey: 'shisanshui', difficultyKey: 'practice' }
      : null,
};

export function createAgentGameConfigApp({ useRemote = false }: { useRemote?: boolean } = {}) {
  const remote = useRemote || Boolean(adminApiBase);
  const repository = remote
    ? new RemoteAgentGameConfigAdapter(new AdminApiClient({
        base: adminApiBase ?? '/admin-api/v1',
        getToken: () => sessionStorage.getItem('admin.accessToken') ?? null,
      }))
    : new IndexedDbAgentGameConfigAdapter(CLASSIC_V1_SCORING);
  return createAgentGameConfigApplication(repository, simulator, scopeResolver);
}

export const agentGameConfigApplication = createAgentGameConfigApp({ useRemote: false });
