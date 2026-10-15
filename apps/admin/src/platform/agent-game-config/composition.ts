import { CLASSIC_V1_SCORING, SHISANSHUI_MATH_MODEL_VERSION, simulateShisanshui } from '@gameing/shisanshui-rules';
import type { AgentShisanshuiScoringDto } from '@gameing/contracts/agent-game-config';
import { AgentCapabilityCode } from '@gameing/contracts/invite-agent';
import { createAgentGameConfigApplication } from './agent-game-config-application';
import { IndexedDbAgentGameConfigAdapter } from './indexeddb-agent-game-config-adapter';

const adapter = new IndexedDbAgentGameConfigAdapter(CLASSIC_V1_SCORING);
const localCapabilities = new Set<string>([AgentCapabilityCode.GAME_CONFIG_READ, AgentCapabilityCode.GAME_CONFIG_SIMULATE, AgentCapabilityCode.GAME_CONFIG_PUBLISH]);
export const agentGameConfigApplication = createAgentGameConfigApplication(adapter, {
  async run(input) {
    const result = await simulateShisanshui({ runs: input.runs, seed: input.seed, scoring: input.scoring as AgentShisanshuiScoringDto, ...(input.onProgress ? { onProgress: input.onProgress } : {}), ...(input.yieldControl ? { yieldControl: input.yieldControl } : {}) });
    return {
      gameKey: input.scope.gameKey, difficultyKey: input.scope.difficultyKey, configVersion: 'LOCAL_CANDIDATE',
      modelVersion: result.modelVersion || SHISANSHUI_MATH_MODEL_VERSION, rulesVersion: result.rulesVersion, seed: result.seed, runs: result.runs,
      strategyKey: result.strategyKey, theoreticalRtp: null, winRate: result.winRate, tieRate: result.tieRate, zeroNetRate: result.zeroNetRate,
      foulRate: result.foulRate, slamRate: result.slamRate, homeRunRate: result.homeRunRate, meanNetScore: result.meanNetScore,
      variance: result.variance, standardDeviation: result.standardDeviation, winRate95Ci: [...result.winRate95Ci] as [number, number],
      rate95Ci: { win: [...result.rate95Ci.win] as [number, number], tie: [...result.rate95Ci.tie] as [number, number], foul: [...result.rate95Ci.foul] as [number, number], zeroNet: [...result.rate95Ci.zeroNet] as [number, number], slam: [...result.rate95Ci.slam] as [number, number], homeRun: [...result.rate95Ci.homeRun] as [number, number] },
      meanNetScore95Ci: [...result.meanNetScore95Ci] as [number, number], distribution: [...result.distribution], warnings: [...result.warnings],
    };
  },
}, { resolve: (target, capability) => target.gameKey === 'shisanshui' && target.difficultyKey === 'practice' && localCapabilities.has(capability)
  ? { agentDomainId: '92001', gameKey: 'shisanshui', difficultyKey: 'practice' } : null });
