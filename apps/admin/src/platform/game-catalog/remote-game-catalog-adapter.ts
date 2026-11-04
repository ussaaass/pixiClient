import {
  type GameCatalogChangeDto,
  type GameCatalogCoverAssetOption,
  type GameCatalogDto,
} from '@gameing/contracts/game-catalog';
import { AdminApiClient, AdminApiError } from '../admin-api-client.js';
import type { GameCatalogRepositoryPort } from './game-catalog-application';

export class RemoteGameCatalogAdapter implements GameCatalogRepositoryPort {
  constructor(private readonly client: AdminApiClient) {}

  async listGames(): Promise<GameCatalogDto[]> {
    return this.client.get<GameCatalogDto[]>('/game-catalog', { pageSize: 100 });
  }

  async findGame(gameId: string): Promise<GameCatalogDto | null> {
    try {
      return await this.client.get<GameCatalogDto>(`/game-catalog/${encodeURIComponent(gameId)}`);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async findGameByCode(gameCode: string): Promise<GameCatalogDto | null> {
    try {
      return await this.client.get<GameCatalogDto>('/game-catalog/by-code', { code: gameCode });
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async findGameByKey(gameKey: string): Promise<GameCatalogDto | null> {
    try {
      return await this.client.get<GameCatalogDto>('/game-catalog/by-key', { key: gameKey });
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async listChanges(gameId: string): Promise<GameCatalogChangeDto[]> {
    return this.client.get<GameCatalogChangeDto[]>(`/game-catalog/${encodeURIComponent(gameId)}/changes`);
  }

  async findChangeByRequestKey(requestKey: string): Promise<GameCatalogChangeDto | null> {
    try {
      return await this.client.get<GameCatalogChangeDto>(`/game-catalog/changes/request/${encodeURIComponent(requestKey)}`);
    } catch (error) {
      if (error instanceof AdminApiError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async listReadyCoverAssets(): Promise<GameCatalogCoverAssetOption[]> {
    return this.client.get<GameCatalogCoverAssetOption[]>('/game-catalog/cover-assets');
  }

  async commitChange(game: GameCatalogDto, change: GameCatalogChangeDto): Promise<void> {
    await this.client.patch(`/game-catalog/${encodeURIComponent(game.gameId)}`, { game, change });
  }

  async commitCreatedGame(game: GameCatalogDto, change: GameCatalogChangeDto): Promise<void> {
    await this.client.post('/game-catalog', { game, change });
  }

  createGameId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-game-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  createId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-game-change-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  now(): string {
    return new Date().toISOString();
  }
}
