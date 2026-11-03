# Gameing Hall Pixi — 项目代理指南（AGENTS.md）

多端游戏大厅 monorepo（pnpm workspace）：手机/PC 浏览器 H5 + 游戏子厅 + 独立 Admin 后台 + Koa API。首个自研游戏为十三张（`games/shisanshui`），PixiJS 本地练习牌桌已可玩；联机房间、真实账号/资产/结算尚未闭环。施工前必须读 `README.md` 与对应 SDD，本文件是入口而非全部规范。

## 1. 技术栈（已锁定）

- Node `>=24 <25`（镜像锁 `24.21.0`）、pnpm `12.10.1`、TypeScript `6.0.3`（strict）、ESM。
- 前端：Vue 3.5 + Vite 8 + Element Plus（仅 admin）；游戏视图 PixiJS `8.22.0`；契约 TypeBox `0.34.52`（`@sinclair/typebox`）。
- 服务端：Koa 3 + `@koa/router`；MySQL 9.7.2 + Sequelize 6.37.8 + mysql2 3.24.6；迁移 Umzug 3.8.3 + 自定义 `migration_history`。
- 测试：Vitest + Happy DOM（前端/DOM）、`node --test`（server 迁移集成测试，需 `MIGRATION_TEST=1`）。
- 容器：Compose project `gameing-hall-pixi`，MySQL/Redis 具名 external 卷；构建/部署一律在 Docker dev 容器内。

## 2. 仓库地图

| 路径 | 职责 |
| --- | --- |
| `apps/web` | `@gameing/web` 玩家大厅 H5：大厅/子厅、钱包/社交/客服/邀请等工作区，Vue 组件 + 领域 application；`src/platform/browser-api/` 是 IndexedDB 本地适配器（LOCAL_BROWSER_SERVER 模式，dev-only） |
| `apps/admin` | `@gameing/admin` 独立后台：Element Plus，19 个领域工作区当前全部使用本地演示数据，无认证、无领域 API |
| `apps/server` | `@gameing/server` Koa 入口：envelope/requestId/日志/错误边界、health 路由、只读游戏目录路由；`src/infrastructure/database/` 含 Sequelize 实例与 Umzug 迁移（0001~0006 六张表） |
| `packages/contracts` | 玩家端 TypeBox DTO/schema/非零常量（按 subpath 导出，单一来源） |
| `packages/admin-contracts` | Admin 专属 DTO/schema |
| `packages/domain` | 前后端共用的纯领域规则（wallet/social/support/rooms/preferences/coin-market），只依赖 contracts，无 DOM/Node 全局 |
| `games/shisanshui/rules` | 十三张纯 TS 规则与结算（确定性、无随机/时钟/IO） |
| `games/shisanshui/client` | PixiJS 本地练习牌桌客户端 |
| `tools/asset-generation` | AI 素材生成 CLI（`assetgen`，OpenAI/Kling）；密钥只在 `tools/asset-generation/.env`，不提交 |
| `tools/audio-placeholders` | 占位音频生成脚本（`generate.mjs`） |
| `tools/ui-audit` | 边框/表面层 DOM 审计脚本（playwright-core） |
| `assets/` | AI 原图、provenance、manifest；`candidates/`、`provenance/jobs/` 不提交 |
| `docs/` | 权威规则来源，按编号目录归档（`00_problem`~`08_reference`），入口 `docs/README.md` |
| `compose.yaml` / `Dockerfile` / `Dockerfile.dev` | 本地开发与生产镜像；`prod` profile 提供 `api-prod` |

包依赖边界（铁律）：web/admin 不得 import backend/Sequelize/Koa；domain 不依赖任何 I/O；contracts 不依赖 Node built-ins；游戏 client 不得引 backend。详见 `docs/02_architecture/代码分层与接口实现规范.md`。

## 3. 开发命令

全量门禁只在 Docker 内（宿主机直跑 `apps/web` 构建会 `write EPIPE`）：

```sh
docker compose --profile dev run --rm dev pnpm install   # 首次/lockfile 变化
pnpm docker:check          # 等价 CI：lint → lint:apps → format:check → typecheck → test → build
pnpm check:changed         # 本地增量（基线 origin/main，SINCE 可覆盖）；合并前仍须 docker:check
pnpm --filter @gameing/server migrate [up|down|status]   # 需 compose MySQL 已启动
docker compose --profile full up --build -d --wait        # 大厅 10373 / Admin 10374 / API 10300
```

本机端口：server `10300`、MySQL `10306`、Redis `10371`、web `10373`、admin `10374`。迁移集成测试需显式 `MIGRATION_TEST=1`。详见 `docs/09_agent/DEVELOPMENT.md` 与 `docs/09_agent/TESTING.md`。

## 4. 业务规则速查（权威定义见 04_domains 文档，勿在代码里另写一套）

