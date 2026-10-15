import { beforeEach, describe, expect, it } from 'vitest';
import { CLASSIC_V1_SCORING } from '@gameing/shisanshui-rules';
import { AgentCapabilityCode } from '@gameing/contracts/invite-agent';
import type { GameMathSimulationReportDto } from '@gameing/contracts/game-math';
import { createAgentGameConfigApplication, type AgentGameConfigRepositoryPort } from './agent-game-config-application';
import type { AgentGameConfigScopeDto, AgentGameConfigSimulationResponseDto, AgentGameConfigWorkspaceDto, AgentShisanshuiScoringDto } from '@gameing/contracts/agent-game-config';

const scope: AgentGameConfigScopeDto = { agentDomainId: '92001', gameKey: 'shisanshui', difficultyKey: 'practice' };
const report: GameMathSimulationReportDto = {
  gameKey: 'shisanshui', difficultyKey: 'practice', configVersion: 'LOCAL_CANDIDATE', modelVersion: 'classic_v1_rank_partition_1', rulesVersion: 'classic_v1',
  seed: 'seed-123', runs: 1000, strategyKey: 'rank_sorted_partition_v1', theoreticalRtp: null, winRate: 0.3, tieRate: 0.2, zeroNetRate: 0.2,
  foulRate: 0.01, slamRate: 0.05, homeRunRate: 0.01, meanNetScore: -0.2, variance: 4, standardDeviation: 2,
  winRate95Ci: [0.27, 0.33], rate95Ci: { win: [0.27, 0.33], tie: [0.17, 0.23], foul: [0.005, 0.02], zeroNet: [0.17, 0.23], slam: [0.03, 0.07], homeRun: [0.005, 0.02] },
  meanNetScore95Ci: [-0.3, -0.1], distribution: [{ netScore: -1, count: 400, share: 0.4 }, { netScore: 0, count: 200, share: 0.2 }, { netScore: 1, count: 400, share: 0.4 }], warnings: [],
};

describe('agent game config offline application', () => {
  let repository: AgentGameConfigRepositoryPort;
  let app: ReturnType<typeof createAgentGameConfigApplication>;
  let saved: AgentGameConfigSimulationResponseDto | null;
  let published = 0;
  beforeEach(() => {
    saved = null;
    published = 0;
    const workspace: AgentGameConfigWorkspaceDto = { scope, platformConfig: structuredClone(CLASSIC_V1_SCORING), effectiveConfig: structuredClone(CLASSIC_V1_SCORING), configVersion: 'BASELINE', modelVersion: report.modelVersion, publishedAt: null, publishedBy: null, source: 'LOCAL_DEMO' };
    repository = {
      async read() { return workspace; },
      async publish(publishScope, config, reason, requestKey, simulationReport) {
        published += 1;
        return { workspace: { ...workspace, effectiveConfig: config, configVersion: 'AGENT_LOCAL_1', publishedAt: new Date().toISOString(), publishedBy: '演练代理' }, auditId: '20261015123456000001', source: 'LOCAL_DEMO' };
      },
    };
    app = createAgentGameConfigApplication(repository, { async run() { return report; } }, localScopeResolver());
  });

  it('validates shared requests and returns a no-stakes simulation scoped to the agent domain', async () => {
    const result = await app.simulate({ target: target(), runs: 1000, seed: 'seed-123', config: structuredClone(CLASSIC_V1_SCORING), reason: '配置预览', requestKey: crypto.randomUUID() });
    expect(result.ok && result.value).toMatchObject({ scope, source: 'LOCAL_DEMO', report: { theoreticalRtp: null, runs: 1000, modelVersion: report.modelVersion } });
    expect((await app.simulate({ target: target(), runs: 500 as 1000, seed: 'seed-123', config: structuredClone(CLASSIC_V1_SCORING), reason: '配置预览', requestKey: crypto.randomUUID() })).ok).toBe(false);
    expect(await app.read({ target: { gameKey: 'slot5', difficultyKey: 'classic' } })).toMatchObject({ ok: false, code: 'SCOPE_UNAVAILABLE' });
    expect(await app.read({ target: target(), agentDomainId: '92002' } as never)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  });

  it('publishes only the exact configuration with a matching completed simulation', async () => {
    const candidate = structuredClone(CLASSIC_V1_SCORING) as AgentShisanshuiScoringDto;
    candidate.payouts.middleFullHouse = 4;
    const simulated = await app.simulate({ target: target(), runs: 1000, seed: 'seed-123', config: candidate, reason: '更新水值前预览', requestKey: crypto.randomUUID() });
    expect(simulated.ok).toBe(true);
    if (!simulated.ok) return;
    saved = simulated.value;
    const publishRequest = { target: target(), config: candidate, simulation: saved, reason: '提高中墩葫芦水值', requestKey: crypto.randomUUID() };
    expect(await app.publish({ ...publishRequest, simulation: { ...saved, report: { ...saved.report, meanNetScore: 99 } } })).toMatchObject({ ok: false, code: 'PUBLISH_REJECTED' });
    expect(published).toBe(0);
    const publishResult = await app.publish(publishRequest);
    if (!publishResult.ok) throw new Error(`publish rejected: ${publishResult.code}`);
    expect(published).toBe(1);
    expect((await app.publish({ ...publishRequest, config: structuredClone(CLASSIC_V1_SCORING) })).ok).toBe(false);
    expect(published).toBe(1);
  });

  it('rechecks the requested domain scope and capability in the application layer', async () => {
    const noPublish = createAgentGameConfigApplication(repository, { async run() { return report; } }, localScopeResolver(AgentCapabilityCode.GAME_CONFIG_PUBLISH));
    const simulated = await noPublish.simulate({ target: target(), runs: 1000, seed: 'seed-123', config: structuredClone(CLASSIC_V1_SCORING), reason: '配置预览', requestKey: crypto.randomUUID() });
    if (!simulated.ok) throw new Error('expected permitted simulation');
    expect(await noPublish.publish({ target: target(), config: structuredClone(CLASSIC_V1_SCORING), simulation: simulated.value, reason: '配置发布', requestKey: crypto.randomUUID() })).toMatchObject({ ok: false, code: 'SCOPE_UNAVAILABLE' });
  });
});

function target() { return { gameKey: 'shisanshui', difficultyKey: 'practice' }; }
function localScopeResolver(denied?: string) {
  const permissions = new Set<string>([AgentCapabilityCode.GAME_CONFIG_READ, AgentCapabilityCode.GAME_CONFIG_SIMULATE, AgentCapabilityCode.GAME_CONFIG_PUBLISH]);
  if (denied) permissions.delete(denied);
  return { resolve(requested: { gameKey: string; difficultyKey: string }, capability: string) {
    return requested.gameKey === scope.gameKey && requested.difficultyKey === scope.difficultyKey && permissions.has(capability) ? scope : null;
  } };
}
