import type {
  AgentGameConfigPublishResponseDto,
  AgentGameConfigScopeDto,
  AgentGameConfigWorkspaceDto,
  AgentShisanshuiScoringDto,
} from '@gameing/contracts/agent-game-config';
import type { GameMathSimulationReportDto } from '@gameing/contracts/game-math';
import { AdminApiClient } from '../admin-api-client.js';
import type { AgentGameConfigRepositoryPort } from './agent-game-config-application';

export class RemoteAgentGameConfigAdapter implements AgentGameConfigRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async read(scope: AgentGameConfigScopeDto): Promise<AgentGameConfigWorkspaceDto> {
    return this.client.get<AgentGameConfigWorkspaceDto>(
      `/agent-games/${encodeURIComponent(scope.gameKey)}/difficulties/${encodeURIComponent(scope.difficultyKey)}/config`,
      { agentDomainId: scope.agentDomainId },
    );
  }

  async publish(
    scope: AgentGameConfigScopeDto,
    config: AgentShisanshuiScoringDto,
    reason: string,
    requestKey: string,
    report: GameMathSimulationReportDto,
  ): Promise<AgentGameConfigPublishResponseDto> {
    return this.client.post<AgentGameConfigPublishResponseDto>(
      `/agent-games/${encodeURIComponent(scope.gameKey)}/difficulties/${encodeURIComponent(scope.difficultyKey)}/config/publish`,
      {
        agentDomainId: scope.agentDomainId,
        config,
        reason,
        requestKey,
        simulation: { scope, config, report, source: 'LOCAL_DEMO' },
      },
    );
  }
}