- 常量/枚举一律非零，从 1 起；`0` 仅作查询筛选哨兵。所有表 `id BIGINT UNSIGNED` + `status` + `created_at/updated_at/deleted_at DATETIME(3)` + 全字段注释；引用字段 `abc_id` / `<role>_<table>_id`；流水与审计不可变。
- 玩家统一 `user` 表；`role_type`/`reward_type` 非零常量；邀请五级（含本人）上限四个上级，返点 10/8/5/3；默认 `reward_type=1`（充值返点）。
- 金币转账手续费 5%（发送方额外支付）；赠币与普通金币同钱包，赠币按配置加流水要求，未完成流水禁止提现/转出。
- 充值买金币、返点入余额、金币兑余额后提现；CNY 余额默认 1:10，配置取值；TRON USDT 自建；提现默认 1000 枚金币整数倍门槛 + 身份三选一。
- 系统账户为资产来源/归宿，外部收支与内部转账守恒边界分开；系统金币发行余额可为负，玩家资产与系统 CNY 不可透支。
- 登录 JWT：访问令牌与设备/刷新/二维码凭证分离，服务端撤销。
- 金额用十进制字符串传输（BIGINT ID 同）；时区统一 UTC；不可变分录 `deleted_at` 恒 NULL、`updated_at=created_at`。

## 5. 项目硬约束（原有内容，全部保留）

- 每个 Markdown（`.md`）文件末尾必须包含“变更历史”区块；每次修改文件时，在该区块追加日期与简明变更摘要。新建 Markdown 文件也必须以该区块结束。
- `docs/` 按文档性质归档到编号分类目录；新增文档放入对应分类并更新 `docs/README.md`，不要把专项文档散放在 `docs/` 根目录。
- 如需运行 Python 脚本、安装 Python 依赖或执行 Python 工具，必须使用项目专用 venv。推荐仓库根目录 `.venv`，通过 `.venv/bin/python` 执行、通过 `.venv/bin/python -m pip` 安装；Windows 使用 `.venv\Scripts\python.exe`。系统 Python 仅用于创建 venv，不安装全局依赖。虚拟环境不提交。
- 代码结构导航使用 Graphify 知识图谱（`~/.local/bin/graphify`，uv tool 隔离环境，非本项目依赖，因此不适用上一条的 venv 规则）。查询结构关系优先用 `graphify query` / `path` / `explain`，不要靠 grep 猜文件位置。改完代码后跑 `graphify update .` 增量更新图谱；图谱产物 `graphify-out/` 不提交。接入方式与当前图谱规模见 `docs/08_reference/WorkBuddy工具链与知识图谱接入.md`。
- 本仓库无任何 Python 源码，自动化脚本一律用 Node/TS（`tools/asset-generation` 用 `assetgen` CLI，`tools/audio-placeholders` 用 `generate.mjs`）。
- 美术创作通过 OpenAI API 完成（用户称 ChatGPT 服务商），主模型采用用户指定的 GPT-6 系列。实际 API 模型 ID 显式配置并记入生成台账，不擅自换成其他系列。
- 图像输出使用官方支持的图像生成工具及图像模型配置，与 GPT-6 主模型分别记录。不得假设 `gpt6` 是有效 API ID，或将其直接填入 Images API。具体子型号及图像模型在实施时核实账户权限、官方接口能力并锁定。
- API 密钥只保存在内部素材执行端，不进入 Git、客户端或公开资源清单。
- 所有常量/枚举值均不得占用 `0`；`0` 保留为查询筛选 DTO 中“未选择/不筛选”的哨兵值，进入领域逻辑前转换为未指定条件，不作为持久化状态/类型值。所有表有 `id BIGINT UNSIGNED`、非零常量 `status` 和 DATETIME 类型 `created_at/updated_at/deleted_at`；表名小写 snake_case，所有表/字段都有有效注释。引用 abc 表 ID 的字段命名为 `abc_id`，引用类型同样为 `BIGINT UNSIGNED`；同一行对同一目标表有多个角色引用时，按 `<role>_<table>_id` 命名，例如 `parent_1_user_id`、`admin_user_id`，明确表示引用 `user.id`。不可变流水/审计不得删除或改写。ORM 使用 Sequelize，取代 Kysely，见 `docs/05_data/数据库设计规范与Sequelize方案.md`。
- 玩家统一 `user` 表；`role_type` 和 `reward_type` 常量化，`reward_type` 默认 1（充值返点），2 为客损返点。本人计入五级，最多四个上级，按直属至最远分别 10%/8%/5%/3%；累计客损和支付渠道未完成定义前不启用生产发放。最新定义见 `docs/04_domains/邀请归因返佣与数据规范.md`。
- 金币转账手续费 5%，发送方额外支付；无单笔/每日业务限额，无最低保留余额，但仍校验本金加手续费的可用余额及冻结。
- 充值购买金币，返点入余额，金币兑余额后提现。余额 CNY，默认 1 元:10 金币，配置取值；代理商提供支付宝/微信/银行卡/银联二维码/数字人民币方式，USDT 充值自建 TRON/TRC-20，实时汇率按订单锁定。金币/余额独立账本。
- 登录采用 JWT；访问令牌与设备/刷新/二维码凭证分开，HTTP/Socket 校验过期及服务端撤销，见 `docs/04_domains/JWT登录与会话设计.md`。
- 赠币和普通金币同一钱包、同一玩法；赠送按配置增加流水要求，完成牌局按有效下注额累计（下注 500 计 500，赢多少不额外计）；未完成流水禁止提现及金币转出。此前赠币永久不可兑/分房间建议作废。
- 客损为有符号游戏净输赢剔除赠币补贴，使用已处理高位防重复；领取返点上级的 reward_type 决定模式，充值按实付、客损在提现审核通过后计算入账。充值返点冻 2 天，客损返点冻 1 天。
- 默认最低提现为 1000 枚金币等值，必须是配置门槛正整数倍；提现前身份须满足验证邮箱、验证手机、有效用户名+密码三选一。
- 邀请归因独立接口不经 CF，通过 Redis 暂存 IP 与最后一个有效邀请码；网站/App 请求同一接口，其余页面/API 按 CF 路径。已有上级只能 Admin 换绑。最新细化见 `docs/04_domains/支付渠道流水要求与直连归因.md`。
- 系统账户为资产来源/归宿：充值购买金币时系统余额加实付净额（扣渠道费）、系统金币减购买数；赠币/返点/兑换/手续费均有对应系统分录，实际提现不二次扣系统内部余额。外部收支与内部转账守恒边界分开，见 `docs/04_domains/系统账户与资产记账设计.md`。系统金币发行余额允许为负；玩家资产与系统人民币余额不允许透支，ID 的 BIGINT UNSIGNED 约束不用于有符号资产余额。
- 每次施工前读取相关 `AGENTS.md`、SDD 和现有实现，确认领域归属、依赖方向、接口契约和验收条件；若文档、代码与任务要求冲突，先说明冲突及影响，不擅自重定义产品规则。
- 施工按可验收的纵向闭环推进：优先打通一个真实流程及其必要测试，再扩展相邻功能；避免先铺大量空模块、公共抽象、表或工具。抽取共享代码须符合对应 SDD 的真实消费者、语义一致、无副作用和明确 owner 等条件。
- 跨层格式转换必须显式命名并放在语义所有者边界；金额、概率、时间、状态等业务转换归属领域，不因重复几行代码就放入通用公共包。未经运行时校验的外部输入不得进入领域用例。
- 每项实现完成后回顾是否违反项目规范，并运行与改动风险相称的类型检查、测试、迁移/契约检查；更新受影响的 SDD 和每个 Markdown 的“变更历史”，并报告实现范围、验证结果及未闭环事项。不得把未运行的检查描述为通过。
- 每次修改页面或页面样式后，必须检查代表性桌面/移动视口的宽高：至少记录视口尺寸、页面 `scrollWidth/clientWidth` 与 `scrollHeight/clientHeight`，确认是否有非预期横向或纵向溢出；设计内的轮播/滚动容器单独验收。优先用真实浏览器预览或 E2E；若环境没有浏览器，运行可用的构建/测试并明确记录几何验收未完成，不能把它说成已通过。
- 如确认某项偏离现有规范能够显著减少代码量或结构复杂度，不得擅自偏离或悄悄回退；先向用户给出具体差异、节省点、影响与维护代价，等待用户决定。未获批准时遵循现行规范。

