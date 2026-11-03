---
name: vertical-slice-build
description: 按本仓库“纵向闭环”纪律实施一个新功能（如服务端钱包转账、房间结算）：先读 SDD 与现状，切最小闭环，补测试，跑增量门禁并回写文档。
whenToUse: 任务是为某个业务链路打通真实实现（非单文件修补），或用户要求“打通一个流程/加一个模块/接一个端点”时。
---

# 纵向闭环施工（vertical slice）

依据：`AGENTS.md` §5/§6 与 `docs/02_architecture/从原型到产品级的实施路线.md`——优先打通一条真实流程及其必要测试，不先铺空模块。

## 步骤

1. **读权威**：`AGENTS.md` → 对应 04_domains/05_data SDD → `docs/09_agent/PROJECT_STATUS.md` 确认哪些是真实现、哪些是 stub（stub 不得当闭环依据）。
2. **查现有实现**：graphify 优先；列出受影响的包（contracts / domain / server / web）、迁移、admin 契约。
3. **切最小闭环**：定义验收链（例：玩家转账 → 幂等键 → 锁账户 → 5% 手续费 → asset_operation+entry 同事务 → 余额可查 → 测试）。一次性闭环，不做半截 API。
4. **实施顺序**：
   - `packages/contracts` 先加/改 DTO（subpath 导出 + `additionalProperties:false` + 非零常量）；
   - `packages/domain` 放纯规则（可注入时钟/随机，不引 I/O）；
   - 服务端用例工厂 `createXxx(deps)` + ports，Sequelize 只在 adapter；
   - web 端经 `apps/web/src/platform/http/api-client.ts` 端口消费，离线适配保持同一契约。
5. **测试**（按 `docs/09_agent/TESTING.md` 层对应）：domain 纯测 + 用例 fake-port 测 + 契约测试；新流水类型必须补账本平衡断言。
6. **验证**：`pnpm check:changed`；资金/迁移相关再跑 `pnpm --filter @gameing/server test`（必要时 `MIGRATION_TEST=1`）；合并前 `pnpm docker:check`。页面改动做视口几何验收。
7. **回写**：受影响 SDD、`docs/09_agent/PROJECT_STATUS.md`、各 Markdown 变更历史；`graphify update .`；报告范围/验证结果/未闭环事项。

## 红线

- 不新造 `common/utils`；跨域只经 `public.ts`；事务只用共享 `TransactionScope`。
- 文档与代码冲突时先报告，不重定义产品规则；显著简化方案须先交用户决定。
