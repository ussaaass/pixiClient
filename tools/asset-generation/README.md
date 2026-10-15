# AI asset generation CLI

This package creates reviewable AI-generated candidates. It does not auto-approve or publish model output. It uses Node's built-in `fetch`, so no package install or API token is needed for offline planning and tests.

## Setup

Use Node 24 for the project. The current CLI has no runtime package dependencies and uses Node's built-in `fetch`; Node 22.6+ can run the same type-stripped TypeScript source for local development.

1. Copy `.env.example` to `.env` in this directory.
2. For Space Bunny SVG assets, fill `SPACE_BUNNY_API_KEY`. The documented default URL and model ID are already provided; confirm both against the account/API route you use.
3. For OpenAI PNG/WebP assets, fill `OPENAI_API_KEY`, `OPENAI_MAIN_MODEL`, and `OPENAI_IMAGE_MODEL` separately.
4. Run `npm run assetgen -- --help` from this directory.

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
npm run assetgen -- generate ../../assets/specs/icon-invite-network.json
npm run assetgen -- list
npm run assetgen -- approve JOB_ID --by "reviewer"
npm run assetgen -- publish JOB_ID
```

`plan` validates the spec and prints the exact seed prompt without an API key. `generate` selects the provider from the spec output format: PNG/WebP uses GPT-6 prompt refinement and then calls the Responses API with GPT-6 Sol as the main model and the configured GPT Image generation tool; SVG uses the Space Bunny Chat Completions API to return SVG markup. The SVG route validates a safe subset of SVG and writes the vector source as a candidate; rasterization/format variants can be added as a build step later. Generated files go to ignored `assets/candidates/`; local job records are ignored while unreviewed. Ambiguous network failures become `UNKNOWN` and are not retried automatically, because a timed-out generation may still have been billed. `approve` requires a reviewer name and copies the source into `assets/source/`; it also writes the approved provenance record under `assets/provenance/approved/`. Only `publish` creates a manifest under `assets/manifests/generated/` and a release copy under `assets/releases/`.

The CLI records the spec/style/output hashes, prompt, provider/model IDs, request IDs, API usage, timestamps, status, reviewer and release path. A raster spec may provide up to four `visualReferenceImages` with repo-relative PNG, WebP, or JPEG paths and a short purpose. The OpenAI Responses request sends those local files as `input_image` data URLs alongside the final prompt; reference files are limited to 8 MB each and 12 MB total. Their paths and SHA-256 hashes are stored in the job and release manifest. The prompt must say whether references guide style only or also content/composition. Do not use an unreviewed candidate as the permanent style anchor without an explicit review decision.

`crop-avatar-sheets` requires ImageMagick 7 (`magick`) and accepts the IDs of two successful 1600x1600 WebP jobs named `avatar-sheet-female` and `avatar-sheet-male`. It crops exact 320x320 cells and writes 50 separate `REVIEW_REQUIRED` candidates, each with its own job record and a hash/coordinate link to its source sheet. The sheet-generation cost remains on the parent job; local crops are recorded as zero-API-cost derivatives.

`build-shisanshui-deck` deterministically composites the standard 52 card faces as 384x512 WebP candidates. Rank labels, suit pips and positions are code-rendered; the 12 generated court portraits appear in J/Q/K cards. `build-avif-animation` consumes a 1600x1600 transparent 4x4 motion sheet and requires ImageMagick 7 plus `avifenc`/`avifdec` from libavif. It writes one alpha-capable 16-frame, 12 fps, single-play AVIF candidate while retaining the source WebP atlas for Pixi-controlled frame playback. Both commands create review-only derivatives and are safe to rerun without duplicating completed candidates.

Cost remains `NOT_RECONCILED` until `record-cost` reconciles actual or estimated billing. The CLI never invents a generation result when credentials are absent. Raster image signatures, requested format, file size and PNG dimensions are checked; SVG candidates are restricted to an offline-safe subset before review. The reviewer still needs to inspect visual quality and policy suitability.


## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-10-10 | 按项目约束新增变更历史区块；未改动原有正文。 |
