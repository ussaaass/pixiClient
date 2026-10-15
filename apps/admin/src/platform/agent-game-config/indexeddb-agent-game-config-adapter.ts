import { AgentAuditActionCode, AgentAuditResultType, type AgentAuditEventDto } from '@gameing/contracts/agent-audit';
import type { GameMathSimulationReportDto } from '@gameing/contracts/game-math';
import type { AgentGameConfigPublishResponseDto, AgentGameConfigScopeDto, AgentGameConfigWorkspaceDto, AgentShisanshuiScoringDto } from '@gameing/contracts/agent-game-config';
import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase } from '../browser-development-database';
import type { AgentGameConfigRepositoryPort } from './agent-game-config-application';

export class IndexedDbAgentGameConfigAdapter implements AgentGameConfigRepositoryPort {
  private databasePromise: ReturnType<typeof openAdminDevelopmentDatabase> | null = null;
  constructor(private readonly platformConfig: AgentShisanshuiScoringDto, private readonly databaseName = ADMIN_DEVELOPMENT_DATABASE) {}

  close(): void { void this.databasePromise?.then((database) => database.close()); this.databasePromise = null; }

  async read(scope: AgentGameConfigScopeDto): Promise<AgentGameConfigWorkspaceDto> {
    const database = await this.database();
    const existing = await database.get('agent_game_config_workspaces', scopeKey(scope));
    if (existing) return stripKey(existing);
    return {
      scope: structuredClone(scope), platformConfig: structuredClone(this.platformConfig), effectiveConfig: structuredClone(this.platformConfig),
      configVersion: 'PLATFORM_BASELINE_V1', modelVersion: 'classic_v1_rank_partition_1', publishedAt: null, publishedBy: null, source: 'LOCAL_DEMO',
    };
  }

  async publish(scope: AgentGameConfigScopeDto, config: AgentShisanshuiScoringDto, reason: string, requestKey: string, report: GameMathSimulationReportDto): Promise<AgentGameConfigPublishResponseDto> {
    const db = await this.database();
    const transaction = db.transaction(['agent_game_config_workspaces', 'agent_audit_events'], 'readwrite');
    const auditStore = transaction.objectStore('agent_audit_events');
    const previous = await auditStore.index('by-request-key').get(requestKey);
    if (previous) {
      await transaction.done;
      if (previous.actionCode !== AgentAuditActionCode.CONFIG_PUBLISH || previous.resourceKey !== scopeKey(scope) || previous.purpose !== reason) throw new Error('REQUEST_KEY_REUSED');
      if (!snapshotMatchesCommand(previous, config, report)) throw new Error('REQUEST_KEY_REUSED');
      const latestWorkspace = await this.read(scope);
      const effectiveConfig = restoreConfig(previous.snapshot, 'after');
      const configVersion = previous.snapshot.configVersion;
      const modelVersion = previous.snapshot.modelVersion;
      if (!effectiveConfig || typeof configVersion !== 'string' || typeof modelVersion !== 'string') throw new Error('INVALID_AUDIT_SNAPSHOT');
      const workspace: AgentGameConfigWorkspaceDto = {
        ...latestWorkspace, effectiveConfig, configVersion, modelVersion, publishedAt: previous.createdAt, publishedBy: '当前演练代理', source: 'LOCAL_DEMO',
      };
      return { workspace, auditId: previous.auditId, source: 'LOCAL_DEMO' };
    }

    const priorWorkspace = await transaction.objectStore('agent_game_config_workspaces').get(scopeKey(scope));
    const now = new Date().toISOString();
    const workspace: AgentGameConfigWorkspaceDto = {
      scope: structuredClone(scope), platformConfig: structuredClone(priorWorkspace?.platformConfig ?? this.platformConfig), effectiveConfig: structuredClone(config),
      configVersion: `AGENT_LOCAL_${now.replace(/[-:.TZ]/g, '')}`, modelVersion: report.modelVersion,
      publishedAt: now, publishedBy: '当前演练代理', source: 'LOCAL_DEMO',
    };
    const auditId = createAuditId();
    const audit: AgentAuditEventDto = {
      auditId, agentDomainId: scope.agentDomainId, agentUserId: '92000', actionCode: AgentAuditActionCode.CONFIG_PUBLISH,
      resourceType: 'GAME_CONFIG', resourceKey: scopeKey(scope), purpose: reason, requestKey, resultType: AgentAuditResultType.SUCCESS,
      snapshot: {
        configVersion: workspace.configVersion, modelVersion: report.modelVersion, runs: report.runs, seed: report.seed,
        winRate: report.winRate, tieRate: report.tieRate, zeroNetRate: report.zeroNetRate, foulRate: report.foulRate,
        slamRate: report.slamRate, homeRunRate: report.homeRunRate, meanNetScore: report.meanNetScore, variance: report.variance,
        ...flattenConfig('before', priorWorkspace?.effectiveConfig ?? this.platformConfig), ...flattenConfig('after', config),
      }, createdAt: now,
    };
    await transaction.objectStore('agent_game_config_workspaces').put({ ...workspace, scopeKey: scopeKey(scope) });
    await auditStore.add(audit);
    await transaction.done;
    return { workspace, auditId, source: 'LOCAL_DEMO' };
  }

