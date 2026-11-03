import type { TSchema } from '@sinclair/typebox';

/**
 * OpenAPI 端点注册表条目。
 *
 * `requestSchema` / `responseSchema` 必须是 TypeBox schema（JSON Schema 子集）；
 * 生成器会把它原样写进 OpenAPI 3.1 的 `requestBody` / `responses`，
 * 不复制、不改写字段——`pattern` / `additionalProperties` 等约束保留。
 */
export interface EndpointRegistryEntry {
  readonly method: 'get' | 'post' | 'put' | 'delete' | 'patch';
  readonly path: string;
  readonly summary: string;
  /** 仅标记规划中、尚未在 Koa 实现的端点；这些条目不进入 `openapi.json` 的 `paths`。 */
  readonly status?: 'implemented' | 'planned';
  readonly requestSchema?: TSchema;
  readonly responseSchema?: TSchema;
  readonly successStatus?: number;
  readonly errorCodes?: readonly string[];
  readonly idempotencyKeyField?: string;
}

/**
 * 端点注册表。
 *
 * 以 `docs/09_agent/API_CONTRACTS.md` §3 的 "Koa 已实现端点" 表为准；
 * 已实现端点 `status` 默认 `'implemented'`，规划端点显式标 `'planned'`。
 * 新增端点必须在此登记，避免 OpenAPI 产物与 contracts 漂移。
 */
export const ENDPOINT_REGISTRY: readonly EndpointRegistryEntry[] = [
  // health
  { method: 'get', path: '/health/live', summary: '服务探活' },
  { method: 'get', path: '/health/ready', summary: '就绪探针（含依赖检查）' },
  // 公告
  { method: 'get', path: '/platform/announcements/active', summary: '当前生效公告', status: 'implemented' },
  // 游戏目录
  { method: 'get', path: '/games', summary: '游戏目录', status: 'implemented' },
  { method: 'get', path: '/games/experience', summary: '游戏玩法与难度配置', status: 'implemented' },
  { method: 'get', path: '/games/{gameKey}/experience', summary: '游戏玩法详情', status: 'implemented' },
  { method: 'get', path: '/games/{gameKey}/difficulties/{difficultyKey}/preflight', summary: '难度准入检查', status: 'implemented' },
  // 以下为规划端点，不进入 openapi.json 的 paths
  { method: 'get', path: '/me/wallet/summary', summary: '钱包摘要', status: 'planned' },
  { method: 'get', path: '/me/wallet/activity', summary: '钱包明细', status: 'planned' },
];

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const entry of ENDPOINT_REGISTRY) {
    if (entry.status === 'planned') continue;
    const methodKey = entry.method;
    const pathBucket = (paths[entry.path] ??= {});
    pathBucket[methodKey] = {
      summary: entry.summary,
      responses: {
        [entry.successStatus ?? 200]: {
          description: '成功',
          content:
            entry.responseSchema !== undefined ? { 'application/json': { schema: toOpenApiSchema(entry.responseSchema) } } : undefined,
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Gameing Hall Player API',
      version: 'v1',
    },
    paths,
  };
}

/**
 * 把 TypeBox schema（JSON Schema 子集）原样写进 OpenAPI 3.1。
 *
 * TypeBox 0.34 没有内置正向 OpenAPI 导出器（见 `docs/09_agent/OPENAPI.md` §1），
 * 这里直接把 `TSchema` 当 JSON Schema 透传，并递归清理 TypeBox 内部标记
 * （`$schema`、`$defs`、`[TSchema]`、`modifier`、`reference` 等），避免 OpenAPI
 * 校验器报未知关键字。
 */
export function toOpenApiSchema(schema: TSchema): Record<string, unknown> {
  const source = schema as unknown as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    // TypeBox 内部标记键；不进入 OpenAPI 文档。
    if (key === '$schema' || key === 'modifier' || key === '[TSchema]') continue;
    if (key === '$defs' && value !== undefined) {
      clone.$defs = {};
      for (const [defKey, defValue] of Object.entries(value as Record<string, unknown>)) {
        (clone.$defs as Record<string, unknown>)[defKey] = toOpenApiSchema(defValue as TSchema);
      }
      continue;
    }
    if (key === 'properties' && value !== undefined) {
      clone.properties = {};
      for (const [propKey, propValue] of Object.entries(value as Record<string, unknown>)) {
        (clone.properties as Record<string, unknown>)[propKey] = toOpenApiSchema(propValue as TSchema);
      }
      continue;
    }
    if (key === 'items' && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
      clone.items = toOpenApiSchema(value as TSchema);
      continue;
    }
    if (key === 'additionalProperties' && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
      clone.additionalProperties = toOpenApiSchema(value as TSchema);
      continue;
    }
    clone[key] = value;
  }
  return clone;
}
