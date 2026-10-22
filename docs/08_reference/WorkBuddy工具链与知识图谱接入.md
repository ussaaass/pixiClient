# WorkBuddy 工具链接入与知识图谱使用说明

本文件记录 pixiClient 项目在 WorkBuddy（CodeBuddy 的继任 IDE）下的工具链初始化状态、Graphify 知识图谱的接入方式，以及后续开发中如何正确使用这些能力。

## 1. 为什么做这次初始化

本项目此前不存在任何 IDE 级别的工程上下文：没有 CI 门禁、没有 lint/format、没有提交钩子、没有任何代码结构索引。开发者只能靠"记住文件在哪"来导航一个 4 万行、19 个 Admin 领域的 monorepo。

本次初始化确立三件事：

1. **工程门禁**：CI（typecheck / test / build）、ESLint、Prettier、husky 提交钩子，使代码变坏时能被自动拦住。
2. **结构索引**：Graphify 知识图谱，把"文件之间的关系"变成可查询对象，而不是靠 grep 猜。
3. **工具边界**：本仓库用 Node/TS，**没有任何 Python 源码**；Python 只在两个场景出现——Graphify（外部 CLI）与 AGENTS.md 规定的项目 venv 规则。

## 2. Graphify 知识图谱

### 2.1 安装形态（重要）

Graphify **不是** npm 包，而是 PyPI 包 `graphifyy`（双 y），命令名为 `graphify`。

本机已通过 `uv tool install` 装在**用户级隔离环境**中：

| 项    | 值                                                                             |
| ---- | ----------------------------------------------------------------------------- |
| 命令入口 | `~/.local/bin/graphify`（软链到 `~/.local/share/uv/tools/graphifyy/bin/graphify`） |
| 版本   | 0.9.54                                                                        |
| 解释器  | `~/.local/share/uv/tools/graphifyy/bin/python`（uv 工具专属 venv）                  |
| 已装扩展 | `mcp`（含 `mcp` 2.1.1）                                                          |
| 未装扩展 | `leiden`（社区命名质量提升）、`chinese`（中文查询分词）                                          |

**不需要**在本仓库内再建 `.venv`：Graphify 是全局 CLI 工具，不是项目依赖。`AGENTS.md` 的 venv 规则针对"本项目自己的 Python 脚本与依赖"，不适用于外部 CLI。

> 若未来要在本仓库写 Python 脚本，再按 `AGENTS.md` 第 5 条建 `.venv`，两者互不冲突。

### 2.2 项目级安装产物

```
.codebuddy/skills/graphify/
├── SKILL.md              # 助手可加载的技能说明
├── references/           # 8 篇按需加载的参考文档
│   ├── extraction-spec.md
│   ├── query.md
│   ├── update.md
│   ├── hooks.md
│   ├── exports.md
│   ├── add-watch.md
│   ├── transcribe.md
│   └── github-and-merge.md
└── .graphify_version
```

路径依据：WorkBuddy 内置 `skill-creator` 的规范明确写明**项目级 skill 位于 `.codebuddy/skills/<skill-name>/`**（用户级为 `~/.codebuddy/skills/`）。这与 Graphify `install --platform codebuddy` 的目标路径一致，因此直接采用。

安装命令：

```sh
graphify install --project --platform codebuddy
```

### 2.3 配置文件

| 文件                | 作用                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `.graphifyrc`     | 项目级参数。当前声明 `language.ts=typescript`（避免 `.ts` 扩展名歧义）与 `viz_node_limit=0`（不限制可视化节点数）。           |
| `.graphifyignore` | 补充 `.gitignore`：排除 `node_modules/`、`dist/`、`assets/candidates/`、`graphify-out/` 自身、`.env*` 等。 |
| `.gitignore`      | 新增 `graphify-out/`、`.graphify/`、`.venv/` 三条。                                                  |

### 2.4 当前图谱状态

| 项      | 值                                                                                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 节点数    | 4,641                                                                                                                                  |
| 边数     | 9,246                                                                                                                                  |
| 社区数    | 185（162 个有意义，11 个过薄已省略）                                                                                                                |
| 边来源    | 97% `EXTRACTED`（源码中显式存在）/ 3% `INFERRED`（graphify 推断，平均置信度 0.81）                                                                        |
| 索引代码文件 | 504 个（首轮）/ 741 个（增量后，含缓存命中）                                                                                                            |
| 基线提交   | `78face0f`                                                                                                                             |
| 产物     | `graphify-out/graph.json`（6.0 MB）、`graphify-out/graph.html`（4.9 MB）、`graphify-out/GRAPH_REPORT.md`（44 KB）、`graphify-out/manifest.json` |

### 2.5 无 LLM 后端的取舍