  private database(): ReturnType<typeof openAdminDevelopmentDatabase> {
    return this.databasePromise ??= openAdminDevelopmentDatabase(this.databaseName);
  }
}

function scopeKey(scope: AgentGameConfigScopeDto): string { return `${scope.agentDomainId}:${scope.gameKey}:${scope.difficultyKey}`; }
function stripKey(value: AgentGameConfigWorkspaceDto & { scopeKey: string }): AgentGameConfigWorkspaceDto {
  const { scopeKey: _scopeKey, ...workspace } = value;
  return workspace;
}
function createAuditId(): string {
  const suffix = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return String(BigInt(Date.now()) * 1_000_000n + BigInt(suffix));
}
function flattenConfig(prefix: 'before' | 'after', config: AgentShisanshuiScoringDto): Record<string, string | number> {
  return {
    ...Object.fromEntries(Object.entries(config.features).map(([key, value]) => [`${prefix}.feature.${key}`, String(value)])),
    ...Object.fromEntries(Object.entries(config.payouts).map(([key, value]) => [`${prefix}.payout.${key}`, value])),
    [`${prefix}.slamMultiplier`]: config.slamMultiplier,
    [`${prefix}.homeRunMultiplier`]: config.homeRunMultiplier,
  };
}
function restoreConfig(snapshot: AgentAuditEventDto['snapshot'], prefix: 'before' | 'after'): AgentShisanshuiScoringDto | null {
  const featureKeys = ['frontThreeOfAKind', 'middleFullHouse', 'middleFourOfAKind', 'middleStraightFlush', 'backFourOfAKind', 'backStraightFlush', 'slam', 'homeRun', 'foulPayout'] as const;
  const payoutKeys = ['frontThreeOfAKind', 'middleFullHouse', 'middleFourOfAKind', 'middleStraightFlush', 'backFourOfAKind', 'backStraightFlush', 'foul'] as const;
  const features = Object.fromEntries(featureKeys.map((key) => {
    const value = snapshot[`${prefix}.feature.${key}`];
    return [key, value === 'true' ? true : value === 'false' ? false : null];
  }));
  const payouts = Object.fromEntries(payoutKeys.map((key) => [key, snapshot[`${prefix}.payout.${key}`]]));
  const slamMultiplier = snapshot[`${prefix}.slamMultiplier`];
  const homeRunMultiplier = snapshot[`${prefix}.homeRunMultiplier`];
  if (Object.values(features).some((value) => typeof value !== 'boolean') || Object.values(payouts).some((value) => typeof value !== 'number') || typeof slamMultiplier !== 'number' || typeof homeRunMultiplier !== 'number') return null;
  return { features: features as AgentShisanshuiScoringDto['features'], payouts: payouts as AgentShisanshuiScoringDto['payouts'], slamMultiplier, homeRunMultiplier };
}
function snapshotMatchesCommand(audit: AgentAuditEventDto, config: AgentShisanshuiScoringDto, report: GameMathSimulationReportDto): boolean {
  if (audit.snapshot.runs !== report.runs || audit.snapshot.seed !== report.seed || audit.snapshot.modelVersion !== report.modelVersion
    || audit.snapshot.winRate !== report.winRate || audit.snapshot.meanNetScore !== report.meanNetScore || audit.snapshot.variance !== report.variance) return false;
  return JSON.stringify(restoreConfig(audit.snapshot, 'after')) === JSON.stringify(config);
}
