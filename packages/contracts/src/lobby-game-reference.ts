import { GameCatalogIntegrationType, GameCatalogStatus, type GameCatalogDto } from './game-catalog';

/** Built-in preview catalog used by the offline browser server and by the H5 lobby card list. */
export const LOBBY_GAME_REFERENCE: readonly GameCatalogDto[] = [
  { gameId: '990000000000000001', gameKey: 'slot5', gameCode: 'jump-high-high', name: '跳高高', category: 'Slot 类游戏', description: '5 列转轴 · 多线玩法 · 积分系统', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: null, coverAssetId: '991000000000000001', sortOrder: 10, status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: '2026-01-01T00:00:00.000Z' },
  { gameId: '990000000000000002', gameKey: 'slot3', gameCode: 'treasure-hero', name: '夺宝奇侠', category: 'Slot 类游戏', description: '3 列转轴 · 多线玩法 · 积分系统', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: null, coverAssetId: '991000000000000002', sortOrder: 20, status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: '2026-01-01T00:00:00.000Z' },
  { gameId: '990000000000000003', gameKey: 'mahjong-hule', gameCode: 'mahjong-hule', name: '麻将胡了', category: '麻将', description: '麻将主题游戏模块规划中', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: null, coverAssetId: '991000000000000003', sortOrder: 30, status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: '2026-01-01T00:00:00.000Z' },
  { gameId: '990000000000000004', gameKey: 'shisanshui', gameCode: 'shisanshui', name: '十三张', category: '棋牌', description: '整理三道，逐墩比牌', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: '@gameing/shisanshui-client', coverAssetId: '991000000000000004', sortOrder: 40, status: GameCatalogStatus.ACTIVE, isPlayable: true, updatedAt: '2026-01-01T00:00:00.000Z' },
  { gameId: '990000000000000005', gameKey: 'mahjong-hule-2', gameCode: 'mahjong-hule-2', name: '麻将胡了 2', category: '麻将', description: '麻将主题游戏模块规划中', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: null, coverAssetId: '991000000000000005', sortOrder: 50, status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: '2026-01-01T00:00:00.000Z' },
  { gameId: '990000000000000006', gameKey: 'fishing', gameCode: 'fishing', name: '捕鱼', category: '街机', description: '捕鱼游戏模块规划中', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: null, coverAssetId: '991000000000000006', sortOrder: 60, status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: '2026-01-01T00:00:00.000Z' },
  { gameId: '990000000000000007', gameKey: 'bounty-queen', gameCode: 'bounty-queen', name: '赏金女王', category: '老虎机', description: '赏金女王游戏模块规划中', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: null, coverAssetId: '991000000000000007', sortOrder: 70, status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: '2026-01-01T00:00:00.000Z' },
  { gameId: '990000000000000008', gameKey: 'three-fast', gameCode: 'three-fast', name: '3快', category: '数字开奖', description: '3快游戏模块规划中', integrationType: GameCatalogIntegrationType.INTERNAL, clientModuleKey: null, coverAssetId: '991000000000000008', sortOrder: 80, status: GameCatalogStatus.ACTIVE, isPlayable: false, updatedAt: '2026-01-01T00:00:00.000Z' },
];

export const LOBBY_GAME_COVER_OPTIONS = LOBBY_GAME_REFERENCE.map((game, index) => ({
  assetId: `99100000000000000${index + 1}`,
  name: `${game.name} 游戏封面`,
  previewUrl: `/assets/game-icons/${game.gameCode}.webp`,
  mimeType: 'image/webp' as const,
}));
