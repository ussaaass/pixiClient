# AI asset generation CLI

This package creates reviewable AI-generated candidates. It does not auto-approve or publish model output. It uses Node's built-in `fetch`, so no package install or API token is needed for offline planning and tests.

## Setup

Use Node 24 for the project. The current CLI has no runtime package dependencies and uses Node's built-in `fetch`; Node 22.6+ can run the same type-stripped TypeScript source for local development.

1. Copy `.env.example` to `.env` in this directory.
2. For Space Bunny SVG assets, fill `SPACE_BUNNY_API_KEY`. The documented default URL and model ID are already provided; confirm both against the account/API route you use.
3. For OpenAI PNG/WebP assets, fill `OPENAI_API_KEY`, `OPENAI_MAIN_MODEL`, and `OPENAI_IMAGE_MODEL` separately.
4. For Kling image-to-video, fill `KLINGAI_API_KEY`; the default endpoint is the official Singapore API host and the default video model is `kling-v3`.
5. Run `npm run assetgen -- --help` from this directory.

The official API key is read only by the local generator process. The local `.env` is gitignored. Do not put a key in a browser bundle, asset manifest, prompt, job ledger, or Git. Use `.env.example` as the variable template; model IDs must be confirmed against the API account before the first generation.

## Workflow

```sh
npm run assetgen -- list-specs
npm run assetgen -- plan ../../assets/specs/lobby-background.json
npm run assetgen -- generate ../../assets/specs/lobby-background.json
npm run assetgen -- generate ../../assets/specs/icon-game-shisanshui.json
npm run assetgen -- generate ../../assets/specs/icon-wallet-coins.json
npm run assetgen -- generate ../../assets/specs/icon-customer-service.json
npm run assetgen -- crop-avatar-sheets FEMALE_SHEET_JOB_ID MALE_SHEET_JOB_ID
npm run assetgen -- build-shisanshui-deck
npm run assetgen -- build-avif-animation MOTION_SHEET_JOB_ID
npm run assetgen -- kling-submit ../../assets/specs/player-pages/wallet-casino-background-motion-v1.json
npm run assetgen -- kling-resume KLING_JOB_ID
npm run assetgen -- kling-to-avif KLING_JOB_ID
npm run assetgen -- kling-submit ../../assets/specs/mobile-game-cards-kling-motion-v1/shisanshui.json
npm run assetgen -- generate ../../assets/specs/icon-invite-network.json
npm run assetgen -- list
npm run assetgen -- approve JOB_ID --by "reviewer"
npm run assetgen -- publish JOB_ID
```

Kling video specs provide the reviewed static background, motion prompt and duration. The CLI converts WebP references to JPEG with `ffmpeg`, submits the image as both first and last frame, then saves the task ID before polling. `kling-resume` is safe to repeat and downloads a completed MP4 into `assets/candidates/` for human review. Network uncertainty during task creation is recorded as `UNKNOWN`; do not submit a duplicate until checking the Kling console. Signed result URLs are used only for the immediate download and are never written to the local job ledger. `kling-to-avif` is a separate explicit review step; it detects source orientation and defaults to 960×640 for landscape or 640×960 for portrait, 5 fps, CRF 35, mild sharpening and an infinite loop. Use `--ping-pong` when AI motion does not return exactly to its first frame; it appends the reversed interior frames so the AVIF loop closes without a hard jump. The manifest records `animation.loopMode` as `forward` or `ping-pong`. Override with `--width`, `--height`, `--fps` or `--crf`; output aspect ratio must match the source, so mobile needs a separately composed portrait source/video rather than a cropped desktop animation. No generated result is approved or published automatically. Kling task result URLs expire, so download completed candidates promptly.

The Mobile game-card Kling specs in `assets/specs/mobile-game-cards-kling-motion-v1/` use the OpenAI second-set portrait images as the motion references. Their current review outputs are 537×960, 8 fps, CRF 30 AVIF candidates. They do not modify the live game-card assets; review the MP4/AVIF pair and approve a candidate before any production copy.

After visual review, corrected source-image specs live in `assets/specs/mobile-game-cards-corrections-v1/` and later numbered correction directories; Kling prompts are in the matching `assets/specs/mobile-game-cards-kling-motion-v*` directories. The corrected source candidates and every AVIF pass remain separate from live assets. Mahjong Hule 2 is judged on all four legs/paws remaining visible and distinct; toe count per paw is irrelevant. The user chose to retain the previous four-paw composition and rejected the newer coiled-ring/title treatment; its source and AVIF remain for traceability only. 3快 passes still need frame-by-frame number review. Inspect multiple timestamps before approval: Kling can preserve a valid AVIF container while changing card faces, dropping or distorting numbers, or producing too little visible motion.