## 6. 施工流程（给编码代理）

1. 读本文件 → `docs/README.md` → 受影响的 04_domains/05_data SDD 与现有实现（结构问题先用 graphify 查询）。
2. 纵向闭环推进，按受影响模块跑 `pnpm check:changed`；页面/样式改动做视口几何验收；合并前 `pnpm docker:check`。
3. 更新受影响 Markdown 的“变更历史”；文档与代码冲突时先报告冲突，不擅自重定义产品规则。
4. 详细步骤见 `docs/09_agent/AGENT_WORKFLOW.md`；数据库迁移见 `docs/09_agent/DATABASE.md`；验收标准见 `docs/09_agent/PROJECT_STATUS.md`。

## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-10-10 | 按项目约束新增变更历史区块；未改动原有正文。 |
| 2026-10-10 | 明确同表多角色外键使用 `<role>_<table>_id` 命名。 |
| 2026-10-10 | 规定所有常量/枚举避开 0，并将 0 保留为查询筛选哨兵值。 |
| 2026-10-10 | 更新文档归档路径引用。 |
| 2026-10-10 | 按文档性质归档 docs，并更新权威文档路径。 |
| 2026-10-10 | 增加施工前核对 SDD、优先纵向闭环、跨层转换归属及验证/文档回写纪律。 |
| 2026-10-10 | 增加施工后规范回顾，并规定显著简化但偏离规范的方案须先交用户决定。 |
| 2026-10-10 | 增加页面修改后的视口宽高及滚动溢出检查纪律。 |
| 2026-10-22 | 增补 Graphify 知识图谱使用纪律（查询优先于 grep、改后增量更新、产物不提交），并明确本仓库无 Python 源码、自动化一律用 Node/TS。 |
| 2026-11-02 | 重构为代理入口文件：新增技术栈、仓库地图、开发命令与施工流程索引，原有“项目约束”逐条保留并移入 §5；新增 `docs/09_agent/` 文档组并在此登记链接。 |
