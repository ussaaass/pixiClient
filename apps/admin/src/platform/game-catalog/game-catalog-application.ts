import { Value } from '@sinclair/typebox/value';
import {
  GameCatalogChangeDtoSchema,
  GameCatalogCreateStubRequestSchema,
  GameCatalogCoverAssetOptionSchema,
  GameCatalogDtoSchema,
  GameCatalogIntegrationType,
  GameCatalogListResponseSchema,
  GameCatalogQuerySchema,
  GameCatalogSaveRequestSchema,
  GameCatalogSource,
  GameCatalogStatus,
  GameCatalogWorkspaceSchema,
  type GameCatalogChangeDto,
  type GameCatalogCreateStubRequestDto,
  type GameCatalogCoverAssetOption,
  type GameCatalogDto,
  type GameCatalogQueryDto,
  type GameCatalogSaveRequestDto,
  type GameCatalogWorkspace,
} from '@gameing/contracts/game-catalog';

export type GameCatalogFailure = 'INVALID_REQUEST' | 'GAME_NOT_FOUND' | 'GAME_CODE_TAKEN' | 'GAME_KEY_TAKEN' | 'COVER_ASSET_NOT_READY' | 'REQUEST_KEY_REUSED';
export type GameCatalogResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: GameCatalogFailure };

export interface GameCatalogRepositoryPort {
  listGames(): Promise<GameCatalogDto[]>;
  findGame(gameId: string): Promise<GameCatalogDto | null>;
  findGameByCode(gameCode: string): Promise<GameCatalogDto | null>;
  findGameByKey(gameKey: string): Promise<GameCatalogDto | null>;
  listChanges(gameId: string): Promise<GameCatalogChangeDto[]>;
  findChangeByRequestKey(requestKey: string): Promise<GameCatalogChangeDto | null>;
  listReadyCoverAssets(): Promise<GameCatalogCoverAssetOption[]>;
  commitChange(game: GameCatalogDto, change: GameCatalogChangeDto): Promise<void>;
  commitCreatedGame(game: GameCatalogDto, change: GameCatalogChangeDto): Promise<void>;
  createGameId(): string;
  createId(): string;
  now(): string;
}

export interface GameCatalogApplication {
  list(query: GameCatalogQueryDto): Promise<GameCatalogResult<GameCatalogWorkspace>>;
  listReadyCoverAssets(): Promise<GameCatalogResult<GameCatalogCoverAssetOption[]>>;
  listChanges(gameId: string): Promise<GameCatalogResult<GameCatalogChangeDto[]>>;
  update(request: GameCatalogSaveRequestDto): Promise<GameCatalogResult<GameCatalogDto>>;
  createExternalStub(request: GameCatalogCreateStubRequestDto): Promise<GameCatalogResult<GameCatalogDto>>;
}

const failed = <T>(code: GameCatalogFailure): GameCatalogResult<T> => ({ ok: false, code });

function sameRequest(request: GameCatalogSaveRequestDto, change: GameCatalogChangeDto): boolean {
  return change.gameId === request.gameId
    && change.next.name === request.name
    && change.next.category === request.category
    && change.next.description === request.description
    && change.next.coverAssetId === request.coverAssetId
    && change.next.sortOrder === request.sortOrder
    && change.next.status === request.status
    && change.reason === request.reason;
}

function sameStubRequest(request: GameCatalogCreateStubRequestDto, change: GameCatalogChangeDto): boolean {
  return change.previous === null
    && change.next.gameCode === request.gameCode
    && change.next.name === request.name
    && change.next.category === request.category
    && change.next.description === request.description
    && change.next.coverAssetId === request.coverAssetId
    && change.next.sortOrder === request.sortOrder
    && change.reason === request.reason;
}

