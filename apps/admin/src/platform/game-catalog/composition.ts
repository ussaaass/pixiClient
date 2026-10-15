import { createGameCatalogApplication } from './game-catalog-application';
import { IndexedDbGameCatalogAdapter } from './indexeddb-game-catalog-adapter';

export const localGameCatalogApplication = createGameCatalogApplication(new IndexedDbGameCatalogAdapter());
