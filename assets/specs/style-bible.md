# Gameing Hall shared art direction

Status: the external-hall style direction was accepted from the initial icon/background/cover samples. Each generated asset remains a review candidate until individually approved.

## Canonical visual anchor

- Primary reference image: `assets/aigen/icon-game-shisanshui.webp`.
- Reference use: match its polished casual-game rendering, rounded dimensional forms, teal/ivory/gold palette, soft bevel highlights, and clean premium finish. Do not copy the card fan, medallion, object layout, or exact silhouette unless an asset prompt explicitly asks for those elements.
- The generated customer-service icon may inform the shape softness of small UI icons, but it is not the global palette/material authority.

## Invariants for every generated asset

- Audience and mood: friendly, premium casual mobile game; welcoming rather than casino-like or realistic.
- Rendering: stylized 3D game illustration with rounded, softly beveled volumes; smooth enamel/resin-like surfaces; controlled glossy highlights; clear silhouettes and low-noise detail.
- Palette: deep teal/blue-green is dominant; warm ivory is the main light surface; warm gold is a restrained trim/accent. Red/black suit colors may appear only where the asset depicts playing-card suit symbols.
- Lighting: soft broad key light from upper-left, gentle fill and contact shadows; consistent warm highlights; no harsh bloom or dramatic cinematic contrast.
- Camera: near-front view for icons and covers; shallow, readable perspective for room/table environments. Keep the visual mass centered and readable at phone size.
- Layout: keep H5 title, room labels, balances and buttons out of the generated image. Preserve the asset-specific safe areas described in each spec.
- Exclusions: no photorealism, realistic landscape photography, flat vector output, watercolor, rough grain, text, letters, numerals, logos, watermarks, signatures, fake card ranks, or UI controls.
- Shared visual reference files are sent to the image-generation request as input images. Treat them as style/material/color references only; compose the requested asset independently.

## Production outputs

- Generate and review source masters first. Do not publish unreviewed candidates.
- Deterministic tooling creates size/quality variants. Static client assets are released as WebP; transparent sources may use PNG/WebP during candidate review.
- The palette, material and lighting are the shared external-hall direction. Game-specific subhalls may establish a separate visual bible while preserving a compatible rendering quality; do not silently let prompts drift within one asset pack.


## 变更历史

| 日期 | 变更 |
| --- | --- |
| 2026-10-10 | 按项目约束新增变更历史区块；未改动原有正文。 |
