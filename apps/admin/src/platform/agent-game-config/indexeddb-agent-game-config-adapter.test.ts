import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { CLASSIC_V1_SCORING } from '@gameing/shisanshui-rules';
import type { GameMathSimulationReportDto } from '@gameing/contracts/game-math';
import type { AgentShisanshuiScoringDto } from '@gameing/contracts/agent-game-config';
import { openAdminDevelopmentDatabase } from '../browser-development-database';
import { IndexedDbAgentGameConfigAdapter } from './indexeddb-agent-game-config-adapter';

const report: GameMathSimulationReportDto = {
  gameKey: 'shisanshui', difficultyKey: 'practice', configVersion: 'LOCAL_CANDIDATE', modelVersion: 'classic_v1_rank_partition_1', rulesVersion: 'classic_v1', seed: 's1', runs: 1000,
  strategyKey: 'rank_sorted_partition_v1', theoreticalRtp: null, winRate: 0.2, tieRate: 0.1, zeroNetRate: 0.1, foulRate: 0.01, slamRate: 0.02, homeRunRate: 0.01,
  meanNetScore: -1, variance: 3, standardDeviation: 1.7, winRate95Ci: [0.1, 0.3], rate95Ci: { win: [0.1, 0.3], tie: [0.05, 0.2], foul: [0, 0.03], zeroNet: [0.05, 0.2], slam: [0, 0.05], homeRun: [0, 0.03] },
  meanNetScore95Ci: [-1.2, -0.8], distribution: [{ netScore: -1, count: 1000, share: 1 }], warnings: [],
};

describe('IndexedDbAgentGameConfigAdapter', () => {
  const databaseNames: string[] = [];
  afterEach(async () => {
    await Promise.all(databaseNames.splice(0).map((name) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`blocked: ${name}`));
    })));
  });

  it('atomically saves current config and immutable audit and survives reopening', async () => {
    const name = `agent-game-config-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const scope = { agentDomainId: '92001', gameKey: 'shisanshui' as const, difficultyKey: 'practice' };
    const adapter = new IndexedDbAgentGameConfigAdapter(CLASSIC_V1_SCORING, name);
    const config = structuredClone(CLASSIC_V1_SCORING) as AgentShisanshuiScoringDto;
    config.payouts.middleFullHouse = 5;
    const result = await adapter.publish(scope, config, '验证配置发布', crypto.randomUUID(), report);
    const firstRequestKey = await openAuditRequestKey(name);
    expect(result.workspace.effectiveConfig.payouts.middleFullHouse).toBe(5);
    expect(result.auditId).toMatch(/^[1-9][0-9]{0,19}$/);

    const reopened = new IndexedDbAgentGameConfigAdapter(CLASSIC_V1_SCORING, name);
    expect((await reopened.read(scope)).configVersion).toBe(result.workspace.configVersion);
    const db = await openAdminDevelopmentDatabase(name);
    const audit = (await db.getAll('agent_audit_events')).find((item) => item.actionCode === 'CONFIG_PUBLISH');
    expect(audit?.snapshot).toMatchObject({ 'before.payout.middleFullHouse': 2, 'after.payout.middleFullHouse': 5, runs: 1000, seed: 's1' });
    db.close();
    const replay = await reopened.publish(scope, config, '验证配置发布', firstRequestKey, report);
    expect(replay.workspace.effectiveConfig.payouts.middleFullHouse).toBe(5);
    const mismatchedConfig = structuredClone(config); mismatchedConfig.payouts.middleFullHouse = 6;
    await expect(reopened.publish(scope, mismatchedConfig, '验证配置发布', firstRequestKey, report)).rejects.toThrow('REQUEST_KEY_REUSED');
    const laterConfig = structuredClone(config); laterConfig.payouts.middleFullHouse = 7;
    await reopened.publish(scope, laterConfig, '之后再次调整配置', crypto.randomUUID(), report);
    const idempotentReplay = await reopened.publish(scope, config, '验证配置发布', firstRequestKey, report);
    expect(idempotentReplay.workspace.effectiveConfig.payouts.middleFullHouse).toBe(5);
    expect((await reopened.read(scope)).effectiveConfig.payouts.middleFullHouse).toBe(7);
    adapter.close();
    reopened.close();
  });
});

async function openAuditRequestKey(name: string): Promise<string> {
  const db = await openAdminDevelopmentDatabase(name);
  const [event] = await db.getAll('agent_audit_events');
  db.close();
  if (!event) throw new Error('missing audit');
  return event.requestKey;
}
