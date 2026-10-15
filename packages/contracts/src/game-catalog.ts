import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';

const BigIdSchema = Type.String({ pattern: '^[1-9][0-9]{0,19}$' });
const UtcTimestampSchema = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$' });
export const GameCatalogStatus = { ACTIVE: 1, HIDDEN: 2, MAINTENANCE: 3 } as const;
export const GameCatalogIntegrationType = { INTERNAL: 1, EXTERNAL_STUB: 2 } as const;
export const GameCatalogSource = { LOCAL_DEMO: 1, SERVER: 2 } as const;

export const GameCatalogDtoSchema = Type.Object({
  gameId: BigIdSchema,
  gameKey: Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' }),
  gameCode: Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' }),
  name: Type.String({ minLength: 2, maxLength: 64 }),
  category: Type.String({ minLength: 1, maxLength: 48 }),
  description: Type.String({ minLength: 1, maxLength: 240 }),
  integrationType: Type.Union([Type.Literal(GameCatalogIntegrationType.INTERNAL), Type.Literal(GameCatalogIntegrationType.EXTERNAL_STUB)]),
  clientModuleKey: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  coverAssetId: BigIdSchema,
  sortOrder: Type.Integer({ minimum: 0, maximum: 1000000 }),
  status: Type.Union([Type.Literal(GameCatalogStatus.ACTIVE), Type.Literal(GameCatalogStatus.HIDDEN), Type.Literal(GameCatalogStatus.MAINTENANCE)]),
  isPlayable: Type.Boolean(),
  updatedAt: UtcTimestampSchema,
}, { additionalProperties: false });

export const GameCatalogQuerySchema = Type.Object({
  keyword: Type.Optional(Type.String({ maxLength: 80 })),
  status: Type.Optional(Type.Union([Type.Literal(GameCatalogStatus.ACTIVE), Type.Literal(GameCatalogStatus.HIDDEN), Type.Literal(GameCatalogStatus.MAINTENANCE)])),
}, { additionalProperties: false });

export const GameCatalogSaveRequestSchema = Type.Object({
  requestKey: Type.String({ minLength: 8, maxLength: 128 }),
  gameId: BigIdSchema,
  name: Type.String({ minLength: 2, maxLength: 64 }),
  category: Type.String({ minLength: 1, maxLength: 48 }),
  description: Type.String({ minLength: 1, maxLength: 240 }),
  coverAssetId: BigIdSchema,
  sortOrder: Type.Integer({ minimum: 0, maximum: 1000000 }),
  status: Type.Union([Type.Literal(GameCatalogStatus.ACTIVE), Type.Literal(GameCatalogStatus.HIDDEN), Type.Literal(GameCatalogStatus.MAINTENANCE)]),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
}, { additionalProperties: false });

export const GameCatalogCreateStubRequestSchema = Type.Object({
  requestKey: Type.String({ minLength: 8, maxLength: 128 }),
  gameCode: Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' }),
  name: Type.String({ minLength: 2, maxLength: 64 }),
  category: Type.String({ minLength: 1, maxLength: 48 }),
  description: Type.String({ minLength: 1, maxLength: 240 }),
  coverAssetId: BigIdSchema,
  sortOrder: Type.Integer({ minimum: 0, maximum: 1000000 }),
  reason: Type.String({ minLength: 3, maxLength: 500 }),
}, { additionalProperties: false });

export const GameCatalogChangeDtoSchema = Type.Object({
  changeId: Type.String({ minLength: 1, maxLength: 128 }),
  requestKey: Type.String({ minLength: 8, maxLength: 128 }),
  gameId: BigIdSchema,
  previous: Type.Union([GameCatalogDtoSchema, Type.Null()]),
  next: GameCatalogDtoSchema,
  reason: Type.String({ minLength: 3, maxLength: 500 }),
  source: Type.Union([Type.Literal(GameCatalogSource.LOCAL_DEMO), Type.Literal(GameCatalogSource.SERVER)]),
  createdAt: UtcTimestampSchema,
}, { additionalProperties: false });

export const GameCatalogCoverAssetOptionSchema = Type.Object({
  assetId: BigIdSchema,
  name: Type.String({ minLength: 1, maxLength: 100 }),
  previewUrl: Type.String({ minLength: 1, maxLength: 2048 }),
  mimeType: Type.Literal('image/webp'),
}, { additionalProperties: false });

export const GameCatalogWorkspaceSchema = Type.Object({
  source: Type.Union([Type.Literal(GameCatalogSource.LOCAL_DEMO), Type.Literal(GameCatalogSource.SERVER)]),
  items: Type.Array(GameCatalogDtoSchema, { maxItems: 500 }),
}, { additionalProperties: false });

export const GameCatalogListResponseSchema = Type.Array(GameCatalogDtoSchema, { maxItems: 500 });
export const GameCatalogChangesResponseSchema = Type.Array(GameCatalogChangeDtoSchema, { maxItems: 1000 });
export const GameCatalogEndpoint = {
  list: { method: 'GET', path: '/api/v1/games', query: GameCatalogQuerySchema, response: GameCatalogListResponseSchema, successStatus: 200 },
} as const;
export const AdminGameCatalogEndpoint = {
  list: { method: 'GET', path: '/api/v1/admin/games', query: GameCatalogQuerySchema, response: GameCatalogListResponseSchema, successStatus: 200 },
  createExternalStub: { method: 'POST', path: '/api/v1/admin/games/external-stub', request: GameCatalogCreateStubRequestSchema, response: GameCatalogDtoSchema, successStatus: 201 },
  update: { method: 'PATCH', path: '/api/v1/admin/games/:gameId', request: GameCatalogSaveRequestSchema, response: GameCatalogDtoSchema, successStatus: 200 },
  history: { method: 'GET', path: '/api/v1/admin/games/:gameId/changes', response: GameCatalogChangesResponseSchema, successStatus: 200 },
} as const;

export type GameCatalogDto = Static<typeof GameCatalogDtoSchema>;
export type GameCatalogQueryDto = Static<typeof GameCatalogQuerySchema>;
export type GameCatalogSaveRequestDto = Static<typeof GameCatalogSaveRequestSchema>;
export type GameCatalogCreateStubRequestDto = Static<typeof GameCatalogCreateStubRequestSchema>;
export type GameCatalogChangeDto = Static<typeof GameCatalogChangeDtoSchema>;
export type GameCatalogCoverAssetOption = Static<typeof GameCatalogCoverAssetOptionSchema>;
export type GameCatalogWorkspace = Static<typeof GameCatalogWorkspaceSchema>;
