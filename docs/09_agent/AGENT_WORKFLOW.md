# 代理施工工作流

适用：任何编码代理进入本仓库后的标准动作序列。

## 步骤

1. **读入口**：`AGENTS.md`（技术栈/仓库地图/硬约束），再读 `docs/README.md` 定位权威文档。
2. **定位领域**：按任务读对应 SDD——业务规则查 `docs/09_agent/BUSINESS_DOMAINS.md` → 04_domains；接口查 `docs/09_agent/API_CONTRACTS.md`；表结构查 `docs/09_agent/DATABASE.md`；现状查 `docs/09_agent/PROJECT_STATUS.md`。
3. **查结构**：文件关系先 `graphify query/path/explain`（`~/.local/bin/graphify`），其次读相邻实现；grep 仅作最后手段。
4. **识别依赖**：列出受影响的包/模块/契约/迁移；确认依赖方向未违反 02_architecture 边界铁律（web 不引 backend、domain 无 I/O 等）。
5. **定义变更**：按可验收的纵向闭环切分；需要新表/新端点时先对齐 05_data 与 HTTP SDD；文档、代码、任务要求冲突时先报告冲突，不擅自重定义产品规则。
6. **实施**：遵守现有约定（TypeBox schema、非零常量、十进制字符串金额、`public.ts` 边界、`createXxx(deps)` 用例工厂风格）；不新建无 owner 的 `common/utils`。
7. **测试与契约**：按 `docs/09_agent/TESTING.md` 的层对应关系补测试；新增流水类型必须补账本平衡断言。
8. **验证**：`pnpm check:changed`（基线 `origin/main`，`SINCE` 可换）；合并前 `pnpm docker:check`；页面/样式改动做视口几何验收（记录视口尺寸与 scroll/client 宽高，无浏览器则明确记录未完成）。
9. **回写文档**：更新受影响 SDD、`docs/09_agent/PROJECT_STATUS.md` 与本清单中每个被改 Markdown 的“变更历史”区块；改完代码跑 `graphify update .`。
10. **报告**：实现范围、运行过的检查与结果（不得把未运行的检查说成通过）、未闭环事项。

## 红线（与 AGENTS.md §5 一致）

- 不动业务规则口径；不可变流水/审计不得删除或改写。
- 不在启动路径 `sync()`；不改既有迁移（checksum 会拒覆盖），只追加。
- 不提交 `.env`、密钥、`graphify-out/`、`assets/candidates/`。
- 显著简化但偏离规范的方案：先给用户差异/代价，获批准前按现行规范执行。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-11-02 | 新建：定义 10 步施工流程与红线，指向 09_agent 各速查文档，与 AGENTS.md 约束一致。 |