本机**没有配置任何 LLM 后端**（无 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` 等，Ollama 未运行）。Graphify 的 `--backend none` 在 0.9.54 版本中不存在，因此采用 `--code-only`：

- **代码层**（504 个 `.ts` / `.vue` / `.mjs` 文件）：tree-sitter 本地 AST 解析，**完全离线、确定性、无需 API key**。
- **文档层**（`docs/` 下 70 篇）：本轮**未进图谱**。文档语义抽取需要 LLM，且 `docs/` 是本项目的权威产品规则来源，长期看值得纳入。

**代价**：图谱目前只能回答"代码结构关系"，不能回答"产品规则关系"。这是已知缺口，不是已完成项。

### 2.6 日常用法

```sh
# 增量更新（代码变更后，无需 API 成本）
graphify update .

# 重新聚类并生成报告与可视化
graphify cluster-only .

# 自然语言查询（返回相关子图）
graphify query "wallet balance ledger and withdrawal flow" --budget 2000

# 两节点最短路径
graphify path "WalletApplication" "WithdrawalDto"

# 解释单节点及其邻居
graphify explain "IndexedDbLocalIdentityRepository"

# 架构枢纽（连接度最高的节点）
graphify god-nodes --top 20

# 打开可视化
open graphify-out/graph.html
```

> **`graphify update .` 在 0.9.54 上有上游缺陷**：在 `graphify-out/` 已存在时，AST 抽取能跑完（485/485），但重建阶段必然报  
> `EEXIST: file already exists, mkdir '<repo>/graphify-out'`，`graph.json` 不会被写回。  
> 已确认该错误与 `os.mkdir` / `os.makedirs` / `Path.mkdir` 的调用栈无关——包内所有 `mkdir` 均带 `exist_ok=True`，  
> 怀疑是 0.9.54 中 `watch.py` 重建路径的目录处理有误。  
> **当前可用替代**：`graphify extract . --code-only` 走的是另一条路径（`build.py`），  
> 实测**能正常写回** `graph.json`（已验证：增量后 4,641 节点 / 9,246 边 / 185 社区，  
> 且自动剪掉已删除/被排除源文件的 16 个节点），随后 `graphify cluster-only .` 生成报告与可视化。  
> 改完代码跑这两条即可。升级到 0.9.93 后应重新验证 `update` 是否恢复。

### 2.7 图谱给出的架构信号

首次 `god-nodes` 查询结果与代码审计结论一致，**互为印证**：

| 排名   | 节点                                                                                                                          | 连边数   | 含义              |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | ----- | --------------- |
| 1    | `openAdminDevelopmentDatabase()`                                                                                            | 57    | Admin 数据访问的集中入口 |
| 2    | `IndexedDbSocialRepository`                                                                                                 | 53    | 浏览器伪后端的社交域实现    |
| 3    | `IndexedDbLocalIdentityRepository`                                                                                          | 40    | 身份域的浏览器实现       |
| 4    | `LocalCredential`                                                                                                           | 36    | 身份凭据类型          |
| 5    | `IdentitySettingsResponseDto`                                                                                               | 36    | 身份契约            |
| 6–10 | `LocalIdentityRepository` / `PlayerIdentityPort` / `LocalIdentityApplication` / `BrowserPlayerIdentityAdapter` / `sha256()` | 24–35 | 身份域全线占据枢纽       |

**结论**：连接度最高的 10 个节点里有 7 个属于身份域，且 `IndexedDb*` / `Local*` / `Browser*` / `Offline*` 前缀反复出现——这正是"业务逻辑实现在浏览器伪后端而非服务端"这一核心问题的量化证据。后续做 `packages/domain` 下沉、服务端接管时，应以 `god-nodes` 的变化作为收敛指标。

## 3. Git 钩子

`graphify hook install` 已装入项目既有的 husky 目录，与现有 `pre-commit` 并存：

| 钩子                     | 行为                                                                         |
| ---------------------- | -------------------------------------------------------------------------- |
| `.husky/post-commit`   | 提交后**后台**重建代码图谱（detached，不阻塞 `git commit`）；rebase/merge/cherry-pick 中自动跳过。 |
| `.husky/post-checkout` | 切换分支后后台重建。                                                                 |

重建日志：`~/.cache/graphify-rebuild.log`。临时跳过：`GRAPHIFY_SKIP_HOOK=1`。

同时注册了 git merge driver `graphify`（对 `graph.json` 做并集合并），避免并行开发时图谱文件产生文本冲突。

## 4. MCP 服务器接入

已在 `~/.workbuddy-ai/mcp.json` 注册 Graphify MCP 服务器（**用户级**，非项目级——MCP 配置按 WorkBuddy 规范只放这一处）：

```json
{
  "mcpServers": {
    "graphify": {
      "command": "/Users/macbookpro/.local/share/uv/tools/graphifyy/bin/python",
      "args": ["-m", "graphify.serve",
               "/Users/macbookpro/Devs/projects/pixiClient/graphify-out/graph.json",
               "--transport", "stdio"],
      "cwd": "/Users/macbookpro/Devs/projects/pixiClient",
      "env": { "GRAPHIFY_BACKEND": "none" }
    }
  }
}
```

已实测握手与工具列表（`initialize` 返回 `graphify 0.9.54`），暴露 10 个工具：

`query_graph`、`get_node`、`get_neighbors`、`get_community`、`god_nodes`、`graph_stats`、`shortest_path`、`list_prs`、`get_pr_impact`、`triage_prs`

> 新增 MCP 后不会自动生效：需在连接器管理页右上角的自定义连接器入口点击"信任"以启用。

## 5. WorkBuddy 现有 MCP 与 Skill 清单

### 5.1 会话内可用的 MCP 工具

| MCP             | 工具                                                                                                                                                  | 用途          | 本项目适用性                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------- |
| `sheetagent`    | `read_table` / `set_cell_range` / `search_data` / `calculate_formulas` / `run_command` / `fill_formula` / `get_cell_ranges` / `resolve_local_excel` | 电子表格读写与公式计算 | 运营报表、余额对账表                         |
| `space-library` | `library_search`                                                                                                                                    | 云端资料库检索     | 产品文档沉淀                             |
| `weixinpay`     | `weixinpay_register` / `weixinpay_retry_pay` / `weixinpay_feedback`                                                                                 | 微信支付 AI 专属卡 | 充值链路（尚无生产支付）                       |
| `miora`         | `ImageGen` / `VideoGen`                                                                                                                             | 多模态生成       | 美术素材生产（配合 AGENTS.md 的 OpenAI 美术约定） |
| `graphify`      | 见上节 10 个                                                                                                                                            | 代码知识图谱      | **本项目日常主力**                        |

### 5.2 已安装的 Skill（47 项）

| 来源             | 数量 | 说明                                                       |
| -------------- | -- | -------------------------------------------------------- |
| `builtin`      | 17 | WorkBuddy 内置：云服务、资料库、Office 路由、本地文件编辑、多模态、Skill 创建、专家管理等 |
| `userSettings` | 28 | 用户安装：设计类（ardot 系列 6 个）、腾讯文档、PDF、pptx、表格、微信支付等            |
| `plugin`       | 2  | `workbuddy-docx`、`agent-browser`                         |

**本项目高频使用建议**：

- `agent-browser` — 真实 Chromium 截图与 DOM 几何测量（AGENTS.md 第 23 条要求的视口宽高验收依赖它）。
- `workbuddy-office-routing` → `workbuddy-docx` / `workbuddy-sheet-generation` / `workbuddy-sheetagent` — 产出交付物。
- `pdf` / `pdfkit-py` — 处理 `docs/` 与外部资料。
- `find-skills` / `marketplace-skill-installer` — 需要新能力时按需安装。

### 5.3 未绑定连接器

`connector-states.v3.json` 显示 `enabled: []`、`everConnected: []`——**当前没有任何外部服务连接器被绑定**。需要时可从连接器市场按需接入（如 GitHub、腾讯文档、Figma 等）。

## 6. 未闭环事项

- **文档语义层未进图谱**：缺 LLM 后端。补齐路径二选一——配置 `OPENAI_API_KEY` 后跑 `graphify extract .`（含 `docs/`），或安装 `chinese` 扩展改善中文查询分词。
- **社区仍是 `Community N` 占位名**：需 LLM 才能命名。当前 `GRAPH_REPORT.md` 的 "Community Hubs" 是文件名而非语义名。
- **`.mjs` / `tools/` 目录覆盖度**：`tools/asset-generation` 已入 workspace 并被索引；`.venv`（若未来创建）由 `.graphifyignore` 排除。
- **MCP 信任操作需用户手动完成**：见第 4 节提示。
- **`graphify-out/` 未纳入版本控制**：按 `.gitignore` 排除，图谱随代码重建，不作为源码提交；如需团队共享需另行决定策略。
- **Graphify 版本 0.9.54 落后 PyPI 最新 0.9.93**：新版本新增 `--backend none` 与 `chinese` 扩展。升级需 `uv tool upgrade graphifyy`，届时 `graph.json` 的 `graph.schema_version` 可能变化，需重新抽取。
- **`graphify update .` 在 0.9.54 不可用**（详见 2.6）：已有 `graphify-out/` 时重建阶段必报 `EEXIST`，AST 抽取能跑完但 `graph.json` 不写回。当前用 `extract --code-only` + `cluster-only` 代替。这是本次初始化**唯一未闭环的功能性缺陷**，属上游问题，未在本仓库侧绕过。

## 变更历史

| 日期         | 变更                                                                                                                                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-22 | 首次建立 WorkBuddy 工具链接入与 Graphify 知识图谱说明：记录 uv tool 安装形态、项目级 skill 安装路径、`.graphifyrc` / `.graphifyignore` / `.gitignore` 变更、首轮图谱规模（4,646 节点 / 9,258 边 / 180 社区）、无 LLM 后端下 `--code-only` 的取舍、git 钩子与 merge driver、MCP 服务器注册与实测握手结果、MCP/Skill 全量清单，以及 6 项未闭环事项。 |
