# OpenAPI 生成器选型方案（P0 遗留项）

本文登记 P0 路线文档中"⬜ OpenAPI 生成"待办项的选型结论与实施口径。落地前不得把 OpenAPI 产物当作"已存在"引用。

## 1. 选型（2026-11-02 核实）

**结论：TypeBox 0.34.52 没有内置正向 OpenAPI 导出器；本项目采用自写 ~30 行 JSON Schema 拼装器，避免引入第二套 DTO。**

核实过程：

- 检查 `packages/contracts/node_modules/@sinclair/typebox/build/cjs/index.d.ts` 与 `build/esm/**/*.d.mts`，**不存在 `toOpenApi` / `OpenApi` / `OpenApi3` 任何符号**。
- `readme.md` 把 [openapi-box](https://github.com/geut/openapi-box) 列为"相关项目"，但它是**逆向**（OpenAPI IDL → TypeBox），与"schema 单一来源"冲突。
- 备选方案对比：
  - **Zod**：与现有 TypeBox 契约 100% 冲突，需要重写 30+ 个 schema，拒绝。
  - **@asteasolutions/zod-to-openapi**：依赖 Zod，拒绝。
  - **openapi-typescript-codegen**：基于 TS 类型而非 schema，会漂移，拒绝。
  - **自写 JSON Schema 拼装器**：TypeBox 每个 `Type.*` 产物本身就是标准 JSON Schema（`$defs`、`type`、`properties`、`additionalProperties`），只需包一层 OpenAPI 3.1 的 `paths` / `responses` 外壳，~30 行 TS 即可，零外部依赖。

## 2. 实施口径

**已完成（2026-11-02）**：

1. 入口注册表：`packages/contracts/src/openapi/registry.ts`，登记 7 个已实现端点 + 2 个规划端点（planned 端点不进 `paths`）。
2. 生成器：`packages/contracts/openapi.mjs`（~30 行），`toOpenApiSchema` 递归透传 TypeBox schema 并清理内部标记（`$schema`、`$defs`、`[TSchema]`、`modifier`）。
3. 脚本：`pnpm --filter @gameing/contracts openapi` 生成 `packages/contracts/dist/openapi.json`；`openapi:check` 对产物做 diff。

**待做**：

- `pnpm install`（在 dev 容器里跑）把 `tsx@4.23.15` 装到 contracts 的 devDependencies，让 `node --import tsx` 能解析。
- `.github/workflows/ci.yml` 增加第七关 `pnpm --filter @gameing/contracts openapi` 生成 + `openapi:check` diff。
- `.gitignore` 加 `packages/contracts/dist/openapi.json`（产物不进 git）。
- 把规划端点（wallet/identity/social/…）按 Koa 实现进度逐项从 `planned` 切到 `implemented`，并填入 request/response schema。

## 3. 与现有契约的关系

- `packages/contracts/src/common/api-envelope.ts` 的 `ApiSuccessSchema` / `ApiFailureSchema` 是 OpenAPI 的根响应 envelope，生成器必须把这两个 schema 作为所有 response 的包装。
- `packages/contracts/src/common/api-errors.ts` 的 `ApiErrorCode` 常量是 OpenAPI `errorCodes` 数组的单一来源。
- 金额/ID 字符串、UTC 时间、幂等键的 schema 约束（见 `docs/02_architecture/HTTP接口与共享DTO协议SDD.md` §1）在 OpenAPI 里必须保留为 `pattern` / `format` 字段，不得降级为 `type: string`。

## 4. 验收

- `pnpm --filter @gameing/contracts openapi` 在 dev 容器内 exit 0，产物可被 [Swagger Editor](https://editor.swagger.io/) / [Redocly CLI](https://redocly.com/) 解析。
- `pnpm --filter @gameing/contracts openapi:check` 在 CI 上通过 diff。
- 破坏性变更（如 `additionalProperties: false` 改 `true`）在 CI diff 阶段失败。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-02 | 新建：登记 P0 遗留 OpenAPI 生成器选型；核实 TypeBox 0.34.52 无内置正向导出器，采用自写 ~30 行 JSON Schema 拼装器，避免引入第二套 DTO。 |