export function createGameCatalogApplication(repository: GameCatalogRepositoryPort): GameCatalogApplication {
  return {
    async list(query) {
      if (!Value.Check(GameCatalogQuerySchema, query)) return failed('INVALID_REQUEST');
      const games = await repository.listGames();
      if (!Value.Check(GameCatalogListResponseSchema, games)) return failed('INVALID_REQUEST');
      const keyword = query.keyword?.trim().toLocaleLowerCase();
      const items = games.filter((game) => {
        const matchesKeyword = !keyword || [game.gameCode, game.name, game.category].some((value) => value.toLocaleLowerCase().includes(keyword));
        return matchesKeyword && (query.status === undefined || game.status === query.status);
      }).sort((left, right) => left.sortOrder - right.sortOrder || left.gameCode.localeCompare(right.gameCode));
      const workspace: GameCatalogWorkspace = { source: GameCatalogSource.LOCAL_DEMO, items };
      return Value.Check(GameCatalogWorkspaceSchema, workspace) ? { ok: true, value: workspace } : failed('INVALID_REQUEST');
    },

    async listReadyCoverAssets() {
      const assets = await repository.listReadyCoverAssets();
      return assets.every((asset) => Value.Check(GameCatalogCoverAssetOptionSchema, asset))
        ? { ok: true, value: assets }
        : failed('INVALID_REQUEST');
    },

    async listChanges(gameId) {
      if (!/^[1-9][0-9]{0,19}$/.test(gameId)) return failed('INVALID_REQUEST');
      const changes = await repository.listChanges(gameId);
      return changes.every((change) => Value.Check(GameCatalogChangeDtoSchema, change))
        ? { ok: true, value: changes }
        : failed('INVALID_REQUEST');
    },

    async createExternalStub(request) {
      if (!Value.Check(GameCatalogCreateStubRequestSchema, request)) return failed('INVALID_REQUEST');
      const normalized = { ...request, gameCode: request.gameCode.trim().toLocaleLowerCase(), name: request.name.trim(), category: request.category.trim(), description: request.description.trim(), reason: request.reason.trim() };
      if (!Value.Check(GameCatalogCreateStubRequestSchema, normalized)) return failed('INVALID_REQUEST');
      await repository.listGames();
      const replay = await repository.findChangeByRequestKey(normalized.requestKey);
      if (replay) return sameStubRequest(normalized, replay) ? { ok: true, value: replay.next } : failed('REQUEST_KEY_REUSED');
      if (await repository.findGameByCode(normalized.gameCode)) return failed('GAME_CODE_TAKEN');
      if (await repository.findGameByKey(normalized.gameCode)) return failed('GAME_KEY_TAKEN');
      if (!(await repository.listReadyCoverAssets()).some((asset) => asset.assetId === normalized.coverAssetId)) return failed('COVER_ASSET_NOT_READY');
      const createdAt = repository.now();
      const game: GameCatalogDto = {
        gameId: repository.createGameId(), gameKey: normalized.gameCode, gameCode: normalized.gameCode,
        name: normalized.name, category: normalized.category, description: normalized.description,
        integrationType: GameCatalogIntegrationType.EXTERNAL_STUB, clientModuleKey: null,
        coverAssetId: normalized.coverAssetId, sortOrder: normalized.sortOrder,
        status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: createdAt,
      };
      const change: GameCatalogChangeDto = {
        changeId: repository.createId(), requestKey: normalized.requestKey, gameId: game.gameId,
        previous: null, next: game, reason: normalized.reason, source: GameCatalogSource.LOCAL_DEMO, createdAt,
      };
      if (!Value.Check(GameCatalogDtoSchema, game) || !Value.Check(GameCatalogChangeDtoSchema, change)) return failed('INVALID_REQUEST');
      try {
        await repository.commitCreatedGame(game, change);
      } catch (error) {
        const committed = await repository.findChangeByRequestKey(normalized.requestKey);
        if (committed) return sameStubRequest(normalized, committed) ? { ok: true, value: committed.next } : failed('REQUEST_KEY_REUSED');
        if (await repository.findGameByCode(normalized.gameCode)) return failed('GAME_CODE_TAKEN');
        if (await repository.findGameByKey(normalized.gameCode)) return failed('GAME_KEY_TAKEN');
        throw error;
      }
      return { ok: true, value: game };
    },

    async update(request) {
      if (!Value.Check(GameCatalogSaveRequestSchema, request)) return failed('INVALID_REQUEST');
      const normalized = { ...request, name: request.name.trim(), category: request.category.trim(), description: request.description.trim(), reason: request.reason.trim() };
      if (!Value.Check(GameCatalogSaveRequestSchema, normalized)) return failed('INVALID_REQUEST');
      const previousRequest = await repository.findChangeByRequestKey(normalized.requestKey);
      if (previousRequest) return sameRequest(normalized, previousRequest) ? { ok: true, value: previousRequest.next } : failed('REQUEST_KEY_REUSED');
      const [current, covers] = await Promise.all([repository.findGame(normalized.gameId), repository.listReadyCoverAssets()]);
      if (!current) return failed('GAME_NOT_FOUND');
      if (!covers.some((cover) => cover.assetId === normalized.coverAssetId)) return failed('COVER_ASSET_NOT_READY');
      const changedAt = repository.now();
      const next: GameCatalogDto = {
        ...current,
        name: normalized.name,
        category: normalized.category,
        description: normalized.description,
        coverAssetId: normalized.coverAssetId,
        sortOrder: normalized.sortOrder,
        status: normalized.status,
        updatedAt: changedAt,
      };
      if (!Value.Check(GameCatalogDtoSchema, next)) return failed('INVALID_REQUEST');
      const change: GameCatalogChangeDto = {
        changeId: repository.createId(),
        requestKey: normalized.requestKey,
        gameId: current.gameId,
        previous: current,
        next,
        reason: normalized.reason,
        source: GameCatalogSource.LOCAL_DEMO,
        createdAt: changedAt,
      };
      if (!Value.Check(GameCatalogChangeDtoSchema, change)) return failed('INVALID_REQUEST');
      try {
        await repository.commitChange(next, change);
      } catch (error) {
        const committed = await repository.findChangeByRequestKey(normalized.requestKey);
        if (committed) return sameRequest(normalized, committed) ? { ok: true, value: committed.next } : failed('REQUEST_KEY_REUSED');
        throw error;
      }
      return { ok: true, value: next };
    },
  };
}
