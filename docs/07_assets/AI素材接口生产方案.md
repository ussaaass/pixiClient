# AI 素材接口生产方案

## 已确认约束

美术素材必须通过 AI API 生成，不能把人工登录网页工具、手动下载作为正式生产流程。生成、修改和派生素材均进入可追溯的任务流程；程序负责组合、格式转换和验证。当前主路线为 OpenAI/GPT-6 文本模型与独立图像模型，静态交付 WebP。Space Bunny SVG 路线已通过 FlClash 测试提交两次，但均返回 HTTP 502；本项目暂不将它用于正式美术生产。资源数量和页面/动效划分见[美术资源与动效设计清单](./美术资源与动效设计清单.md)。

### OpenAI 与 GPT-6 配置

按 2026-10-09 查阅的官方文档，GPT-6 系列有具体模型 ID；`gpt6` 不能直接假设为 API ID。工具通过 `OPENAI_MAIN_MODEL` 显式配置实际启用的 GPT-6 模型。首版用 Responses API 对素材规格提示词进行整理，原始规格仍可离线预览；没有自动切换模型。代码使用 Node 内置 `fetch`，暂不引入 OpenAI SDK 运行依赖。[官方模型目录](https://developers.openai.com/api/docs/models) [Responses API](https://developers.openai.com/api/docs/api-reference/responses)

位图通过 Responses API 的 `image_generation` 工具生成：顶层主模型配置为 `gpt-6-sol`，工具使用单独的 GPT Image 模型配置。官方模型页列出 GPT-6 Sol 支持图像生成工具，响应中的 `image_generation_call.result` 是 Base64 图片数据；工具解码后校验格式、大小与 PNG 尺寸。GPT-6 Sol 不作为 `/images/generations` 的图像模型参数传入。当前本机已将 `.env` 中 `OPENAI_MAIN_MODEL` 配置为 `gpt-6-sol`，将 `OPENAI_IMAGE_MODEL` 配置为 `gpt-image-2.5-sunburst`。[GPT-6 Sol 官方模型页](https://developers.openai.com/api/docs/models/gpt-6-sol) [Responses 图像生成工具文档](https://developers.openai.com/api/docs/guides/tools-image-generation)

### Space Bunny SVG 小图标路线

Space Bunny 的 API 文档给出 OpenAI 兼容的 `POST /api/v1/chat/completions` 接口，使用 `stealth/space-bunny-alpha` 模型 ID；模型端接收图像作为输入，但响应为文本。项目把 SVG 标记作为文本输出请求，因此这条路线生成的是 SVG 源码，不是 PNG/WebP 二进制图像。官方模型文档与图标图库展示了 SVG 绘图用例，故先用小型大厅图标试验，不能据此推定它提供通用位图图像生成接口。[Space Bunny API 文档](https://spacebunny.app/docs) [Space Bunny SVG 绘图示例](https://spacebunnyalpha.com/)

工具通过 `SPACE_BUNNY_API_KEY`、`SPACE_BUNNY_BASE_URL`、`SPACE_BUNNY_MODEL` 配置；默认 URL 和模型 ID 来自 Space Bunny API 文档。官方接口是文本回复的 Chat Completions，不是位图生成端点。项目曾要求它返回 SVG 源码；经 FlClash 本地代理实测，两次 API 请求均返回 HTTP 502，没有得到 SVG 输出，因此该适配器保留为实验实现，当前生产批次切回 OpenAI。若以后重试，SVG 仍须验证安全标签、外链和嵌入资源，再决定是否栅格化为 WebP。

### Python 环境约束

生产工具优先沿用项目 TypeScript 工具链；如图像处理或批处理需要 Python，必须使用项目专用 venv，不安装全局依赖。推荐初始化方式：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r tools/asset-generation/requirements.txt
```

以上是未来初始化示例，当前尚未创建该依赖文件。脚本、IDE、CI 和任务执行器均指定 venv 解释器；Windows 使用 `.venv\Scripts\python.exe`。依赖需锁定，`.venv/` 不提交；每个执行环境自行创建，不复制开发机的虚拟环境。系统 Python 仅用于创建环境。

素材生成属于开发与运营生产工具。首版 CLI 位于 `tools/asset-generation/`，独立于游戏客户端执行；玩家进入大厅或游戏时只下载已经审核发布的资源，不等待现场生成，也不直接访问 AI 服务。CLI 已实现本地规格预览、提示词整理、OpenAI 位图与实验性的 Space Bunny SVG API 适配、候选文件检查、任务台账、人工批准、发布清单和费用回填。Space Bunny Key 已配置，但两次在线调用返回 HTTP 502，未生成候选素材。

大厅风格已确定为卡通；月度 AI 预算较宽松，尚无具体金额。先用 API 试制统一风格母版，再记录每份合格素材的实际成本，配置月度预算与告警；不能将“宽松”解释为无限调用额度。

## 目录与职责

- `tools/asset-generation/`：任务定义、生成 CLI、提供商适配器、任务执行、结果下载及生成台账；单独配置凭证与依赖，不进入客户端包。
- `assets/specs/`：资产尺寸、透明要求、风格母版引用、提示词模板与验收规则。
- `assets/source/`：已取回的原始输出与经选定的母版。
- `assets/provenance/`：每份素材关联的任务、模型、输入摘要、成本与验收记录。
- `tools/assets/`：确定性组合、裁切、压缩、图集与格式校验。
- `assets/manifests/`：批准发布的版本、内容 hash、格式变体与依赖清单。

生成工具与线上游戏 server/worker 分开部署和授予凭证；后续需要 Admin 操作时，管理界面只提交内部任务，由素材执行器处理。模型输出先进入候选区，不自动覆盖正式资源。

## 任务流程

`DRAFT → QUEUED → GENERATING → FETCHING → VALIDATING → REVIEW_REQUIRED → APPROVED → BUILT → RELEASED`

失败任务进入 `FAILED`，取消进入 `CANCELLED`，保留原阶段与原因。原型可用本地持久化台账，多人并行或接入 Admin 后采用独立任务存储；进程退出后可恢复，不能仅靠内存记录。

1. 根据资产规格与选定风格生成任务，记录输入文件 hash、提示词版本、模型配置和任务 ID。
2. 检查调用额度与项目预算，通过提供商适配器提交生成或编辑请求。
3. 同步返回与异步轮询分别适配。服务商若支持幂等键或任务查询则使用对应能力；请求超时且执行状态不明时先核对，不盲目重提造成重复计费。不支持查询的请求标记结果未知，交由操作人员处理。
4. 将输出下载到受控存储，验证文件签名、尺寸、格式和内容 hash；服务商临时链接不作为客户端资源地址。
5. 自动检查尺寸、透明通道、文件大小和卡牌覆盖；视觉风格与可读性需要人工验收。人工负责选择与批准，不绘制或手工修改素材。
6. 批准后运行现有资源构建流程，生成 WebP 等变体和 manifest，形成可回滚的发布版本。

失败重试要区分限流、网络失败、参数错误和内容拒绝；采用有上限的退避，参数错误先修正，内容拒绝记录原因。已完成生成但下载失败时优先重试下载，不重新生成。预算包含失败尝试与修复；达到额度停止新任务，不影响线上玩家。

## 提供商边界与凭证

内部定义 `submitGeneration`、`submitEdit`、`getJob`、`downloadOutput` 等能力，适配器声明支持情况，缺失能力不能伪造为通用功能。文本/SVG、图像和音频使用不同能力接口；不假定一个模型同时支持透明图、精确 SVG、动画及音效。

API 密钥仅存放在执行器环境或密钥管理系统，不写入 Git、浏览器、App、公开 manifest 或客户端环境变量。开发示例只放变量名称。请求日志隐藏密钥与签名链接；参考文件的远程地址限定可信来源，拒绝任意内网地址下载。

生成台账至少记录：`assetId、taskId、provider、model、promptVersion、inputHashes、parameters、providerRequestId、status、attempts、outputHashes、usage、cost、currency、createdAt、reviewDecision、releaseVersion`。未返回准确费用时保存用量与费用估算标识；随机种子仅在服务商支持时记录，不承诺生成结果可逐字节复现。

## 首次验证与验收

首次在线试制前，根据 OpenAI 官方 API 文档和账户可用能力锁定 GPT-6 文本模型与图像模型，确认鉴权、输出格式、限流、拒绝响应与计费。先生成一张大厅背景和一张游戏封面，验证风格、手机构图、文件大小和审批发布链；其后再做牌背/装饰与牌面母版。工具通过 CLI 单张调用，当前没有异步任务轮询，也不自动重试可能已经被计费的超时请求。

**当前素材现状：** 已有六份规格（四个入口图标、大厅背景、十三张封面）。`assets/aigen/` 有用户生成并暂定使用的十三张入口图标；OpenAI 已通过 FlClash 本地代理成功生成同一入口图标的另一候选，任务状态为 `REVIEW_REQUIRED`，尚未批准/发布。其 PNG 原图及 WebP 预览均在 `assets/candidates/icon-game-shisanshui/e1b8e67d-05e5-4212-80ad-b1a065ff9009/`。第一版待生成数量、页面复用、首批批次和可选宫廷牌/头像/动图见[美术资源与动效设计清单](./美术资源与动效设计清单.md)。

52 张牌不逐张让图像模型绘制点数和花色：AI 生成牌框、牌背、宫廷人物插画和风格化花色母版；生成工具再按确定性牌面模板组合数字、花色位置与旋转，保证牌面语义正确。按钮文字、金币数值和大厅标签由 H5 文本渲染，不烘焙进图片。这样视觉插画由 AI 产出，牌面规则信息仍精确可验证。尚未接通图像 API 时可以先做无艺术内容的灰盒线框和逻辑测试；进入视觉验收前必须先完成这批 AI 小样并记录模型、任务、输入摘要、成本和批准状态。

验收要求：全部创作母版有 API 任务记录；失败可追踪且重启可恢复；客户端无 API 密钥；未经批准的输出不进入发布清单；重复下载不重复生成；预算达到上限可停止生产；发布资源支持版本回滚。52 张牌仍由经过验收的 AI 母版与确定性牌面配置组合，保证点数和花色准确。


## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-10-10 | 按项目约束新增变更历史区块；未改动原有正文。 |
| 2026-10-10 | 按文档性质归档并更新相关链接。 |