`plan` validates the spec and prints the exact seed prompt without an API key. `generate` selects the provider from the spec output format: PNG/WebP uses GPT-6 prompt refinement and then calls the Responses API with GPT-6 Sol as the main model and the configured GPT Image generation tool; SVG uses the Space Bunny Chat Completions API to return SVG markup. The SVG route validates a safe subset of SVG and writes the vector source as a candidate; rasterization/format variants can be added as a build step later. Generated files go to ignored `assets/candidates/`; local job records are ignored while unreviewed. Ambiguous network failures become `UNKNOWN` and are not retried automatically, because a timed-out generation may still have been billed. `approve` requires a reviewer name and copies the source into `assets/source/`; it also writes the approved provenance record under `assets/provenance/approved/`. Only `publish` creates a manifest under `assets/manifests/generated/` and a release copy under `assets/releases/`.

The CLI records the spec/style/output hashes, prompt, provider/model IDs, request IDs, API usage, timestamps, status, reviewer and release path. A raster spec may provide up to four `visualReferenceImages` with repo-relative PNG, WebP, or JPEG paths and a short purpose. The OpenAI Responses request sends those local files as `input_image` data URLs alongside the final prompt; reference files are limited to 8 MB each and 12 MB total. Their paths and SHA-256 hashes are stored in the job and release manifest. The prompt must say whether references guide style only or also content/composition. Do not use an unreviewed candidate as the permanent style anchor without an explicit review decision.

`crop-avatar-sheets` requires ImageMagick 7 (`magick`) and accepts the IDs of two successful 1600x1600 WebP jobs named `avatar-sheet-female` and `avatar-sheet-male`. It crops exact 320x320 cells and writes 50 separate `REVIEW_REQUIRED` candidates, each with its own job record and a hash/coordinate link to its source sheet. The sheet-generation cost remains on the parent job; local crops are recorded as zero-API-cost derivatives.

`build-shisanshui-deck` deterministically composites the standard 52 card faces as 384x512 WebP candidates. Rank labels, suit pips and positions are code-rendered; the 12 generated court portraits appear in J/Q/K cards. `build-avif-animation` consumes a 1600x1600 transparent 4x4 motion sheet and requires ImageMagick 7 plus `avifenc`/`avifdec` from libavif. It writes one alpha-capable 16-frame, 12 fps, single-play AVIF candidate while retaining the source WebP atlas for Pixi-controlled frame playback. Both commands create review-only derivatives and are safe to rerun without duplicating completed candidates.

Cost remains `NOT_RECONCILED` until `record-cost` reconciles actual or estimated billing. The CLI never invents a generation result when credentials are absent. Raster image signatures, requested format, file size and PNG dimensions are checked; SVG candidates are restricted to an offline-safe subset before review. The reviewer still needs to inspect visual quality and policy suitability.


## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-10-10 | 按项目约束新增变更历史区块；未改动原有正文。 |
| 2026-10-18 | 接入 Kling 图片转视频任务客户端、任务恢复命令与四张玩家赌场背景动效规格；密钥仅由素材执行端本地环境读取。 |
| 2026-10-18 | 禁止把 Kling 临时签名下载地址写入素材台账；下载后仅保留本地候选文件和任务元数据。 |
| 2026-10-18 | AVIF 转码改为保留原视频分辨率、8fps、提高编码质量并轻度锐化，减少模糊感和帧数。 |
| 2026-10-18 | 转码按源素材方向输出横版 960×640 或竖版 640×960，默认 5fps/CRF35，并允许显式调整输出参数。 |
| 2026-10-18 | Kling AVIF 转码支持 `--ping-pong` 双向循环并在素材台账记录循环模式，降低 AI 视频首尾帧差异造成的循环跳变。 |
| 2026-10-19 | 增加 Mobile 游戏卡片 Kling 动效规格与审核流程说明；第二组 OpenAI 静态图用于生成循环 AVIF 候选，不自动接入线上。 |
| 2026-10-19 | 补充 Kling 动效逐帧视觉验收纪律及纠错版规格目录；明确 AVIF 帧数校验不能代替牌面、号码、题材和动作质量检查。 |
| 2026-10-19 | 登记麻将胡了 2 四肢可见要求（不限制每只爪的趾数）与 3快号码球后续规格；Kling AVIF 候选经抽帧检查后仍保留人工审核，不自动发布。 |
| 2026-10-19 | 登记麻将胡了 2 盘龙、动牌和中心红字候选；用户审阅后拒绝该方向并选择保留上一版构图。 |
