import type { GameCatalogChangeDto, GameCatalogCoverAssetOption, GameCatalogDto } from '@gameing/contracts/game-catalog';
import { LOBBY_GAME_REFERENCE, LOBBY_GAME_COVER_OPTIONS } from '@gameing/contracts/lobby-game-reference';
import { ADMIN_DEVELOPMENT_DATABASE, openAdminDevelopmentDatabase } from '../browser-development-database';
import type { GameCatalogRepositoryPort } from './game-catalog-application';

export class IndexedDbGameCatalogAdapter implements GameCatalogRepositoryPort {
  private databasePromise: ReturnType<typeof openAdminDevelopmentDatabase> | undefined;

  constructor(private readonly databaseName = ADMIN_DEVELOPMENT_DATABASE) {}

  async listGames(): Promise<GameCatalogDto[]> {
    const database = await this.database();
    const transaction = database.transaction('game_catalog_items', 'readwrite');
    const store = transaction.store;
    let games = await store.getAll();
    if (games.length === 0) {
      await Promise.all(LOBBY_GAME_REFERENCE.map((game) => store.add({ ...game })));
      games = await store.getAll();
    }
    await transaction.done;
    return games;
  }

  async findGame(gameId: string): Promise<GameCatalogDto | null> {
    return (await (await this.database()).get('game_catalog_items', gameId)) ?? null;
  }

  async findGameByCode(gameCode: string): Promise<GameCatalogDto | null> {
    return (await (await this.database()).getFromIndex('game_catalog_items', 'by-code', gameCode)) ?? null;
  }

  async findGameByKey(gameKey: string): Promise<GameCatalogDto | null> {
    return (await (await this.database()).getFromIndex('game_catalog_items', 'by-game-key', gameKey)) ?? null;
  }

  async listChanges(gameId: string): Promise<GameCatalogChangeDto[]> {
    const changes = await (await this.database()).getAllFromIndex('game_catalog_change_snapshots', 'by-game-created', IDBKeyRange.bound([gameId, ''], [gameId, '\uffff']));
    return changes.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async findChangeByRequestKey(requestKey: string): Promise<GameCatalogChangeDto | null> {
    return (await (await this.database()).getFromIndex('game_catalog_change_snapshots', 'by-request-key', requestKey)) ?? null;
  }

  async listReadyCoverAssets(): Promise<GameCatalogCoverAssetOption[]> {
    // Admin and Web run on distinct dev origins; LOCAL_DEMO previews use Web's public asset server.
    const webOrigin = globalThis.location
      ? `${globalThis.location.protocol}//${globalThis.location.hostname}:10373`
      : 'http://localhost:10373';
    return LOBBY_GAME_COVER_OPTIONS.map((asset) => ({ ...asset, previewUrl: new URL(asset.previewUrl, webOrigin).toString() }));
  }

  async commitChange(game: GameCatalogDto, change: GameCatalogChangeDto): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(['game_catalog_items', 'game_catalog_change_snapshots'], 'readwrite');
    const completed = transaction.done;
    try {
      await Promise.all([
        transaction.objectStore('game_catalog_items').put({ ...game }),
        transaction.objectStore('game_catalog_change_snapshots').add({ ...change }),
      ]);
      await completed;
    } catch (error) {
      await completed.catch(() => undefined);
      throw error;
    }
  }

  async commitCreatedGame(game: GameCatalogDto, change: GameCatalogChangeDto): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(['game_catalog_items', 'game_catalog_change_snapshots'], 'readwrite');
    const completed = transaction.done;
    try {
      await Promise.all([
        transaction.objectStore('game_catalog_items').add({ ...game }),
        transaction.objectStore('game_catalog_change_snapshots').add({ ...change }),
      ]);
      await completed;
    } catch (error) {
      await completed.catch(() => undefined);
      throw error;
    }
  }

  createId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `local-game-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  createGameId(): string {
    const random = new Uint32Array(1);
    globalThis.crypto.getRandomValues(random);
    return `${Date.now()}${String((random[0] ?? 1) % 1000000).padStart(6, '0')}`;
  }

  now(): string {
    return new Date().toISOString();
  }

  async close(): Promise<void> {
    const database = this.databasePromise;
    this.databasePromise = undefined;
    if (database) (await database).close();
  }

  private database(): ReturnType<typeof openAdminDevelopmentDatabase> {
    this.databasePromise ??= openAdminDevelopmentDatabase(this.databaseName);
    return this.databasePromise;
  }
}
